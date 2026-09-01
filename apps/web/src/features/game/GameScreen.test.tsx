import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  advanceSetupPhase,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { GameScreen } from "./GameScreen.js";

const createPlanningGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(13));
  for (let seat = 1; seat <= 10; seat += 1) {
    setup = drawRoleForSeat(setup, seat);
  }
  return createGame(completeRoleDraw(setup));
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
  const [game, setGame] = useState(() =>
    advanceSetupPhase(advanceSetupPhase(createPlanningGame())),
  );
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

describe("GameScreen", () => {
  it("renders the live day controls in Russian", () => {
    const day = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));

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

    expect(screen.getByRole("heading", { name: `День ${day.day}` })).toBeInTheDocument();
    expect(screen.getByText(/Стол «Мафия»/)).toBeInTheDocument();
    expect(screen.getByText("Текущий игрок")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Следующий игрок" })).toBeInTheDocument();
  });

  it("shows Critical under active team counts in every critical live phase, even when masked", () => {
    const day = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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
    expect(screen.getByRole("status", { name: "Critical" })).toBeInTheDocument();

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
        game={day}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );
    expect(screen.queryByRole("status", { name: "Critical" })).toBeNull();
  });

  it("keeps a static table tint in sync with Day and night", () => {
    const day = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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

  it("shows the selected host at the table", () => {
    render(<Harness onEvent={() => undefined} />);
    expect(screen.getByText("Host Player")).toBeInTheDocument();
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
      screen.getByRole("heading", { name: /night zero · mafia free seating/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /seat \d+: player/i })).toHaveLength(10);
    expect(screen.getByRole("group", { name: /host: host player/i })).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /continue night zero to sheriff wake-up/i }),
    );

    expect(
      screen.getByRole("heading", { name: /night zero · sheriff wake-up/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /begin day one/i }));

    expect(screen.getByRole("heading", { name: /day 1/i })).toBeInTheDocument();
    expect(screen.getByText(/current turn: player 1/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /seat 1: player 1/i })).toHaveAttribute(
      "aria-current",
      "step",
    );

    expect(screen.queryByRole("button", { name: /start player 1 turn/i })).not.toBeInTheDocument();
    expect(onEvent).not.toHaveBeenCalledWith("turn.started", expect.anything());
  });

  it("offers a swipe red card for an active player during a Don check", async () => {
    const user = userEvent.setup();
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    const game: GameState = { ...base, phase: "night-don" };
    const target = game.players.find(({ role }) => role === "citizen")!;
    const onGameChange = vi.fn<(next: GameState) => void>();
    render(
      <GameScreen
        game={game}
        hostName="Host Player"
        onGameChange={onGameChange}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );
    const card = screen.getByRole("button", {
      name: `Don check ${target.name}`,
    });

    fireEvent.touchStart(card, { touches: [{ clientX: 20, clientY: 50 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ clientX: 82, clientY: 52 }] });
    await user.click(screen.getByRole("button", { name: `Red card ${target.name}` }));

    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({
        players: expect.arrayContaining([
          expect.objectContaining({ seat: target.seat, status: "red-carded" }),
        ]),
      }),
    );
  });

  it("closes the keyboard red-card menu with Escape", () => {
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    const game: GameState = { ...base, phase: "night-don" };
    const target = game.players.find(({ role }) => role === "citizen")!;
    render(
      <GameScreen
        game={game}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );
    const card = screen.getByRole("button", { name: `Don check ${target.name}` });
    card.focus();
    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    const redCard = screen.getByRole("button", { name: `Red card ${target.name}` });
    expect(redCard).toHaveFocus();

    fireEvent.keyDown(redCard, { key: "Escape" });

    expect(screen.queryByRole("button", { name: `Red card ${target.name}` })).toBeNull();
    expect(card).toHaveFocus();
  });

  it("supplies live phase and turn context with an accepted swipe red card", async () => {
    const user = userEvent.setup();
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    const game: GameState = { ...base, phase: "night-don", currentTurnIndex: 4 };
    const target = game.players.find(({ role }) => role === "citizen")!;
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
    const card = screen.getByRole("button", { name: `Don check ${target.name}` });

    fireEvent.touchStart(card, { touches: [{ clientX: 20, clientY: 50 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ clientX: 82, clientY: 52 }] });
    await user.click(screen.getByRole("button", { name: `Red card ${target.name}` }));

    expect(onAcceptedEvent).toHaveBeenCalledWith({
      type: "player.red-carded",
      payload: {
        seat: target.seat,
        phase: "night-don",
        currentTurnIndex: 4,
      },
    });
  });

  it("removes and disables swipe red-card actions at night resolution", () => {
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    const target = base.players.find(({ role }) => role === "citizen")!;
    const props = {
      hostName: "Host Player",
      onGameChange: () => undefined,
      onEvent: () => undefined,
      privacyHidden: false,
    };
    const { rerender } = render(<GameScreen {...props} game={{ ...base, phase: "night-don" }} />);
    const checkCard = screen.getByRole("button", { name: `Don check ${target.name}` });
    fireEvent.touchStart(checkCard, { touches: [{ clientX: 20, clientY: 50 }] });
    fireEvent.touchEnd(checkCard, { changedTouches: [{ clientX: 82, clientY: 52 }] });
    expect(screen.getByRole("button", { name: `Red card ${target.name}` })).toBeInTheDocument();

    rerender(<GameScreen {...props} game={{ ...base, phase: "night-resolution" }} />);
    expect(
      screen.queryByRole("button", { name: `Red card ${target.name}` }),
    ).not.toBeInTheDocument();

    const resolutionCard = screen.getByRole("button", {
      name: `Seat ${target.seat}: ${target.name}`,
    });
    fireEvent.touchStart(resolutionCard, { touches: [{ clientX: 20, clientY: 50 }] });
    fireEvent.touchEnd(resolutionCard, { changedTouches: [{ clientX: 82, clientY: 52 }] });
    expect(
      screen.queryByRole("button", { name: `Red card ${target.name}` }),
    ).not.toBeInTheDocument();
  });

  it("locks every nomination button after the current speaker nominates", async () => {
    const user = userEvent.setup();
    render(<DayHarness />);

    expect(screen.queryByRole("button", { name: /^red card player/i })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^nominate player 1$/i }).parentElement?.children,
    ).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^nominate player 1$/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /^nominate player 2$/i }));
    expect(
      screen
        .getAllByRole("button", { name: /nominate player/i })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: /next player/i }));
    expect(screen.getByRole("button", { name: /nominate player 3/i })).toBeEnabled();
  });

  it("supplies live phase and turn context with an accepted foul checkpoint", async () => {
    const user = userEvent.setup();
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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

    await user.click(screen.getByRole("button", { name: `Foul ${target.name}` }));

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
  });

  it("presents each car-crash nominee with a 30-second turn", () => {
    const game: GameState = {
      ...advanceSetupPhase(advanceSetupPhase(createPlanningGame())),
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
    expect(screen.getByText(/car crash turn: player 4/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /start player 4 30-second turn/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next nominee/i })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: /^foul player/i })).toHaveLength(10);
    expect(screen.getByRole("button", { name: /^seat 1: player 1$/i })).toHaveClass("is-inactive");
    expect(screen.getByRole("button", { name: /^seat 4: player 4$/i })).not.toHaveClass(
      "is-inactive",
    );
  });

  it("does not bypass an unresolved all-player car-crash decision", () => {
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    const activeSeats = base.players
      .filter(({ status }) => status === "active")
      .map(({ seat }) => seat);
    const game: GameState = {
      ...base,
      phase: "car-crash-decision",
      carCrashSeats: activeSeats,
      carCrashVotes: {},
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

    expect(screen.getByRole("heading", { name: "Car crash" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Car-crash decision" })).toBeInTheDocument();
    expect(screen.queryByText("Eliminate-all vote skipped")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Begin night" })).not.toBeInTheDocument();
  });

  it("keeps a red-card cancellation on the voting screen until night is confirmed", async () => {
    const user = userEvent.setup();
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    const initial: GameState = {
      ...base,
      phase: "voting-cancelled",
      nominations: [{ nominatorSeat: 1, candidateSeat: 4, order: 1 }],
      turnOrder: [4],
      currentTurnIndex: 0,
      votingCancellation: { reason: "red-card" },
    };
    const CancellationHarness = () => {
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
    render(<CancellationHarness />);

    expect(screen.getByRole("heading", { name: "Voting" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Voting cancelled" })).toHaveTextContent(
      "A player received a red card",
    );
    await user.click(screen.getByRole("button", { name: "Begin night" }));
    expect(screen.getByRole("heading", { name: "Mafia shots" })).toBeInTheDocument();
  });

  it("shows working Foul controls during voting", async () => {
    const user = userEvent.setup();
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    const game: GameState = {
      ...base,
      day: 2,
      phase: "voting",
      nominations: [{ nominatorSeat: 1, candidateSeat: 4, order: 1 }],
      turnOrder: [4],
      currentTurnIndex: 0,
      voteAssignments: {},
      votingRound: "initial",
    };
    const onGameChange = vi.fn<(next: GameState) => void>();
    const onEvent = vi.fn<(type: string, payload: Record<string, unknown>) => void>();
    render(
      <GameScreen
        game={game}
        hostName="Host Player"
        onGameChange={onGameChange}
        onEvent={onEvent}
        privacyHidden={false}
      />,
    );

    expect(screen.getAllByRole("button", { name: /^foul player/i })).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: "Foul Player 1" }));

    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({
        players: expect.arrayContaining([expect.objectContaining({ seat: 1, fouls: 1 })]),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith("foul.issued", { seat: 1 });
  });

  it("skips voting for one nominee on day one", async () => {
    const user = userEvent.setup();
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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

    expect(screen.getByText("Final turn: Player 10 · Night next")).toBeInTheDocument();
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
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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

    expect(screen.getByText("Final turn: Player 10 · Night next")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Begin voting" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Begin night" }));
    expect(screen.getByRole("heading", { name: "Mafia shots" })).toBeInTheDocument();
  });

  it("keeps a single nominee in later-day voting and shows a yellow goodbye speech", async () => {
    const user = userEvent.setup();
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    const initial: GameState = {
      ...base,
      day: 2,
      phase: "voting",
      nominations: [{ nominatorSeat: 1, candidateSeat: 4, order: 1 }],
      turnOrder: [4],
      currentTurnIndex: 0,
      voteAssignments: Object.fromEntries(base.players.map(({ seat }) => [seat, 4])),
      votingRound: "initial",
    };
    const GoodbyeHarness = () => {
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
    render(<GoodbyeHarness />);

    await user.click(screen.getByRole("button", { name: /resolve voting/i }));
    expect(screen.getByRole("heading", { name: "Goodbye speech" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /seat 4: player 4/i })).toHaveClass(
      "is-voting-highlight",
    );
    expect(document.querySelectorAll(".player-seat.is-voting-highlight")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Begin night" }));
    expect(screen.getByRole("heading", { name: "Mafia shots" })).toBeInTheDocument();
  });

  it("eliminates every nominee approved by the car-crash ballot", async () => {
    const user = userEvent.setup();
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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
    expect(screen.getAllByRole("button", { name: /^Foul Player/i })).toHaveLength(10);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Goodbye speech" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Seat 4: Player 4" })).toHaveClass(
      "status-eliminated",
    );
    expect(screen.getByRole("button", { name: "Seat 6: Player 6" })).toHaveClass(
      "status-eliminated",
    );
  });

  it("does not present an inactive restored current speaker as the active turn", () => {
    const dayGame = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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

  it("records a three-player Best move before starting day two", async () => {
    const user = userEvent.setup();
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    const victim = base.players.find(({ team }) => team === "red")!;
    const initial: GameState = {
      ...base,
      day: 2,
      phase: "best-move",
      players: base.players.map((player) =>
        player.seat === victim.seat ? { ...player, status: "eliminated" } : player,
      ),
      bestMove: { playerSeat: victim.seat, selectedSeats: [] },
      goodbyeSeats: [victim.seat],
      goodbyeNext: "day",
    };
    const BestMoveHarness = () => {
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
    render(<BestMoveHarness />);
    const victimCard = screen.getByRole("button", { name: `Seat ${victim.seat}: ${victim.name}` });
    expect(victimCard).toHaveClass("is-voting-highlight");
    expect(victimCard).toBeDisabled();
    const targets = initial.players
      .filter(({ status, seat }) => status === "active" && seat !== victim.seat)
      .slice(0, 3);
    for (const target of targets) {
      await user.click(screen.getByRole("button", { name: `Add ${target.name} to Best move` }));
    }
    await user.click(screen.getByRole("button", { name: "Save Best move" }));

    expect(screen.getByRole("heading", { name: "Goodbye speech" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Seat ${victim.seat}: ${victim.name}` })).toHaveClass(
      "is-voting-highlight",
    );
    await user.click(screen.getByRole("button", { name: "Begin day 2" }));
    expect(screen.getByRole("heading", { name: "Day 2" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Seat ${victim.seat}: ${victim.name}` }),
    ).not.toHaveClass("is-voting-highlight");
  });

  it("highlights only the current goodbye speaker when an earlier Best move is retained", () => {
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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
      screen.getByRole("button", { name: `Seat ${currentVictim!.seat}: ${currentVictim!.name}` }),
    ).toHaveClass("is-voting-highlight");
    expect(
      screen.getByRole("button", { name: `Seat ${earlierVictim!.seat}: ${earlierVictim!.name}` }),
    ).not.toHaveClass("is-voting-highlight");
    expect(
      screen.getByRole("button", { name: `Seat ${queuedVictim!.seat}: ${queuedVictim!.name}` }),
    ).not.toHaveClass("is-voting-highlight");
    expect(document.querySelectorAll(".player-seat.is-voting-highlight")).toHaveLength(1);
  });

  it("renders a historical state with only Exit and Reset actions", async () => {
    const user = userEvent.setup();
    const onExitPreview = vi.fn();
    const onResetPreview = vi.fn();
    const day = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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
    const day = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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
    const day = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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

  it("shows a locally durable completion while the server is offline", () => {
    const day = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
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
  ] as const)("renders a terminal %s state without winner persistence controls", (phase, label) => {
    const day = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    render(
      <GameScreen
        game={{ ...day, phase, winner: null }}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(label);
    expect(screen.queryByRole("button", { name: "Finish the game" })).toBeNull();
  });
});
