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
  it("clears a resolved tie when canonical vote assignments roll back", async () => {
    const user = userEvent.setup();
    const base = votingGame();
    const tied: GameState = {
      ...base,
      voteAssignments: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [index + 1, index < 5 ? 4 : 6]),
      ),
    };
    const props = {
      onGameChange: () => undefined,
      onResolved: () => undefined,
      onEvent: () => undefined,
    };
    const { rerender } = render(<VotingStage {...props} game={tied} />);

    await user.click(screen.getByRole("button", { name: /resolve voting/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/tie between seats 4 and 6/i);

    rerender(
      <VotingStage
        {...props}
        game={{ ...tied, voteAssignments: { ...tied.voteAssignments, 10: undefined } }}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("assigns each voter once to the selected candidate and resolves totals", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn<(game: GameState, seats: readonly number[]) => void>();
    render(<Harness onResolved={onResolved} />);

    await user.click(screen.getByRole("button", { name: /select candidate player 4/i }));
    for (let seat = 1; seat <= 7; seat += 1) {
      await user.click(
        screen.getByRole("button", { name: new RegExp(`assign player ${seat} vote`, "i") }),
      );
    }
    await user.click(screen.getByRole("button", { name: /select candidate player 6/i }));
    for (let seat = 8; seat <= 10; seat += 1) {
      await user.click(
        screen.getByRole("button", { name: new RegExp(`assign player ${seat} vote`, "i") }),
      );
    }

    expect(screen.getByText("7 votes")).toBeInTheDocument();
    expect(screen.getByText("3 votes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /resolve voting/i }));

    expect(onResolved).toHaveBeenCalledWith(expect.any(Object), [4]);
  });
});
