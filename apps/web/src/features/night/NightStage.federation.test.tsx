import { useState } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  FEDERATION_RULES_EDITION,
  advanceSetupPhase,
  applyGameEvent,
  beginNight,
  beginRoleDraw,
  completeMafiaShots,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  resolveMafiaShots,
  skipDonCheck,
  skipSheriffCheck,
  toggleAllMafiaShotsForTarget,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState } from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { namedProfiles, renderWithProfiles } from "../../test-player-directory.js";
import { NightStage } from "./NightStage.js";

const render = (ui: Parameters<typeof renderWithProfiles>[0]) =>
  renderWithProfiles(ui, namedProfiles("night-"));
const night = () => {
  let setup = beginRoleDraw(
    createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `night-${i + 1}`, seat: i + 1 }))),
    createSeededRandom(17),
  );
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  let game = createGame(completeRoleDraw(setup), { rulesEdition: FEDERATION_RULES_EDITION });
  for (let i = 0; i < 5; i += 1) game = advanceSetupPhase(game);
  return beginNight(game);
};
const Harness = ({
  initial,
  changed,
  accepted,
}: {
  initial: GameState;
  changed: (game: GameState) => void;
  accepted: (draft: CanonicalGameEventDraft) => void;
}) => {
  const [game, setGame] = useState(initial);
  return (
    <NightStage
      game={game}
      onEvent={() => undefined}
      onGameChange={(next) => {
        setGame(next);
        changed(next);
      }}
      onAcceptedEvent={(draft) => {
        accepted(draft);
        const next = applyGameEvent(game, draft);
        setGame(next);
        changed(next);
      }}
    />
  );
};

describe("federation NightStage", () => {
  it.each(["en", "ru"] as const)(
    "records actual multiple shooting separately from target assignments in %s",
    async (locale) => {
      const user = userEvent.setup();
      const initial = night();
      const target = initial.players.find((p) => p.role === "citizen")!;
      const shooter = initial.players.find((p) => p.team === "black")!;
      const changed = vi.fn();
      const accepted = vi.fn();
      render(
        <I18nProvider locale={locale}>
          <Harness
            initial={toggleAllMafiaShotsForTarget(initial, target.seat)}
            changed={changed}
            accepted={accepted}
          />
        </I18nProvider>,
      );
      expect(
        screen.queryByText(
          locale === "en"
            ? "Call every seat: 1–10, even inactive."
            : "Назовите все номера 1–10, включая выбывших.",
        ),
      ).toBeNull();
      await user.click(
        screen.getByText(
          locale === "en" ? "Observed multiple shooting" : "Зафиксирована многократная стрельба",
        ),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(accepted).not.toHaveBeenCalled();
      const toggle = screen.getByRole("button", {
        name:
          locale === "en" ? "Observed multiple shooting" : "Зафиксирована многократная стрельба",
      });
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      const observationButton = (seat: number) =>
        screen.getByRole("button", {
          name:
            locale === "en"
              ? `Record observed shot by #${shooter.seat} at Player ${seat}`
              : `Записать наблюдаемый выстрел №${shooter.seat} в игрока Player ${seat}`,
        });
      for (let repeat = 0; repeat < 12; repeat++) await user.click(observationButton(target.seat));
      await user.click(observationButton(10));
      expect(accepted.mock.lastCall?.[0]).toEqual({
        type: "mafia.shots-observed",
        payload: {
          shotAssignments: toggleAllMafiaShotsForTarget(initial, target.seat).shotAssignments,
          observations: [{ shooterSeat: shooter.seat, targetSeat: 10 }],
        },
      });
      expect(changed.mock.lastCall?.[0].shotAssignments).toEqual(
        toggleAllMafiaShotsForTarget(initial, target.seat).shotAssignments,
      );
      expect(changed.mock.lastCall?.[0].shotObservations).toHaveLength(13);
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      await user.click(toggle);
      expect(changed.mock.lastCall?.[0].shotObservations).toHaveLength(13);
      await user.click(
        screen.getByRole("button", {
          name: locale === "en" ? "Evaluate Mafia shots" : "Определить результат выстрелов мафии",
        }),
      );
      expect(changed.mock.lastCall?.[0]).toMatchObject({
        phase: "night-mafia-result",
        nightResult: { kind: "miss" },
      });
      expect(
        changed.mock.lastCall?.[0].players.every((p: { status: string }) => p.status === "active"),
      ).toBe(true);
    },
  );

  it.each(["en", "ru"] as const)(
    "does not label an eligible first victim's Best Move as morning in %s",
    (locale) => {
      const initial = night();
      const victim = initial.players.find((p) => p.role === "citizen")!;
      const resolved = skipSheriffCheck(
        skipDonCheck(
          completeMafiaShots(
            resolveMafiaShots(toggleAllMafiaShotsForTarget(initial, victim.seat)).game,
          ),
        ),
      );
      render(
        <I18nProvider locale={locale}>
          <NightStage game={resolved} onGameChange={vi.fn()} onEvent={vi.fn()} />
        </I18nProvider>,
      );
      expect(
        screen.getByRole("button", {
          name: locale === "en" ? "Record Best Move" : "Записать лучший ход",
        }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", {
          name: locale === "en" ? "Announce morning" : "Объявить утро",
        }),
      ).toBeNull();
    },
  );

  it("does not turn split assignments into an actual-multiple-shot observation", async () => {
    const user = userEvent.setup();
    const initial = night();
    const shooters = initial.players.filter((p) => p.team === "black");
    const changed = vi.fn();
    const accepted = vi.fn();
    render(
      <Harness
        initial={{
          ...initial,
          shotAssignments: Object.fromEntries(shooters.map((p, i) => [p.seat, i + 1])),
        }}
        changed={changed}
        accepted={accepted}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Evaluate Mafia shots" }));
    expect(accepted.mock.lastCall?.[0]).toMatchObject({
      type: "mafia.shots-resolved",
      payload: { result: { kind: "miss" } },
    });
    expect(
      accepted.mock.calls.some(([draft]) => draft.type === "mafia.multiple-shot-observed"),
    ).toBe(false);
    expect(changed.mock.lastCall?.[0].actualMultipleShotSeats).toEqual([]);
  });

  it("allows every seat as a shooting target, including an already inactive player", async () => {
    const user = userEvent.setup();
    const initial = night();
    const inactive = initial.players.find((p) => p.role === "citizen")!;
    const changed = vi.fn();
    const accepted = vi.fn();
    render(
      <Harness
        initial={{
          ...initial,
          players: initial.players.map((p) =>
            p.seat === inactive.seat ? { ...p, status: "eliminated" } : p,
          ),
        }}
        changed={changed}
        accepted={accepted}
      />,
    );
    const target = screen.getByRole("button", {
      name: `Assign all Mafia shots to Player ${inactive.seat}`,
    });
    expect(target).toBeEnabled();
    await user.click(target);
    await user.click(screen.getByRole("button", { name: "Evaluate Mafia shots" }));
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      nightResult: { kind: "no-effect", targetSeat: inactive.seat },
    });
  });
});
