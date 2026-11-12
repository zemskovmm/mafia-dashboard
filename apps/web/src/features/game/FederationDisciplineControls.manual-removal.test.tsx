import { useState } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  advanceOpeningPhase,
  applyGameEvent,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  type CanonicalGameEventDraft,
  type GameState,
} from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { namedProfiles, renderWithProfiles } from "../../test-player-directory.js";
import { GameScreen } from "./GameScreen.js";
import { FederationDisciplineControls } from "./FederationDisciplineControls.js";

const day = (): GameState => {
  let setup = beginRoleDraw(
    createSetup(
      Array.from({ length: 10 }, (_, index) => ({ id: `player-${index + 1}`, seat: index + 1 })),
    ),
    createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return advanceOpeningPhase(advanceOpeningPhase(createGame(completeRoleDraw(setup))));
};
const render = (ui: Parameters<typeof renderWithProfiles>[0]) =>
  renderWithProfiles(ui, namedProfiles("player-"));
const openPenalty = (seat: number, view: "table" | "ledger" = "table") => {
  if (view === "ledger") {
    fireEvent.click(document.querySelector(`[data-ledger-seat="${seat}"] .ledger-penalty-button`)!);
    return;
  }
  const card = document.querySelector<HTMLElement>(`[data-seat="${seat}"] .player-seat`)!;
  fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 180 }] });
  fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
};

const Harness = ({
  initial,
  accepted,
  changed,
  view,
}: {
  initial: GameState;
  accepted: (draft: CanonicalGameEventDraft) => void;
  changed: (game: GameState) => void;
  view: "table" | "ledger";
}) => {
  const [game, setGame] = useState(initial);
  return (
    <GameScreen
      game={game}
      hostView={view}

      hostName="Host"
      privacyHidden
      onGameChange={setGame}
      onEvent={vi.fn()}
      onAcceptedEvent={(draft) => {
        const next = applyGameEvent(game, draft);
        accepted(draft);
        changed(next);
        setGame(next);
        return next;
      }}
    />
  );
};

const reasons = [
  ["voted-out", "Voted out"],
  ["mafia-kill", "Killed by Mafia"],
  ["other", "Other"],
] as const;

describe("non-disciplinary manual-removal fallback", () => {
  for (const view of ["table", "ledger"] as const) {
    it.each(reasons)(
      "records %s without a rule, penalty or farewell in " + view,
      async (reason) => {
        const user = userEvent.setup();
        const initial = day();
        const accepted = vi.fn();
        const changed = vi.fn();
        render(<Harness initial={initial} view={view} accepted={accepted} changed={changed} />);
        openPenalty(2, view);
        const dialog = within(screen.getByRole("dialog"));
        await user.selectOptions(dialog.getByLabelText("Discipline action"), "manual-removal");
        expect(dialog.queryByLabelText("Removal rule")).toBeNull();
        expect(dialog.queryByLabelText("Occurrence timing")).toBeNull();
        expect(dialog.queryByLabelText("Discipline reason (optional)")).toBeNull();
        const picker = dialog.getByLabelText("Removal reason");
        expect(
          within(picker)
            .getAllByRole("option")
            .map((option) => option.textContent),
        ).toEqual(["Choose a reason", ...reasons.map(([, label]) => label)]);
        expect(dialog.getByRole("button", { name: "Remove player" })).toBeDisabled();
        expect(accepted).not.toHaveBeenCalled();
        await user.selectOptions(picker, reason);
        await user.click(dialog.getByRole("button", { name: "Remove player" }));
        expect(accepted).toHaveBeenCalledExactlyOnceWith({
          type: "player.manually-removed",
          payload: { seat: 2, reason },
        });
        const next: GameState = changed.mock.lastCall![0];
        expect(next.phase).toBe("day");
        expect(next.players.find((player) => player.seat === 2)).toEqual({
          ...initial.players.find((player) => player.seat === 2),
          status: "eliminated",
        });
        expect(next).toMatchObject({ manualRemovals: [{ seat: 2, reason }] });
        expect(next.goodbyeSeats).toBeUndefined();
        expect(next.disciplinaryRemovals).toBeUndefined();
        expect(next.ballotCancellationDay).toBeUndefined();
        expect(next.redCardIssuedThisDay).toBeUndefined();
      },
    );
  }

  it("offers the same separate action through the player swipe shortcut", async () => {
    const user = userEvent.setup();
    const accepted = vi.fn();
    const initial = day();
    render(
      <GameScreen
        game={initial}
        hostName="Host"
        privacyHidden
        onGameChange={vi.fn()}
        onEvent={vi.fn()}
        onAcceptedEvent={accepted}
      />,
    );
    openPenalty(4);
    const dialog = within(screen.getByRole("dialog"));
    await user.selectOptions(dialog.getByLabelText("Discipline action"), "manual-removal");
    await user.selectOptions(dialog.getByLabelText("Removal reason"), "other");
    await user.click(dialog.getByRole("button", { name: "Remove player" }));
    expect(accepted).toHaveBeenCalledExactlyOnceWith({
      type: "player.manually-removed",
      payload: { seat: 4, reason: "other" },
    });
  });

  it("keeps disqualification's rule requirement separate when switching actions", async () => {
    const user = userEvent.setup();
    const accepted = vi.fn();
    render(<Harness initial={day()} view="table" accepted={accepted} changed={vi.fn()} />);
    openPenalty(2);
    const dialog = within(screen.getByRole("dialog"));
    const action = dialog.getByLabelText("Discipline action");
    await user.selectOptions(action, "manual-removal");
    await user.selectOptions(dialog.getByLabelText("Removal reason"), "voted-out");
    await user.selectOptions(action, "removal");
    expect(dialog.queryByLabelText("Removal reason")).toBeNull();
    expect(dialog.getByLabelText("Removal rule")).toHaveValue("");
    expect(dialog.getByRole("button", { name: "Confirm discipline" })).toBeDisabled();
    expect(accepted).not.toHaveBeenCalled();
  });

  it("localizes the distinct three-reason action and confirmation in Russian", async () => {
    const user = userEvent.setup();
    const accepted = vi.fn();
    render(
      <I18nProvider locale="ru">
        <Harness initial={day()} view="ledger" accepted={accepted} changed={vi.fn()} />
      </I18nProvider>,
    );
    openPenalty(1, "ledger");
    const dialog = within(screen.getByRole("dialog"));
    await user.selectOptions(dialog.getByLabelText("Дисциплинарное действие"), "manual-removal");
    expect(dialog.getByRole("option", { name: "Вывести из игры вручную" })).toBeInTheDocument();
    expect(
      within(dialog.getByLabelText("Причина выведения"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Выберите причину", "Выведен голосованием", "Убит мафией", "Другое"]);
    await user.selectOptions(dialog.getByLabelText("Причина выведения"), "other");
    await user.click(dialog.getByRole("button", { name: "Вывести игрока" }));
    expect(accepted).toHaveBeenCalledExactlyOnceWith({
      type: "player.manually-removed",
      payload: { seat: 1, reason: "other" },
    });
  });

  it("does not submit a stale player request or an action hidden by the rules reader", async () => {
    const user = userEvent.setup();
    const initial = day();
    const accepted = vi.fn();
    const request = { id: 1, seat: 2, action: "removal" as const, game: initial, shortcut: true };
    const props = {
      game: initial,
      request,
      onAcceptedEvent: accepted,
      onEvent: vi.fn(),
      onGameChange: vi.fn(),
    };
    const { rerender } = render(<FederationDisciplineControls {...props} />);
    const dialog = within(screen.getByRole("dialog"));
    await user.selectOptions(dialog.getByLabelText("Discipline action"), "manual-removal");
    await user.selectOptions(dialog.getByLabelText("Removal reason"), "other");
    const form = dialog.getByRole("button", { name: "Remove player" }).closest("form")!;
    rerender(<FederationDisciplineControls {...props} readerOpen />);
    fireEvent.submit(form);
    expect(accepted).not.toHaveBeenCalled();
    rerender(<FederationDisciplineControls {...props} game={{ ...initial, day: 2 }} />);
    fireEvent.submit(form);
    expect(accepted).not.toHaveBeenCalled();
  });
});
