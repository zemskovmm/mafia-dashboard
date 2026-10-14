import { useState } from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceSetupPhase,
  beginNight,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  markPlayerInactive,
  performDonCheck,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { NightStage } from "./NightStage.js";
import { TimerControls } from "../timer/TimerControls.js";
import { namedProfiles, playerLabel, renderWithProfiles } from "../../test-player-directory.js";

const render = (ui: Parameters<typeof renderWithProfiles>[0]) =>
  renderWithProfiles(ui, namedProfiles("p-"));

afterEach(() => vi.useRealTimers());

const createNightGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `p-${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(17));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  const day = advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
  return beginNight(day);
};

const Harness = ({
  initial,
  onEvent = () => undefined,
  onGameChange = () => undefined,
}: {
  initial: GameState;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  onGameChange?: (game: GameState) => void;
}) => {
  const [game, setGame] = useState(initial);
  return (
    <NightStage
      game={game}
      onGameChange={(next) => {
        setGame(next);
        onGameChange(next);
      }}
      onEvent={onEvent}
    />
  );
};

describe("NightStage", () => {
  it.each([
    ["en", "night-don", "10s: select a player to check for Sheriff"],
    ["en", "night-sheriff", "10s: select a player to check for Mafia"],
    ["ru", "night-don", "10 с: выберите игрока для проверки на Шерифа"],
    ["ru", "night-sheriff", "10 с: выберите игрока для проверки на мафию"],
  ] as const)(
    "prompts the %s/%s ten-second window without advancing or recording timer expiry",
    (locale, phase, prompt) => {
      vi.useFakeTimers();
      const game: GameState = { ...createNightGame(), phase };
      const onGameChange = vi.fn();
      const onEvent = vi.fn();
      const onAcceptedEvent = vi.fn();
      render(
        <I18nProvider locale={locale}>
          <NightStage
            game={game}
            onGameChange={onGameChange}
            onEvent={onEvent}
            onAcceptedEvent={onAcceptedEvent}
          />
          <TimerControls />
        </I18nProvider>,
      );
      expect(screen.getByText(prompt)).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", {
          name: locale === "en" ? "Start 10 second timer" : "Запустить таймер на 10 секунд",
        }),
      );
      act(() => vi.advanceTimersByTime(10_000));
      const timerFace = screen.getByRole("button", {
        name: locale === "en" ? "Timer face" : "Циферблат таймера",
      });
      expect(timerFace).toHaveTextContent("00");
      expect(timerFace).toBeDisabled();
      expect(onGameChange).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
      expect(onAcceptedEvent).not.toHaveBeenCalled();
      expect(game.phase).toBe(phase);
      expect(screen.getByText(prompt)).toBeInTheDocument();
    },
  );

  it.each(["night-mafia", "night-don", "night-sheriff", "night-resolution"] as const)(
    "keeps role badges visible in %s with the daytime toggle on",
    (phase) => {
      const game = { ...createNightGame(), phase };
      render(
        <NightStage
          game={game}
          privacyHidden
          onGameChange={() => undefined}
          onEvent={() => undefined}
        />,
      );
      expect(document.querySelectorAll(".role-badge")).toHaveLength(10);
    },
  );
  it.each(["en", "ru"] as const)(
    "renders a numbered %s Don result and readback while preserving the player's name",
    (locale) => {
      const base = createNightGame();
      const target = base.players.find(({ role }) => role === "citizen")!;
      render(
        <I18nProvider locale={locale}>
          <NightStage
            game={performDonCheck({ ...base, phase: "night-don" }, target.seat).game}
            onGameChange={() => undefined}
            onEvent={() => undefined}
          />
        </I18nProvider>,
      );

      const result = screen.getByRole("status", {
        name: locale === "en" ? "Don check result" : "Результат проверки Дона",
      });
      const checked =
        locale === "en"
          ? `Don checked #${target.seat} · ${playerLabel(target)}`
          : `Дон проверил №${target.seat} · ${playerLabel(target)}`;
      expect(result).toHaveTextContent(checked);
      expect(result.querySelector("strong")).toHaveTextContent(checked);
      expect(result).toHaveTextContent(
        locale === "en"
          ? `Read back #${target.seat}, then show the result.`
          : `Повторите №${target.seat}, затем покажите результат.`,
      );
      expect(
        screen.getByText(locale === "en" ? "Not the Sheriff" : "Не является Шерифом"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: locale === "en" ? "Proceed to Sheriff check" : "Перейти к проверке Шерифа",
        }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    ["en", "red", "Not Mafia", "Red — thumb up."],
    ["en", "black", "Mafia found", "Black — thumb down."],
    ["ru", "red", "Не является мафией", "Красный — большой палец вверх."],
    ["ru", "black", "Мафия найдена", "Чёрный — большой палец вниз."],
  ] as const)(
    "reads back the checked seat and correct %s/%s Sheriff gesture without changing check meaning",
    async (locale, team, meaning, gesture) => {
      const user = userEvent.setup();
      const initial: GameState = { ...createNightGame(), phase: "night-sheriff" };
      const target = initial.players.find((player) => player.team === team)!;
      const onEvent = vi.fn();
      const onGameChange = vi.fn();
      render(
        <I18nProvider locale={locale}>
          <Harness initial={initial} onEvent={onEvent} onGameChange={onGameChange} />
        </I18nProvider>,
      );

      await user.click(
        screen.getByRole("button", {
          name:
            locale === "en"
              ? `Sheriff check ${playerLabel(target)}`
              : `Проверка Шерифа: ${playerLabel(target)}`,
        }),
      );
      const result = screen.getByRole("status", {
        name: locale === "en" ? "Sheriff check result" : "Результат проверки Шерифа",
      });
      const checked =
        locale === "en"
          ? `Sheriff checked #${target.seat} · ${playerLabel(target)}`
          : `Шериф проверил №${target.seat} · ${playerLabel(target)}`;
      expect(result).toHaveTextContent(checked);
      expect(result.querySelector("strong")).toHaveTextContent(checked);
      expect(result).toHaveTextContent(meaning);
      expect(result).toHaveTextContent(
        locale === "en"
          ? `Read back #${target.seat}. ${gesture}`
          : `Повторите №${target.seat}. ${gesture}`,
      );
      expect(onEvent).toHaveBeenCalledExactlyOnceWith("sheriff.checked", {
        kind: "sheriff-check",
        targetSeat: target.seat,
        match: team === "black",
        secret: true,
      });
      expect(onGameChange).toHaveBeenCalledTimes(1);
      expect(onGameChange.mock.lastCall?.[0]).toMatchObject({ phase: "night-sheriff-result" });
      expect(initial.phase).toBe("night-sheriff");
      expect(initial.checkResult).toBeUndefined();
    },
  );

  it("does not show inline Red controls during Don and Sheriff checks", () => {
    const base = createNightGame();
    const target = base.players.find(({ team }) => team === "red")!;
    const fixtures: readonly GameState[] = [
      { ...base, phase: "night-don" },
      {
        ...base,
        phase: "night-don-result",
        checkResult: { kind: "don-check", targetSeat: target.seat, match: false, secret: true },
      },
      { ...base, phase: "night-sheriff" },
      {
        ...base,
        phase: "night-sheriff-result",
        checkResult: {
          kind: "sheriff-check",
          targetSeat: target.seat,
          match: false,
          secret: true,
        },
      },
    ];

    for (const game of fixtures) {
      const { unmount } = render(
        <NightStage game={game} onGameChange={() => undefined} onEvent={() => undefined} />,
      );
      expect(screen.queryByRole("button", { name: /^Red card / })).toBeNull();
      unmount();
    }
  });

  it.each([
    ["en", "Call every seat: 1–10, even inactive."],
    ["ru", "Назовите все номера 1–10, включая выбывших."],
  ] as const)(
    "omits redundant %s shooting text while retaining all ten targets, including an inactive seat",
    (locale, prompt) => {
      const base = createNightGame();
      const inactive = base.players.find(({ role }) => role === "citizen")!;
      const game: GameState = {
        ...base,
        players: base.players.map((player) =>
          player.seat === inactive.seat ? { ...player, status: "eliminated" } : player,
        ),
      };
      const onGameChange = vi.fn();
      const onEvent = vi.fn();
      render(
        <I18nProvider locale={locale}>
          <NightStage game={game} onGameChange={onGameChange} onEvent={onEvent} />
        </I18nProvider>,
      );
      expect(screen.queryByText(prompt)).toBeNull();
      for (const player of game.players) {
        expect(
          screen.getByRole("button", {
            name:
              locale === "en"
                ? `Assign all Mafia shots to Player ${player.seat}`
                : `Назначить все выстрелы мафии в игрока Player ${player.seat}`,
          }),
        ).toBeEnabled();
      }
      expect(onGameChange).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
    },
  );

  it("uses the table with one sorted shooter button per target", async () => {
    const user = userEvent.setup();
    const initial = createNightGame();
    const shooters = initial.players
      .filter(({ team }) => team === "black")
      .sort((left, right) => left.seat - right.seat);
    const target = initial.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!;
    const otherTarget = initial.players.find(
      ({ status, seat }) => status === "active" && seat !== target.seat,
    )!;
    render(<Harness initial={initial} />);

    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    for (const shooter of shooters) {
      expect(
        screen.getByRole("button", {
          name: `Assign all Mafia shots to ${playerLabel(shooter)}`,
        }),
      ).toHaveClass("is-mafia-shooter");
    }
    const targetButtons = shooters.map((shooter) =>
      screen.getByRole("button", {
        name: `Assign shooter ${shooter.seat} to target ${playerLabel(target)}`,
      }),
    );
    expect(targetButtons.map((button) => button.textContent)).toEqual(
      shooters.map(({ seat }) => `#${seat}`),
    );

    await user.click(targetButtons[0]!);
    const selectedShot = screen.getByRole("button", {
      name: `Remove shooter ${shooters[0]!.seat} from target ${playerLabel(target)}`,
    });
    expect(selectedShot).toBeEnabled();
    expect(selectedShot).toHaveAttribute("aria-pressed", "true");

    await user.click(
      screen.getByRole("button", {
        name: `Assign shooter ${shooters[0]!.seat} to target ${playerLabel(otherTarget)}`,
      }),
    );
    expect(
      screen.getByRole("button", {
        name: `Remove shooter ${shooters[0]!.seat} from target ${playerLabel(otherTarget)}`,
      }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(
      screen.getByRole("button", {
        name: `Remove shooter ${shooters[0]!.seat} from target ${playerLabel(otherTarget)}`,
      }),
    );
    expect(
      screen.getByRole("button", {
        name: `Assign shooter ${shooters[0]!.seat} to target ${playerLabel(otherTarget)}`,
      }),
    ).toHaveAttribute("aria-pressed", "false");

    await user.click(
      screen.getByRole("button", { name: `Assign all Mafia shots to ${playerLabel(target)}` }),
    );
    expect(
      screen.getAllByRole("button", { name: new RegExp(`from target ${playerLabel(target)}$`) }),
    ).toHaveLength(shooters.length);

    await user.click(
      screen.getByRole("button", { name: `Remove all Mafia shots from ${playerLabel(target)}` }),
    );
    expect(
      screen.getAllByRole("button", { name: new RegExp(`to target ${playerLabel(target)}$`) }),
    ).toHaveLength(shooters.length);
  });

  it("allows the host to evaluate missing Mafia shots as a miss", async () => {
    const user = userEvent.setup();
    render(<Harness initial={createNightGame()} />);

    const evaluate = screen.getByRole("button", { name: /evaluate mafia shots/i });
    expect(evaluate).toBeEnabled();
    await user.click(evaluate);

    expect(screen.getByRole("group", { name: "Mafia missed" })).toHaveTextContent("No player died");
  });

  it("keeps a deciding victim alive during shot review and skips checks on host continuation", async () => {
    const user = userEvent.setup();
    let night = createNightGame();
    const red = night.players.filter(({ team }) => team === "red");
    const victim = red[3]!;
    for (const player of red.slice(0, 3)) {
      night = markPlayerInactive(night, player.seat, "eliminated");
    }
    const onGameChange = vi.fn<(game: GameState) => void>();
    render(<Harness initial={night} onGameChange={onGameChange} />);
    await user.click(
      screen.getByRole("button", {
        name: `Assign all Mafia shots to ${playerLabel(victim)}`,
      }),
    );
    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    expect(onGameChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "night-mafia-result",
        winner: null,
      }),
    );
    expect(
      onGameChange.mock.lastCall?.[0].players.find(({ seat }) => seat === victim.seat)?.status,
    ).toBe("active");
    await user.click(screen.getByRole("button", { name: "Continue night" }));
    const finished = onGameChange.mock.lastCall?.[0];
    expect(finished).toMatchObject({
      phase: "finished",
      winner: "black",
      nightResult: { kind: "kill", targetSeat: victim.seat },
    });
    expect(finished?.players.find(({ seat }) => seat === victim.seat)?.status).toBe("eliminated");
    expect(finished?.bestMove).toBeUndefined();
    expect(finished?.goodbyeSeats).toBeUndefined();
    expect(
      screen.queryByRole("button", { name: /don check|sheriff check|best move|goodbye/i }),
    ).toBeNull();
  });

  it("allows every remaining shot to target a deceased player and reports no effect", async () => {
    const user = userEvent.setup();
    const base = createNightGame();
    const deceased = base.players.find(({ team }) => team === "red")!;
    const initial: GameState = {
      ...base,
      players: base.players.map((player) =>
        player.seat === deceased.seat ? { ...player, status: "eliminated" } : player,
      ),
    };
    render(<Harness initial={initial} />);

    await user.click(
      screen.getByRole("button", {
        name: new RegExp(`^Assign all Mafia shots to ${playerLabel(deceased)}$`),
      }),
    );
    expect(
      screen.getAllByRole("button", { name: new RegExp(`from target ${playerLabel(deceased)}$`) }),
    ).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    expect(screen.getByRole("status", { name: "Mafia shots had no effect" })).toHaveTextContent(
      `${playerLabel(deceased)} was already out`,
    );
    expect(
      screen.getByRole("button", { name: `Seat ${deceased.seat}: ${playerLabel(deceased)}` }),
    ).toHaveClass("status-eliminated");
  });

  it("shows the Mafia shot result again on the final Night screen", () => {
    const base = createNightGame();
    const target = base.players.find(({ team }) => team === "red")!;
    const { rerender } = render(
      <Harness initial={{ ...base, phase: "night-resolution", nightResult: { kind: "miss" } }} />,
    );

    expect(screen.getByRole("group", { name: "Mafia missed" })).toHaveTextContent("No player died");
    expect(screen.getByRole("button", { name: /begin day 2/i })).toBeInTheDocument();

    rerender(
      <Harness
        key="kill"
        initial={{
          ...base,
          phase: "night-resolution",
          players: base.players.map((player) =>
            player.seat === target.seat ? { ...player, status: "eliminated" } : player,
          ),
          nightResult: { kind: "kill", targetSeat: target.seat },
        }}
      />,
    );
    expect(screen.getByRole("group", { name: "Deceased player" })).toHaveTextContent(
      playerLabel(target),
    );
  });

  it("keeps check targets undimmed and permits checks on deceased players", async () => {
    const user = userEvent.setup();
    const base = createNightGame();
    const deceased = base.players.find(({ role }) => role === "citizen")!;
    const initial: GameState = {
      ...base,
      phase: "night-don",
      players: base.players.map((player) =>
        player.seat === deceased.seat ? { ...player, status: "eliminated" } : player,
      ),
    };
    const { container } = render(<Harness initial={initial} />);

    expect(container.querySelectorAll(".player-seat.is-dimmed")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: `Don check ${playerLabel(deceased)}` }));
    expect(screen.getByText("Not the Sheriff")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `Sheriff check ${playerLabel(deceased)}` }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: /proceed to sheriff check/i }));
    expect(container.querySelectorAll(".player-seat.is-dimmed")).toHaveLength(0);
    await user.click(
      screen.getByRole("button", { name: `Sheriff check ${playerLabel(deceased)}` }),
    );
    expect(screen.getByText("Not Mafia")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue night" }));
    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    expect(screen.getByText("Night complete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /begin day 2/i })).toBeInTheDocument();
  });

  it("offers both checks after Mafia shots when both owners died before this night", async () => {
    const user = userEvent.setup();
    const base = createNightGame();
    const don = base.players.find(({ role }) => role === "don")!;
    const sheriff = base.players.find(({ role }) => role === "sheriff")!;
    const initial = beginNight({
      ...markPlayerInactive(
        markPlayerInactive(base, don.seat, "eliminated"),
        sheriff.seat,
        "eliminated",
      ),
      phase: "day",
      day: 3,
    });
    const onEvent = vi.fn();
    const { unmount } = render(<Harness initial={initial} onEvent={onEvent} />);

    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    await user.click(screen.getByRole("button", { name: "Continue night" }));
    expect(screen.getByRole("button", { name: `Don check ${playerLabel(don)}` })).toHaveClass(
      "status-eliminated",
    );
    await user.click(screen.getByRole("button", { name: `Don check ${playerLabel(sheriff)}` }));
    expect(screen.getByRole("status", { name: "Don check result" })).toHaveTextContent(
      "Sheriff found",
    );
    expect(onEvent).toHaveBeenLastCalledWith(
      "don.checked",
      expect.objectContaining({ targetSeat: sheriff.seat, match: true, secret: true }),
    );
    await user.click(screen.getByRole("button", { name: "Proceed to Sheriff check" }));
    expect(screen.queryByText("Sheriff found")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Sheriff check ${playerLabel(sheriff)}` }),
    ).toHaveClass("status-eliminated");
    await user.click(screen.getByRole("button", { name: `Sheriff check ${playerLabel(don)}` }));
    expect(screen.getByRole("status", { name: "Sheriff check result" })).toHaveTextContent(
      "Mafia found",
    );
    expect(onEvent).toHaveBeenLastCalledWith(
      "sheriff.checked",
      expect.objectContaining({ targetSeat: don.seat, match: true, secret: true }),
    );
    await user.click(screen.getByRole("button", { name: "Continue night" }));
    expect(screen.getByRole("button", { name: "Begin day 4" })).toBeEnabled();
    unmount();

    render(<Harness initial={initial} onEvent={onEvent} />);
    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    await user.click(screen.getByRole("button", { name: "Continue night" }));
    await user.click(screen.getByRole("button", { name: "Skip Don check" }));
    expect(onEvent).toHaveBeenLastCalledWith("don.check-skipped", { day: 3 });
    await user.click(screen.getByRole("button", { name: "Skip Sheriff check" }));
    expect(onEvent).toHaveBeenLastCalledWith("sheriff.check-skipped", { day: 3 });
    expect(screen.getByRole("button", { name: "Begin day 4" })).toBeEnabled();
  });

  it("keeps both same-night deceased owners' checks interactive", async () => {
    const user = userEvent.setup();
    const base = createNightGame();
    const onEvent = vi.fn();
    const target = base.players.find(({ role }) => role === "citizen")!;
    const don = base.players.find(({ role }) => role === "don")!;
    const sheriff = base.players.find(({ role }) => role === "sheriff")!;
    const initial: GameState = {
      ...base,
      phase: "night-don",
      players: base.players.map((player) =>
        player.role === "don" || player.role === "sheriff"
          ? { ...player, status: "eliminated" }
          : player,
      ),
    };
    render(<Harness initial={initial} onEvent={onEvent} />);

    expect(screen.getByRole("button", { name: `Don check ${playerLabel(target)}` })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Skip Don check" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /red card|foul/i })).toBeNull();
    expect(screen.getByRole("button", { name: `Don check ${playerLabel(don)}` })).toHaveClass(
      "status-eliminated",
      "is-night-check-highlight",
    );
    await user.click(screen.getByRole("button", { name: `Don check ${playerLabel(target)}` }));
    expect(screen.getByText("Not the Sheriff")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Seat ${don.seat}: ${playerLabel(don)}` }),
    ).not.toHaveClass("is-night-check-highlight");
    await user.click(screen.getByRole("button", { name: /proceed to sheriff check/i }));

    expect(
      screen.getByRole("button", { name: `Sheriff check ${playerLabel(target)}` }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Skip Sheriff check" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: `Sheriff check ${playerLabel(sheriff)}` }),
    ).toHaveClass("status-eliminated", "is-night-check-highlight");
    await user.click(screen.getByRole("button", { name: `Sheriff check ${playerLabel(target)}` }));
    expect(screen.getByText("Not Mafia")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Seat ${sheriff.seat}: ${playerLabel(sheriff)}` }),
    ).not.toHaveClass("is-night-check-highlight");
  });

  it("logs Mafia moves only when shots are evaluated", async () => {
    const user = userEvent.setup();
    const initial = createNightGame();
    const shooters = initial.players
      .filter(({ team }) => team === "black")
      .sort((left, right) => left.seat - right.seat);
    const target = initial.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!;
    const onEvent = vi.fn();
    render(<Harness initial={initial} onEvent={onEvent} />);

    const assignAll = async () => {
      for (const shooter of shooters) {
        await user.click(
          screen.getByRole("button", {
            name: `Assign shooter ${shooter.seat} to target ${playerLabel(target)}`,
          }),
        );
      }
    };

    await assignAll();
    expect(onEvent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    expect(screen.getByRole("group", { name: "Deceased player" })).toHaveTextContent(
      playerLabel(target),
    );
    expect(
      screen.getByRole("button", { name: `Seat ${target.seat}: ${playerLabel(target)}` }),
    ).toHaveClass("is-provisional-deceased");
    expect(onEvent.mock.calls.filter(([type]) => type === "mafia.shot-recorded")).toHaveLength(0);
    expect(onEvent.mock.calls.filter(([type]) => type === "mafia.shots-resolved")).toHaveLength(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      "mafia.shots-resolved",
      expect.objectContaining({
        shots: expect.arrayContaining(
          shooters.map(({ seat }) =>
            expect.objectContaining({ shooterSeat: seat, targetSeat: target.seat }),
          ),
        ),
      }),
    );

    expect(screen.queryByRole("button", { name: /re-evaluate mafia shots/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: /continue night/i }));

    expect(onEvent.mock.calls.filter(([type]) => type === "mafia.shot-recorded")).toHaveLength(0);
    expect(onEvent.mock.calls.filter(([type]) => type === "mafia.shots-resolved")).toHaveLength(1);
    expect(screen.getByText("Don check")).toBeInTheDocument();
  });

  it("continues Don, Sheriff, and next-day stages after confirmed shots", async () => {
    const user = userEvent.setup();
    const initial = createNightGame();
    const shooters = initial.players.filter(({ team }) => team === "black");
    const target = initial.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!;
    const sheriff = initial.players.find(({ role }) => role === "sheriff")!;
    const mafia = initial.players.find(({ role }) => role === "mafia")!;
    render(<Harness initial={initial} />);

    for (const shooter of shooters) {
      await user.click(
        screen.getByRole("button", {
          name: `Assign shooter ${shooter.seat} to target ${playerLabel(target)}`,
        }),
      );
    }

    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    await user.click(screen.getByRole("button", { name: /continue night/i }));
    expect(screen.getByText("Don check")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: new RegExp(`don check ${playerLabel(sheriff)}`, "i") }),
    );
    expect(screen.getByText(/sheriff found/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /proceed to sheriff check/i }));

    expect(screen.getByText("Sheriff check")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: new RegExp(`sheriff check ${playerLabel(mafia)}`, "i") }),
    );
    expect(screen.getByText(/mafia found/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue night" }));
    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /red card/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /begin day 2/i }));
    expect(screen.getByRole("heading", { name: /night complete/i })).toBeInTheDocument();
  });
});
