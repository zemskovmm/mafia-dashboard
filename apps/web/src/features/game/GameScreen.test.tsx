import { useState } from "react";
import { render, screen } from "@testing-library/react";
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
  it("shows the selected host at the table", () => {
    render(<Harness onEvent={() => undefined} />);
    expect(screen.getByText("Host Player")).toBeInTheDocument();
  });

  it("signals setup phases and enters the rotating first day", async () => {
    const user = userEvent.setup();
    const onEvent = vi.fn<(type: string, payload: Record<string, unknown>) => void>();
    render(<Harness onEvent={onEvent} />);

    expect(screen.getByRole("heading", { name: /mafia planning stage/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /seat \d+: player/i })).toHaveLength(10);
    expect(screen.getByRole("group", { name: /host: host player/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /continue to sheriff wake-up/i }));

    expect(screen.getByRole("heading", { name: /sheriff wake-up/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /begin day one/i }));

    expect(screen.getByRole("heading", { name: /day 1/i })).toBeInTheDocument();
    expect(screen.getByText(/current turn: player 1/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /seat 1: player 1/i })).toHaveAttribute(
      "aria-current",
      "step",
    );

    await user.click(screen.getByRole("button", { name: /start player 1 turn/i }));
    expect(onEvent).not.toHaveBeenCalledWith("turn.started", expect.anything());
  });

  it("locks every nomination button after the current speaker nominates", async () => {
    const user = userEvent.setup();
    render(<DayHarness />);

    expect(screen.getByRole("button", { name: /^nominate player 1$/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^nominate player 2$/i }));
    expect(
      screen
        .getAllByRole("button", { name: /nominate player/i })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: /next player/i }));
    expect(screen.getByRole("button", { name: /nominate player 3/i })).toBeEnabled();
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
    expect(screen.getByRole("button", { name: /start player 4 30-second turn/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /next nominee/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^seat 1: player 1$/i })).toHaveClass("is-inactive");
    expect(screen.getByRole("button", { name: /^seat 4: player 4$/i })).not.toHaveClass(
      "is-inactive",
    );
  });

  it("keeps a single nominee in voting and shows a yellow goodbye speech before night", async () => {
    const user = userEvent.setup();
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    const initial: GameState = {
      ...base,
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
      "is-goodbye-highlight",
    );
    await user.click(screen.getByRole("button", { name: "Begin night" }));
    expect(screen.getByRole("heading", { name: "Mafia shots" })).toBeInTheDocument();
  });

  it("eliminates every nominee approved by the car-crash ballot", async () => {
    const user = userEvent.setup();
    const onGameChange = vi.fn<(game: GameState) => void>();
    const base = advanceSetupPhase(advanceSetupPhase(createPlanningGame()));
    const game: GameState = {
      ...base,
      phase: "car-crash-decision",
      carCrashSeats: [4, 6],
      carCrashVotes: Object.fromEntries(base.players.map(({ seat }) => [seat, true])),
    };

    render(
      <GameScreen
        game={game}
        hostName="Host Player"
        onGameChange={onGameChange}
        onEvent={() => undefined}
        privacyHidden={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: /resolve car crash/i }));

    const resolved = onGameChange.mock.calls.at(-1)?.[0];
    expect(resolved?.players.find(({ seat }) => seat === 4)?.status).toBe("eliminated");
    expect(resolved?.players.find(({ seat }) => seat === 6)?.status).toBe("eliminated");
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
    const targets = initial.players
      .filter(({ status, seat }) => status === "active" && seat !== victim.seat)
      .slice(0, 3);
    for (const target of targets) {
      await user.click(screen.getByRole("button", { name: `Add ${target.name} to Best move` }));
    }
    await user.click(screen.getByRole("button", { name: "Save Best move" }));

    expect(screen.getByRole("heading", { name: "Day 2" })).toBeInTheDocument();
  });

  it("shows Happy day, active team counts, and explicitly finishes the winning game", async () => {
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
    expect(screen.getByText("Happy day")).toBeInTheDocument();
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
    expect(screen.getByRole("status")).toHaveTextContent("Citizens win");
    await user.click(screen.getByRole("button", { name: "Finish the game" }));
    expect(onFinishGame).toHaveBeenCalledTimes(1);
  });
});
