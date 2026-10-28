import { swipeCard } from "../../test-card-gestures.js";
import { useState } from "react";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  advanceOpeningPhase,
  startVoting,
  issueFoul,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  beginNight,
  toggleAllMafiaShotsForTarget,
  resolveMafiaShots,
  completeMafiaShots,
  skipDonCheck,
  skipSheriffCheck,
  completeNight,
  completeGoodbyeSpeech,
  completeEliminations,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { GameScreen } from "./GameScreen.js";
import { expectServerAcceptsEvent } from "../../test-game-event-contract.js";
import { namedProfiles, playerLabel, renderWithProfiles } from "../../test-player-directory.js";
import { PlayerCardStyleContext } from "../theme/PlayerCardStyleContext.js";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";

const render = (ui: Parameters<typeof renderWithProfiles>[0]) =>
  renderWithProfiles(ui, namedProfiles("player-"));

const createPlanningGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(13));
  for (let seat = 1; seat <= 10; seat += 1) {
    setup = drawRoleForSeat(setup, seat);
  }
  return createGame(completeRoleDraw(setup));
};

const createDayGame = (): GameState => {
  let game = createPlanningGame();
  while (game.phase !== "day") game = advanceOpeningPhase(game);
  return game;
};

const Harness = ({
  onEvent,
}: {
  onEvent: (type: string, payload: Record<string, unknown>) => void;
}) => {
  const [game, setGame] = useState(createPlanningGame);
  return (
    <GameScreen
      game={game}
      hostName="Host Player"
      onGameChange={setGame}
      onEvent={onEvent}
      privacyHidden={false}
    />
  );
};

const DayHarness = () => {
  const [game, setGame] = useState(() => createDayGame());
  return (
    <>
      <output hidden data-testid="day-nominations">
        {JSON.stringify(game.nominations)}
      </output>
      <GameScreen
        game={game}
        hostName="Host Player"
        onGameChange={setGame}
        onEvent={() => undefined}
        privacyHidden={false}
      />
    </>
  );
};

describe("GameScreen", () => {
  it.each([false, true])(
    "turns the actual pre-departure printed side after the provider's delayed request (privacy: %s)",
    (privacyHidden) => {
      const animate = vi.fn(() => ({ finished: new Promise(() => {}), cancel: vi.fn() }));
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        value: animate,
      });
      try {
        const day = createDayGame();
        const victim = day.players.find((player) => player.role === "citizen")!;
        const goodbye = completeEliminations(day, [victim.seat]);
        const tree = (game: GameState) => (
          <FancyFeaturesContext.Provider value={true}>
            <PlayerCardStyleContext.Provider value={{ style: "classic", rolePlacement: "below" }}>
              <GameScreen
                game={game}
                privacyHidden={privacyHidden}
                hostName="Host"
                onGameChange={() => undefined}
                onEvent={() => undefined}
              />
            </PlayerCardStyleContext.Provider>
          </FancyFeaturesContext.Provider>
        );
        const { container, rerender, unmount } = render(tree(goodbye));
        rerender(tree(completeGoodbyeSpeech(goodbye)));
        const card = container.querySelector(
          `.seat-anchor[data-seat="${victim.seat}"] .player-seat`,
        )!;
        expect(animate).toHaveBeenCalledTimes(4);
        expect(
          card.querySelector(".printed-player-card__outgoing .printed-player-card__art") !== null,
        ).toBe(!privacyHidden);
        expect(
          card.querySelector(".printed-player-card__outgoing .printed-player-card__back-art") !==
            null,
        ).toBe(privacyHidden);
        expect(
          card.querySelector(".printed-player-card__current .printed-player-card__back-art"),
        ).not.toBeNull();
        expect(card.querySelector(".printed-player-card__role")).toBeNull();
        unmount();
      } finally {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, "animate", descriptor);
        else Reflect.deleteProperty(HTMLElement.prototype, "animate");
      }
    },
  );

  it("holds printed faces through private night and pending goodbye, then preserves privacy and restored state", () => {
    const day = { ...createDayGame(), bestMoveEnabled: false };
    const victim = day.players.find((player) => player.role === "citizen")!;
    const night = beginNight(day);
    const result = resolveMafiaShots(toggleAllMafiaShotsForTarget(night, victim.seat)).game;
    const applied = completeMafiaShots(result);
    const afterDon = applied.phase === "night-don" ? skipDonCheck(applied) : applied;
    const afterSheriff = afterDon.phase === "night-sheriff" ? skipSheriffCheck(afterDon) : afterDon;
    const goodbye = completeNight(afterSheriff);
    expect(goodbye.phase).toBe("goodbye-speech");
    const departed = completeGoodbyeSpeech(goodbye);
    const tree = (game: GameState, privacyHidden: boolean, mode: "live" | "preview" = "live") => (
      <FancyFeaturesContext.Provider value={false}>
        <PlayerCardStyleContext.Provider value={{ style: "classic", rolePlacement: "below" }}>
          <GameScreen
            game={game}
            privacyHidden={privacyHidden}
            mode={mode}
            hostName="Host"
            onGameChange={() => undefined}
            onEvent={() => undefined}
          />
        </PlayerCardStyleContext.Provider>
      </FancyFeaturesContext.Provider>
    );
    const { container, rerender } = render(tree(night, true));
    const card = () =>
      container.querySelector(`.seat-anchor[data-seat="${victim.seat}"] .player-seat`)!;
    const faceUrl = card().querySelector("img")?.getAttribute("src");
    for (const game of [night, result, applied, afterDon, afterSheriff]) {
      rerender(tree(game, true));
      expect(card(), game.phase).toHaveAttribute("data-card-face", "front");
      expect(card().querySelector("img")).toHaveAttribute("src", faceUrl);
    }
    rerender(tree(goodbye, false));
    expect(card()).toHaveAttribute("data-card-face", "front");
    rerender(tree(goodbye, false, "preview"));
    expect(card()).toHaveAttribute("data-card-face", "front");
    rerender(tree(goodbye, true));
    expect(card()).toHaveAttribute("data-card-face", "back");
    rerender(tree(goodbye, false));
    expect(card()).toHaveAttribute("data-card-face", "front");
    rerender(tree(departed, false));
    expect(card()).toHaveAttribute("data-card-face", "back");
    expect(card().querySelector(".deceased-cross")).toBeNull();
    rerender(tree(departed, true));
    rerender(tree(departed, false));
    expect(card()).toHaveAttribute("data-card-face", "back");
    rerender(tree(day, true));
    expect(card()).toHaveAttribute("data-card-face", "back");
    rerender(tree(day, false));
    expect(card()).toHaveAttribute("data-card-face", "front");
    expect(card().querySelector("img")).toHaveAttribute("src", faceUrl);
  });

  it.each([["sheriff-identification", "Begin round zero"]] as const)(
    "highlights only the active Sheriff during %s and conceals the cue on entering day",
    async (phase, nextAction) => {
      const user = userEvent.setup();
      const planning = createPlanningGame();
      const game: GameState = { ...planning, phase };
      const sheriff = game.players.find(({ role }) => role === "sheriff")!;
      const snapshot = JSON.stringify(game);
      const onGameChange = vi.fn();
      const onEvent = vi.fn();
      const props = { hostName: "Host", onGameChange, onEvent };
      const { container, rerender } = render(
        <GameScreen {...props} game={planning} privacyHidden />,
      );
      expect(container.querySelector(".is-sheriff-highlight")).toBeNull();
      rerender(<GameScreen {...props} game={game} privacyHidden />);
      const card = screen.getByRole("button", {
        name: `Seat ${sheriff.seat}: ${playerLabel(sheriff)}`,
      });
      expect(card).toHaveClass("is-sheriff-highlight");
      expect(card.querySelector(".vgpu-player-lighting")).not.toBeNull();
      expect(card.querySelector('.player-role-icon[role="img"]')).toHaveAttribute(
        "aria-label",
        "sheriff",
      );
      expect(container.querySelectorAll(".is-sheriff-highlight")).toHaveLength(1);
      expect(container.querySelector(".game-shell")).toHaveClass("is-table-cycle-night");
      rerender(<GameScreen {...props} game={game} privacyHidden={false} />);
      expect(card).toHaveClass("is-sheriff-highlight");
      for (const status of ["eliminated", "red-carded"] as const) {
        rerender(
          <GameScreen
            {...props}
            game={{
              ...game,
              players: game.players.map((player) =>
                player.seat === sheriff.seat ? { ...player, status } : player,
              ),
            }}
            privacyHidden
          />,
        );
        expect(container.querySelector(".is-sheriff-highlight")).toBeNull();
      }
      expect(JSON.stringify(game)).toBe(snapshot);
      expect(onGameChange).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
      rerender(<GameScreen {...props} game={game} privacyHidden />);
      await user.click(screen.getByRole("button", { name: nextAction }));
      const day = advanceOpeningPhase(game);
      expect(onGameChange).toHaveBeenCalledExactlyOnceWith(day);
      expect(onEvent).toHaveBeenCalledExactlyOnceWith("phase.changed", { from: phase, to: "day" });
      rerender(<GameScreen {...props} game={day} privacyHidden />);
      expect(container.querySelector(".game-shell")).toHaveClass("is-table-cycle-day");
      expect(container.querySelector(".is-sheriff-highlight")).toBeNull();
      expect(container.querySelector('.player-role-icon[role="img"]')).toBeNull();
    },
  );

  it("renders the live day controls in Russian", () => {
    const day = createDayGame();

    render(
      <I18nProvider locale="ru">
        <GameScreen
          game={day}
          hostName="Host Player"
          onGameChange={() => undefined}
          onEvent={() => undefined}
          privacyHidden={false}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Нулевой круг" })).toBeInTheDocument();
    expect(screen.getByText(/Стол «Мафия»/)).toBeInTheDocument();
    expect(screen.getByText("Текущий игрок")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Следующий игрок" })).toBeInTheDocument();
    expect(screen.getAllByTitle("Смахните вниз, чтобы выдать фол")).toHaveLength(10);
  });

  it("keeps the phase title and table controls without a repeated phase banner in live and preview states", () => {
    const planning = createPlanningGame();
    const day = createDayGame();
    const props = {
      hostName: "Host Player",
      onGameChange: () => undefined,
      onEvent: () => undefined,
      privacyHidden: false,
    };
    const { rerender, container } = render(<GameScreen {...props} game={planning} />);

    expect(
      screen.getByRole("heading", { level: 1, name: /Night one · Mafia agreement/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mafia asleep/i })).toBeInTheDocument();
    expect(container.querySelector(".table-check-center")).toHaveTextContent(
      "60 seconds · Mafia agrees on the target order.",
    );
    expect(container.querySelector(".table-check-center .table-prompt")).toBeNull();
    expect(container.querySelector(".game-shell .phase-banner")).toBeNull();

    rerender(<GameScreen {...props} game={{ ...planning, phase: "sheriff-identification" }} />);
    expect(
      screen.getByRole("heading", { level: 1, name: /Night one · Sheriff greeting/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Begin round zero/i })).toBeInTheDocument();
    expect(container.querySelector(".table-check-center")).toHaveTextContent(
      "Wake the Sheriff. Give them 10 seconds to look around the table and greet the host.",
    );
    expect(container.querySelector(".table-check-center .table-prompt")).toBeNull();
    expect(container.querySelector(".game-shell .phase-banner")).toBeNull();

    rerender(<GameScreen {...props} game={day} />);
    expect(screen.getByRole("heading", { level: 1, name: /Zero round/i })).toBeInTheDocument();
    expect(screen.getByText("Current speaker")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next player/i })).toBeInTheDocument();
    expect(container.querySelector(".game-shell .phase-banner")).toBeNull();

    rerender(<GameScreen {...props} game={{ ...day, phase: "night-mafia" }} />);
    expect(screen.getByRole("heading", { level: 1, name: /mafia shots/i })).toBeInTheDocument();
    expect(container.querySelector(".game-shell .phase-banner")).toBeNull();

    rerender(
      <GameScreen
        {...props}
        game={{
          ...day,
          phase: "voting",
          nominations: [{ nominatorSeat: 1, candidateSeat: 4, order: 1 }],
          turnOrder: [4],
          currentTurnIndex: 0,
          votingRound: "initial",
        }}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: /voting/i })).toBeInTheDocument();
    expect(container.querySelector(".game-shell .phase-banner")).toBeNull();

    rerender(<GameScreen {...props} game={planning} mode="preview" previewSequence={1} />);
    expect(
      screen.getByRole("heading", { level: 1, name: /Night one.*Preview/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /preview controls/i })).toBeInTheDocument();
    expect(container.querySelector(".game-shell .phase-banner")).toBeNull();
  });

  it("shows Critical only when private information is revealed, including at night", () => {
    const day = createDayGame();
    let citizens = 0;
    let mafia = 0;
    const critical: GameState = {
      ...day,
      players: day.players.map((player) => {
        const active = player.team === "red" ? citizens++ < 4 : mafia++ < 3;
        return { ...player, status: active ? "active" : "eliminated" };
      }),
    };
    const { rerender } = render(
      <GameScreen
        game={critical}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );

    const counts = screen.getByLabelText("4 active citizens and 3 active Mafia");
    expect(screen.getByRole("status", { name: "Critical" })).toBeInTheDocument();
    expect(counts).toContainElement(screen.getByRole("status", { name: "Critical" }));

    rerender(
      <GameScreen
        game={critical}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden
      />,
    );
    expect(screen.queryByRole("status", { name: "Critical" })).toBeNull();

    rerender(
      <GameScreen
        game={{ ...critical, phase: "night-mafia" }}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden
      />,
    );
    expect(screen.getByRole("status", { name: "Critical" })).toBeInTheDocument();
    rerender(
      <GameScreen
        game={{ ...critical, phase: "night-mafia" }}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );
    expect(screen.getByRole("status", { name: "Critical" })).toBeInTheDocument();

    rerender(
      <GameScreen
        game={day}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );
    expect(screen.queryByRole("status", { name: "Critical" })).toBeNull();
  });

  it.each(["en", "ru"] as const)(
    "renders one localized, privacy-safe endgame pill and clean header in %s",
    (locale) => {
      const day = createDayGame();
      let red = 0;
      let black = 0;
      const guessing: GameState = {
        ...day,
        players: day.players.map((player) => ({
          ...player,
          status: (player.team === "red" ? red++ < 2 : black++ < 1) ? "active" : "eliminated",
        })),
      };
      const label = locale === "en" ? "Guessing Game" : "угадайка";
      const renderGame = (game: GameState, privacyHidden: boolean, preview = false) => (
        <I18nProvider locale={locale}>
          <GameScreen
            game={game}
            gameName="Fixture game"
            clubName="Fixture club"
            hostName="Host"
            onGameChange={() => undefined}
            onEvent={() => undefined}
            privacyHidden={privacyHidden}
            mode={preview ? "preview" : "live"}
          />
        </I18nProvider>
      );
      const { rerender, container } = render(renderGame(guessing, false));
      expect(screen.getByRole("status", { name: label })).toBeInTheDocument();
      expect(container.querySelectorAll(".critical-state-pill")).toHaveLength(1);
      const header = container.querySelector(".game-header .eyebrow");
      expect(header).toHaveTextContent("Fixture club · Fixture game");
      expect(header?.textContent).not.toMatch(/host view|панель ведущего|режим ведущего|·\s*$/i);
      rerender(renderGame(guessing, true));
      expect(container.querySelector(".critical-state-pill")).toBeNull();
      rerender(renderGame({ ...guessing, phase: "night-mafia" }, false));
      expect(screen.getByRole("status", { name: label })).toBeInTheDocument();
      rerender(renderGame(guessing, false, true));
      expect(screen.getByRole("status", { name: label })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /Preview|Просмотр/i })).toBeInTheDocument();
      rerender(renderGame(day, true));
      rerender(renderGame(day, false));
      expect(container.querySelector(".critical-state-pill")).toBeNull();
    },
  );

  it("masks displayed day phases and previews, but never night, without mutating game state", () => {
    const day = createDayGame();
    const snapshot = JSON.stringify(day);
    const onGameChange = vi.fn();
    const onEvent = vi.fn();
    const props = { hostName: "Host", onGameChange, onEvent };
    const { container, rerender } = render(<GameScreen {...props} game={day} privacyHidden />);
    const inspect = (masked: boolean) => {
      expect(container.querySelectorAll('.player-role-icon[role="img"]')).toHaveLength(
        masked ? 0 : 10,
      );
      expect(container.querySelector(".team-counts")).toHaveAttribute(
        "aria-label",
        masked ? "Active team counts hidden" : "7 active citizens and 3 active Mafia",
      );
      expect(JSON.stringify(day)).toBe(snapshot);
    };
    inspect(true);
    for (const phase of [
      "voting",
      "voting-cancelled",
      "car-crash",
      "car-crash-decision",
      "car-crash-result",
      "car-crash-skipped",
      "goodbye-speech",
    ] as const) {
      rerender(<GameScreen {...props} game={{ ...day, phase }} privacyHidden mode="preview" />);
      inspect(true);
    }
    for (const phase of [
      "mafia-planning",
      "sheriff-identification",
      "night-mafia",
      "night-don",
      "night-sheriff",
      "night-resolution",
    ] as const) {
      rerender(<GameScreen {...props} game={{ ...day, phase }} privacyHidden mode="preview" />);
      inspect(false);
    }
    rerender(<GameScreen {...props} game={day} privacyHidden={false} mode="preview" />);
    inspect(false);
    expect(onGameChange).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("keeps a static table tint in sync with Day and night", () => {
    const day = createDayGame();
    const { rerender } = render(
      <GameScreen
        game={day}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );

    expect(document.querySelector(".game-shell")).toHaveClass("is-table-cycle-day");
    expect(screen.queryByRole("status", { name: /table indication/i })).toBeNull();

    rerender(
      <GameScreen
        game={{ ...day, phase: "night-mafia" }}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );

    expect(document.querySelector(".game-shell")).toHaveClass("is-table-cycle-night");
    expect(screen.queryByRole("status", { name: /table indication/i })).toBeNull();
  });

  it("does not advertise player context actions while discipline is unavailable", () => {
    render(<Harness onEvent={() => undefined} />);

    expect(screen.getByRole("button", { name: "Seat 1: Player 1" })).not.toHaveAttribute(
      "aria-haspopup",
    );
  });

  it("signals setup phases and enters the rotating first day", async () => {
    const user = userEvent.setup();
    const onEvent = vi.fn<(type: string, payload: Record<string, unknown>) => void>();
    render(<Harness onEvent={onEvent} />);

    expect(
      screen.getByRole("heading", { name: /Night one · Mafia agreement/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /seat \d+: player/i })).toHaveLength(10);

    await user.click(screen.getByRole("button", { name: /Mafia asleep/i }));

    expect(
      screen.getByRole("heading", { name: /Night one · Sheriff greeting/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Begin round zero/i }));

    expect(screen.getByRole("heading", { name: /Zero round/i })).toBeInTheDocument();
    expect(screen.getByText("Current speaker").nextElementSibling).toHaveTextContent("Player 1");
    expect(screen.getByRole("button", { name: "Nominate Player 1" })).toHaveAttribute(
      "aria-current",
      "step",
    );

    expect(screen.queryByRole("button", { name: /start player 1 turn/i })).not.toBeInTheDocument();
    expect(onEvent).not.toHaveBeenCalledWith("turn.started", expect.anything());
  });

  it("uses whole cards for one reversible nomination and independent supports without disabling fouls", async () => {
    const user = userEvent.setup();
    render(<DayHarness />);
    const card = (seat: number) =>
      document.querySelector<HTMLButtonElement>(
        `.seat-anchor[data-seat="${seat}"] > .player-seat`,
      )!;
    const nominations = () => JSON.parse(screen.getByTestId("day-nominations").textContent!);
    expect(document.querySelector(".seat-actions button")).toBeNull();
    await user.click(card(7));
    expect(nominations()).toEqual([{ nominatorSeat: 1, candidateSeat: 7, order: 1 }]);
    await user.click(card(8));
    expect(nominations()).toHaveLength(1);
    swipeCard(card(8), 0, 70);
    expect(screen.getByRole("img", { name: "Foul ×1" })).toBeInTheDocument();
    await user.click(card(7));
    expect(nominations()).toEqual([]);
    await user.click(card(7));
    await user.click(screen.getByRole("button", { name: "Next player" }));
    expect(card(7)).toHaveAttribute("aria-pressed", "false");
    await user.click(card(7));
    await user.click(card(7));
    expect(nominations()).toEqual([{ nominatorSeat: 1, candidateSeat: 7, order: 1 }]);
    await user.click(card(7));
    await user.click(card(8));
    await user.click(screen.getByRole("button", { name: "Next player" }));
    for (const seat of [7, 8, 9]) await user.click(card(seat));
    await user.click(card(8));
    await user.click(card(8));
    const expected = [
      { nominatorSeat: 1, candidateSeat: 7, order: 1, supporterSeats: [2, 3] },
      { nominatorSeat: 2, candidateSeat: 8, order: 2, supporterSeats: [3] },
      { nominatorSeat: 3, candidateSeat: 9, order: 3 },
    ];
    expect(nominations()).toEqual(expected);
    for (const seat of [7, 8, 9]) expect(card(seat)).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Next player" }));
    for (const seat of [7, 8, 9]) expect(card(seat)).toHaveAttribute("aria-pressed", "false");
    expect(nominations()).toEqual(expected);
  });

  it("supplies live phase and turn context with an accepted foul checkpoint", async () => {
    const base = createDayGame();
    const game: GameState = { ...base, currentTurnIndex: 2 };
    const target = game.players.find(({ status }) => status === "active")!;
    const onAcceptedEvent = vi.fn();
    render(
      <GameScreen
        game={game}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        onAcceptedEvent={onAcceptedEvent}
        privacyHidden={false}
      />,
    );

    const card = document.querySelector<HTMLButtonElement>(
      `.seat-anchor[data-seat="${target.seat}"] > .player-seat`,
    )!;
    expect(card).not.toHaveAttribute("aria-keyshortcuts");
    expect(screen.queryByRole("button", { name: /^Foul / })).toBeNull();
    fireEvent.touchStart(card, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ clientX: 100, clientY: 170 }] });
    fireEvent.click(card);

    expect(onAcceptedEvent).toHaveBeenCalledWith({
      type: "foul.issued",
      payload: {
        seat: target.seat,
        foulNumber: 1,
        redCarded: false,
        phase: "day",
        currentTurnIndex: 2,
      },
    });
    expect(onAcceptedEvent).toHaveBeenCalledTimes(1);
    await expectServerAcceptsEvent(game, onAcceptedEvent.mock.calls[0]![0]);
  });

  it("presents each car-crash nominee with a 30-second turn", () => {
    const game: GameState = {
      ...createDayGame(),
      phase: "car-crash",
      turnOrder: [4, 6],
      currentTurnIndex: 0,
      carCrashSeats: [4, 6],
      votingRound: "repeat",
    };

    render(
      <GameScreen
        game={game}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );

    expect(screen.getByRole("heading", { name: /car crash/i })).toBeInTheDocument();
    expect(screen.getByText("Car crash speech").nextElementSibling).toHaveTextContent("Player 4");
    expect(
      screen.queryByRole("button", { name: /start player 4 30-second turn/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next nominee/i })).toBeEnabled();
    expect(screen.getAllByTitle("Swipe down to issue a foul")).toHaveLength(10);
    expect(screen.getByRole("button", { name: /^seat 1: player 1$/i })).toHaveClass("is-inactive");
    expect(screen.getByRole("button", { name: /^seat 4: player 4$/i })).not.toHaveClass(
      "is-inactive",
    );
  });

  it.each([
    ["day", {}],
    [
      "voting",
      {
        nominations: [{ nominatorSeat: 1, candidateSeat: 4, order: 1 }],
        turnOrder: [4],
        votingRound: "initial",
      },
    ],
    ["voting-cancelled", { votingCancellation: { reason: "red-card" } }],
    ["car-crash", { carCrashSeats: [4, 6], turnOrder: [4, 6], votingRound: "repeat" }],
    ["car-crash-decision", { carCrashSeats: [4, 6], carCrashVotes: {} }],
    [
      "car-crash-result",
      { carCrashResult: { eliminate: false, seats: [4, 6], yesVotes: 5, eligibleVoters: 10 } },
    ],
    ["car-crash-skipped", { carCrashSeats: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
    ["goodbye-speech", { goodbyeSeats: [4], goodbyeNext: "night" }],
  ] satisfies readonly (readonly [GameState["phase"], Partial<GameState>])[])(
    "offers card foul gestures throughout day-play phase %s",
    (phase, state) => {
      const base = createDayGame();
      render(
        <GameScreen
          game={
            phase === "voting"
              ? startVoting({
                  ...base,
                  day: 2,
                  nominations: [
                    { nominatorSeat: 1, candidateSeat: 4, order: 1 },
                    { nominatorSeat: 2, candidateSeat: 6, order: 2 },
                  ],
                })
              : { ...base, ...state, phase }
          }
          hostName="Host Player"
          onGameChange={() => undefined}
          onEvent={() => undefined}
          privacyHidden={false}
        />,
      );

      expect(screen.getAllByTitle("Swipe down to issue a foul")).toHaveLength(10);
      expect(screen.queryByRole("button", { name: /^Foul Player/i })).toBeNull();
    },
  );

  it.each([
    ["mafia-planning", {}],
    ["sheriff-identification", {}],
    ["best-move", { bestMove: { playerSeat: 1, selectedSeats: [] } }],
    ["night-mafia", {}],
    ["night-mafia-result", { nightResult: { kind: "miss" } }],
    ["night-don", {}],
    [
      "night-don-result",
      { checkResult: { kind: "don-check", targetSeat: 1, match: false, secret: true } },
    ],
    ["night-sheriff", {}],
    [
      "night-sheriff-result",
      { checkResult: { kind: "sheriff-check", targetSeat: 1, match: false, secret: true } },
    ],
    ["night-resolution", { nightResult: { kind: "miss" } }],
    ["finished", { winner: "red" }],
    ["draw", {}],
    ["cancelled", {}],
  ] satisfies readonly (readonly [GameState["phase"], Partial<GameState>])[])(
    "disables card foul gestures outside day-play phase %s",
    (phase, state) => {
      const base = createDayGame();
      render(
        <GameScreen
          game={{ ...base, ...state, phase }}
          hostName="Host Player"
          onGameChange={() => undefined}
          onEvent={() => undefined}
          privacyHidden={false}
        />,
      );

      expect(screen.queryByRole("button", { name: /^Foul Player/i })).toBeNull();
      expect(screen.queryByTitle("Swipe down to issue a foul")).toBeNull();
    },
  );

  it("applies a third foul during the current ballot without recording a vote", () => {
    let game = createDayGame();
    game = issueFoul(issueFoul(game, 1), 1);
    game = startVoting({
      ...game,
      day: 2,
      nominations: [
        { nominatorSeat: 1, candidateSeat: 4, order: 1 },
        { nominatorSeat: 2, candidateSeat: 6, order: 2 },
      ],
    });
    const onGameChange = vi.fn();
    render(
      <GameScreen
        game={game}
        hostName="Host"
        onGameChange={onGameChange}
        onEvent={vi.fn()}
        privacyHidden={false}
      />,
    );
    swipeCard(document.querySelector('.seat-anchor[data-seat="1"] > .player-seat')!, 0, 70);
    const next = onGameChange.mock.calls[0]![0];
    expect(next.players.find((p: { seat: number }) => p.seat === 1)).toMatchObject({
      fouls: 3,
      status: "active",
      mutePending: true,
    });
    expect(next.voteAssignments).toEqual(game.voteAssignments);
    expect(next.phase).toBe("voting");
  });

  it("skips voting for one nominee on day one", async () => {
    const user = userEvent.setup();
    const base = createDayGame();
    const initial: GameState = {
      ...base,
      nominations: [{ nominatorSeat: 1, candidateSeat: 4, order: 1 }],
      currentTurnIndex: base.turnOrder.length - 1,
    };
    const DayOneHarness = () => {
      const [game, setGame] = useState(initial);
      return (
        <GameScreen
          game={game}
          hostName="Host Player"
          onGameChange={setGame}
          onEvent={() => undefined}
          privacyHidden={false}
        />
      );
    };
    render(<DayOneHarness />);

    expect(screen.getByText("Current speaker").nextElementSibling).toHaveTextContent("Player 10");
    await user.click(screen.getByRole("button", { name: "Begin night" }));

    expect(screen.getByRole("heading", { name: "Mafia shots" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Voting" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve voting" })).not.toBeInTheDocument();
    const nominee = screen.getByRole("button", {
      name: "Assign all Mafia shots to Player 4",
    });
    expect(nominee).not.toHaveClass("is-inactive");
    expect(nominee).toHaveClass("status-active");
  });

  it("ignores inactive nominations in day-one final-turn controls", async () => {
    const user = userEvent.setup();
    const base = createDayGame();
    const initial: GameState = {
      ...base,
      players: base.players.map((player) =>
        player.seat === 6 ? { ...player, status: "eliminated" as const } : player,
      ),
      nominations: [
        { nominatorSeat: 1, candidateSeat: 4, order: 1 },
        { nominatorSeat: 2, candidateSeat: 6, order: 2 },
      ],
      currentTurnIndex: base.turnOrder.length - 1,
    };
    const InactiveNomineeHarness = () => {
      const [game, setGame] = useState(initial);
      return (
        <GameScreen
          game={game}
          hostName="Host Player"
          onGameChange={setGame}
          onEvent={() => undefined}
          privacyHidden={false}
        />
      );
    };
    render(<InactiveNomineeHarness />);

    expect(screen.getByText("Current speaker").nextElementSibling).toHaveTextContent("Player 10");
    expect(screen.queryByRole("button", { name: "Begin voting" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Begin night" }));
    expect(screen.getByRole("heading", { name: "Mafia shots" })).toBeInTheDocument();
  });

  it("eliminates every nominee approved by the car-crash ballot", async () => {
    const user = userEvent.setup();
    const base = createDayGame();
    const game: GameState = {
      ...base,
      phase: "car-crash-decision",
      carCrashSeats: [4, 6],
      carCrashVotes: Object.fromEntries(base.players.map(({ seat }) => [seat, true])),
    };
    const CarCrashHarness = () => {
      const [current, setCurrent] = useState(game);
      return (
        <GameScreen
          game={current}
          hostName="Host Player"
          onGameChange={setCurrent}
          onEvent={() => undefined}
          privacyHidden={false}
        />
      );
    };
    render(<CarCrashHarness />);
    await user.click(screen.getByRole("button", { name: /resolve car crash/i }));

    expect(screen.getByRole("heading", { name: "Car crash result" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Car-crash result" })).toHaveTextContent(
      "Eliminated",
    );
    expect(screen.getByRole("button", { name: "Seat 4: Player 4" })).toHaveClass(
      "is-provisional-deceased",
    );
    expect(screen.getByRole("button", { name: "Seat 6: Player 6" })).toHaveClass(
      "is-provisional-deceased",
    );
    expect(screen.getAllByTitle("Swipe down to issue a foul")).toHaveLength(10);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Goodbye speech" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Seat 4: Player 4" })).toHaveClass(
      "status-eliminated",
    );
    expect(screen.getByRole("button", { name: "Seat 6: Player 6" })).toHaveClass(
      "status-eliminated",
    );
    expect(screen.getAllByTitle("Swipe down to issue a foul")).toHaveLength(8);
  });

  it("does not present an inactive restored current speaker as the active turn", () => {
    const dayGame = createDayGame();
    const restored = {
      ...dayGame,
      players: dayGame.players.map((player) =>
        player.seat === 1 ? { ...player, status: "red-carded" as const } : player,
      ),
    };

    render(
      <GameScreen
        game={restored}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );

    expect(screen.queryByText(/current turn:/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start player 1 turn/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /seat 1: player 1/i })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("highlights only the current goodbye speaker when an earlier Best move is retained", () => {
    const base = createDayGame();
    const [earlierVictim, currentVictim, queuedVictim] = base.players.filter(
      ({ team }) => team === "red",
    );
    const game: GameState = {
      ...base,
      day: 5,
      phase: "goodbye-speech",
      players: base.players.map((player) =>
        [earlierVictim!.seat, currentVictim!.seat, queuedVictim!.seat].includes(player.seat)
          ? { ...player, status: "eliminated" }
          : player,
      ),
      bestMove: { playerSeat: earlierVictim!.seat, selectedSeats: [], mafiaHits: 0 },
      goodbyeSeats: [currentVictim!.seat, queuedVictim!.seat],
      goodbyeNext: "day",
    };

    render(
      <GameScreen
        game={game}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: `Seat ${currentVictim!.seat}: ${playerLabel(currentVictim!)}`,
      }),
    ).toHaveClass("is-voting-highlight");
    expect(
      screen.getByRole("button", {
        name: `Seat ${earlierVictim!.seat}: ${playerLabel(earlierVictim!)}`,
      }),
    ).not.toHaveClass("is-voting-highlight");
    expect(
      screen.getByRole("button", {
        name: `Seat ${queuedVictim!.seat}: ${playerLabel(queuedVictim!)}`,
      }),
    ).not.toHaveClass("is-voting-highlight");
    expect(document.querySelectorAll(".player-seat.is-voting-highlight")).toHaveLength(1);
  });

  it("renders a historical state with only Exit and Reset actions", async () => {
    const user = userEvent.setup();
    const onExitPreview = vi.fn();
    const onResetPreview = vi.fn();
    const day = createDayGame();
    render(
      <GameScreen
        game={day}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
        mode="preview"
        previewSequence={7}
        onExitPreview={onExitPreview}
        onResetPreview={onResetPreview}
      />,
    );

    const actions = screen
      .getAllByRole("button")
      .filter((button) => !button.hasAttribute("disabled"));
    expect(actions.map((button) => button.textContent?.trim())).toEqual([
      "Exit preview",
      "Reset game to this state",
    ]);
    expect(screen.queryByRole("button", { name: /foul|nominate|next player/i })).toBeNull();
    expect(screen.queryByText("Timer")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Exit preview" }));
    await user.click(screen.getByRole("button", { name: "Reset game to this state" }));
    expect(onExitPreview).toHaveBeenCalledOnce();
    expect(onResetPreview).toHaveBeenCalledOnce();
  });

  it("disables Reset in preview after Finish game has been clicked", () => {
    const day = createDayGame();
    render(
      <GameScreen
        game={day}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
        mode="preview"
        previewSequence={7}
        canResetPreview={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Reset game to this state" })).toBeDisabled();
  });

  it("ignores the legacy Happy-day field, shows team counts, and finishes the winning game", async () => {
    const user = userEvent.setup();
    const onFinishGame = vi.fn();
    const day = createDayGame();
    const { rerender } = render(
      <GameScreen
        game={{ ...day, dayNotice: "happy" }}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
        onFinishGame={onFinishGame}
      />,
    );
    expect(screen.queryByText("Happy day")).toBeNull();
    expect(screen.getByLabelText(/active citizens and 3 active Mafia/i)).toBeInTheDocument();

    rerender(
      <GameScreen
        game={{ ...day, phase: "finished", winner: "red" }}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
        onFinishGame={onFinishGame}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Citizens won");
    await user.click(screen.getByRole("button", { name: "Finish the game" }));
    expect(onFinishGame).toHaveBeenCalledTimes(1);
  });

  it.each(["finished", "draw", "cancelled"] as const)(
    "distinguishes a rejected %s save from an offline save",
    (phase) => {
      const day = createDayGame();
      render(
        <GameScreen
          game={{ ...day, phase, winner: phase === "finished" ? "red" : null }}
          hostName="Host Player"
          onGameChange={() => undefined}
          onEvent={() => undefined}
          privacyHidden={false}
          finishGameState="blocked"
        />,
      );

      expect(screen.getByRole("status")).toHaveTextContent(
        "Game saved on this device · upload rejected. See Console for details.",
      );
      expect(screen.queryByText(/reconnect to upload|Game safely saved/)).toBeNull();
      expect(screen.getByRole("button", { name: "Game upload blocked" })).toBeDisabled();
    },
  );

  it("shows a locally durable completion while the server is offline", () => {
    const day = createDayGame();
    render(
      <GameScreen
        game={{ ...day, phase: "finished", winner: "red" }}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
        finishGameState="queued"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Game saved on this device · reconnect to upload",
    );
    expect(screen.getByRole("button", { name: "Game saved offline" })).toBeDisabled();
  });

  it.each([
    ["draw", "Game drawn"],
    ["cancelled", "Game cancelled"],
  ] as const)(
    "renders a saved terminal %s state with the finalized Finish control",
    (phase, label) => {
      const day = createDayGame();
      render(
        <GameScreen
          game={{ ...day, phase, winner: null }}
          hostName="Host Player"
          onGameChange={() => undefined}
          onEvent={() => undefined}
          privacyHidden={false}
          finishGameState="saved"
        />,
      );

      expect(screen.getByRole("status")).toHaveTextContent(label);
      expect(screen.getByRole("status")).toHaveTextContent("Game safely saved");
      expect(screen.getByRole("button", { name: "Game safely saved" })).toBeDisabled();
    },
  );
  it.each(["draw", "cancelled"] as const)(
    "offers Finish for a pending %s ruling",
    async (phase) => {
      const user = userEvent.setup();
      const onFinishGame = vi.fn();
      const day = createDayGame();
      render(
        <GameScreen
          game={{ ...day, phase, winner: null }}
          hostName="Host Player"
          onGameChange={() => undefined}
          onEvent={() => undefined}
          privacyHidden={false}
          onFinishGame={onFinishGame}
        />,
      );
      await user.click(screen.getByRole("button", { name: "Finish the game" }));
      expect(onFinishGame).toHaveBeenCalledOnce();
    },
  );
});
