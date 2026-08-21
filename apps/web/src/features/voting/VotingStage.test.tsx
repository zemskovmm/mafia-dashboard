import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  advanceSetupPhase,
  beginRoleDraw,
  completeCurrentTurn,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  nominate,
  startVoting,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { VotingStage } from "./VotingStage.js";

const votingGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `p-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(9));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  let game = advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
  game = nominate(game, 1, 4);
  game = completeCurrentTurn(game);
  game = nominate(game, 2, 6);
  return startVoting(game);
};

const Harness = ({
  onResolved,
}: {
  onResolved: (game: GameState, seats: readonly number[]) => void;
}) => {
  const [game, setGame] = useState(votingGame);
  return (
    <VotingStage
      game={game}
      onGameChange={setGame}
      onResolved={onResolved}
      onEvent={() => undefined}
    />
  );
};

describe("VotingStage", () => {
  it("presents the eliminate-both decision after a repeated car-crash tie", () => {
    const game: GameState = {
      ...votingGame(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };

    render(
      <VotingStage
        game={game}
        onGameChange={() => undefined}
        onResolved={() => undefined}
        onEvent={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Eliminate both nominees" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep both nominees" })).toBeInTheDocument();
  });

  it("de-emphasizes players outside a car crash", () => {
    const game: GameState = {
      ...votingGame(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };
    render(
      <VotingStage
        game={game}
        onGameChange={() => undefined}
        onResolved={() => undefined}
        onEvent={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /^vote as player 1 /i })).toHaveClass("is-inactive");
    expect(screen.getByRole("button", { name: /^vote as player 4 /i })).not.toHaveClass(
      "is-inactive",
    );
  });

  it("moves a tied vote into canonical car-crash speeches", async () => {
    const user = userEvent.setup();
    const base = votingGame();
    const tied: GameState = {
      ...base,
      currentTurnIndex: base.nominations.length - 1,
      voteAssignments: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [index + 1, index < 5 ? 4 : 6]),
      ),
    };
    const onGameChange = vi.fn<(game: GameState) => void>();
    const props = {
      onGameChange,
      onResolved: () => undefined,
      onEvent: () => undefined,
    };
    render(<VotingStage {...props} game={tied} />);

    await user.click(screen.getByRole("button", { name: /resolve voting/i }));
    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "car-crash",
        turnOrder: [4, 6],
        currentTurnIndex: 0,
        voteAssignments: {},
      }),
    );
  });

  it("keeps voting on the table and gives the last candidate every remaining vote", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn<(game: GameState, seats: readonly number[]) => void>();
    render(<Harness onResolved={onResolved} />);

    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Voting candidate" })).toHaveTextContent("Player 4");
    await user.click(screen.getByRole("button", { name: /vote as player 4 for player 4/i }));
    expect(screen.getByRole("button", { name: /player 4 voted for seat 4/i })).toHaveClass(
      "is-inactive",
    );
    for (const seat of [1, 2, 3, 5, 6, 7]) {
      await user.click(
        screen.getByRole("button", {
          name: new RegExp(`vote as player ${seat} for player 4`, "i"),
        }),
      );
    }
    await user.click(screen.getByRole("button", { name: /next candidate/i }));

    expect(screen.getAllByRole("button", { name: /voted for seat 4/i })).toHaveLength(7);
    expect(screen.getAllByRole("button", { name: /voted for seat 6/i })).toHaveLength(3);
    expect(screen.getByText("3 votes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /resolve voting/i }));

    expect(onResolved).toHaveBeenCalledWith(expect.any(Object), [4]);
  });
});
