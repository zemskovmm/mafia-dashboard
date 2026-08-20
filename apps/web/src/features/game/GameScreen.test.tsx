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

const createNegotiationGame = (): GameState => {
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
  const [game, setGame] = useState(createNegotiationGame);
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
    advanceSetupPhase(advanceSetupPhase(createNegotiationGame())),
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

    expect(screen.getByRole("heading", { name: /mafia negotiation/i })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: /nominate player 2/i }));
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
      ...advanceSetupPhase(advanceSetupPhase(createNegotiationGame())),
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
  });

  it("eliminates every nominee approved by the car-crash ballot", async () => {
    const user = userEvent.setup();
    const onGameChange = vi.fn<(game: GameState) => void>();
    const base = advanceSetupPhase(advanceSetupPhase(createNegotiationGame()));
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
    const dayGame = advanceSetupPhase(advanceSetupPhase(createNegotiationGame()));
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
});
