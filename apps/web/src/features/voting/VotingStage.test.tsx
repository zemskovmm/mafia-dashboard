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
  it("shows a cancellation step when the host skips voting", async () => {
    const user = userEvent.setup();
    const onGameChange = vi.fn<(game: GameState) => void>();
    const onEvent = vi.fn<(type: string, payload: Record<string, unknown>) => void>();
    render(
      <VotingStage
        game={votingGame()}
        onGameChange={onGameChange}
        onResolved={() => undefined}
        onEvent={onEvent}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Skip voting" }));

    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "voting-cancelled",
        votingCancellation: { reason: "host-skipped" },
      }),
    );
    expect(onEvent).toHaveBeenCalledWith("voting.skipped", {
      day: 1,
      reason: "host-skipped",
    });
  });

  it("explains why voting was cancelled before night begins", async () => {
    const user = userEvent.setup();
    const onGameChange = vi.fn<(game: GameState) => void>();
    render(
      <VotingStage
        game={{
          ...votingGame(),
          phase: "voting-cancelled",
          voteAssignments: {},
          votingCancellation: { reason: "red-card" },
        }}
        onGameChange={onGameChange}
        onResolved={() => undefined}
        onEvent={() => undefined}
      />,
    );

    expect(screen.getByRole("status", { name: "Voting cancelled" })).toHaveTextContent(
      "A player received a red card, so voting is cancelled for this day.",
    );
    await user.click(screen.getByRole("button", { name: "Begin night" }));
    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "night-mafia",
        nominations: [],
        votingCancellation: undefined,
      }),
    );
  });

  it("presents the same simple-majority ballot after a two-player repeated tie", () => {
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

    expect(screen.getByText("Eliminate all players voting")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Eliminate both nominees" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep both nominees" })).toBeNull();
  });

  it("uses a zero-valid eliminate-all ballot without separate decision buttons", async () => {
    const user = userEvent.setup();
    const game: GameState = {
      ...votingGame(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6, 8],
      carCrashVotes: {},
    };

    const onResolved = vi.fn<(game: GameState, seats: readonly number[]) => void>();
    render(
      <VotingStage
        game={game}
        onGameChange={() => undefined}
        onResolved={onResolved}
        onEvent={() => undefined}
      />,
    );

    expect(screen.getByText("Eliminate all players voting")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Eliminate all nominees" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep all nominees" })).toBeNull();
    const resolve = screen.getByRole("button", { name: "Resolve car crash" });
    expect(resolve).toBeEnabled();
    await user.click(resolve);
    expect(onResolved).toHaveBeenCalledWith(
      {
        ...game,
        carCrashVotes: Object.fromEntries(game.players.map(({ seat }) => [seat, false])),
      },
      [],
    );
  });

  it("keeps Resolve and Skip voting enabled with zero eliminate-all votes", async () => {
    const user = userEvent.setup();
    const game: GameState = {
      ...votingGame(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6, 8],
      carCrashVotes: {},
    };
    const onGameChange = vi.fn<(game: GameState) => void>();
    const onEvent = vi.fn<(type: string, payload: Record<string, unknown>) => void>();
    render(
      <VotingStage
        game={game}
        onGameChange={onGameChange}
        onResolved={() => undefined}
        onEvent={onEvent}
      />,
    );

    expect(screen.getByRole("button", { name: "Resolve car crash" })).toBeEnabled();
    const skip = screen.getByRole("button", { name: "Skip voting" });
    expect(skip).toBeEnabled();
    await user.click(skip);

    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "voting-cancelled",
        votingCancellation: { reason: "host-skipped" },
      }),
    );
    expect(onEvent).toHaveBeenCalledWith("voting.skipped", {
      day: 1,
      reason: "host-skipped",
    });
  });

  it("keeps every active player available for the eliminate-all ballot", () => {
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

    expect(screen.getByRole("button", { name: /^vote as player 1 /i })).not.toHaveClass(
      "is-inactive",
    );
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

  it("moves an all-player repeated tie to the skipped-ballot message", async () => {
    const user = userEvent.setup();
    const base = votingGame();
    const activeSeats = base.players
      .filter(({ status }) => status === "active")
      .map(({ seat }) => seat);
    const game: GameState = {
      ...base,
      nominations: activeSeats.map((seat, index) => ({
        nominatorSeat: seat,
        candidateSeat: seat,
        order: index + 1,
      })),
      turnOrder: activeSeats,
      currentTurnIndex: activeSeats.length - 1,
      votingRound: "repeat",
      carCrashSeats: activeSeats,
      voteAssignments: Object.fromEntries(activeSeats.map((seat) => [seat, seat])),
    };
    const onGameChange = vi.fn<(game: GameState) => void>();

    render(
      <VotingStage
        game={game}
        onGameChange={onGameChange}
        onResolved={() => undefined}
        onEvent={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Resolve voting" }));

    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "car-crash-skipped", carCrashSeats: activeSeats }),
    );
  });

  it("explains a skipped eliminate-all ballot before beginning night", async () => {
    const user = userEvent.setup();
    const base = votingGame();
    const activeSeats = base.players
      .filter(({ status }) => status === "active")
      .map(({ seat }) => seat);
    const game: GameState = {
      ...base,
      phase: "car-crash-decision",
      carCrashSeats: activeSeats,
      carCrashVotes: {},
      voteAssignments: {},
    };
    const onGameChange = vi.fn<(game: GameState) => void>();

    render(
      <VotingStage
        game={game}
        onGameChange={onGameChange}
        onResolved={() => undefined}
        onEvent={() => undefined}
      />,
    );

    expect(screen.getByText("Eliminate-all vote skipped")).toBeInTheDocument();
    expect(
      screen.getByText(
        "All active players are tied. Eliminating everyone would leave no way to determine a winner.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Eliminate all nominees" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Begin night" }));
    expect(onGameChange).toHaveBeenCalledWith(expect.objectContaining({ phase: "night-mafia" }));
  });

  it("toggles a player's vote by tapping the same card again", async () => {
    const user = userEvent.setup();
    render(<Harness onResolved={() => undefined} />);

    await user.click(screen.getByRole("button", { name: /vote as player 1 for player 4/i }));
    const selectedCard = screen.getByRole("button", { name: /player 1 voted for seat 4/i });
    expect(selectedCard).toHaveClass("is-voting-highlight");
    expect(screen.getByText("1 votes")).toBeInTheDocument();

    await user.click(selectedCard);

    expect(screen.getByRole("button", { name: /vote as player 1 for player 4/i })).not.toHaveClass(
      "is-voting-highlight",
    );
    expect(screen.getByText("0 votes")).toBeInTheDocument();
  });

  it("keeps voting on the table and gives the last candidate every remaining vote", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn<(game: GameState, seats: readonly number[]) => void>();
    render(<Harness onResolved={onResolved} />);

    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Voting candidate" })).toHaveTextContent(
      "#4 Player 4",
    );
    await user.click(screen.getByRole("button", { name: /vote as player 4 for player 4/i }));
    const firstSelected = screen.getByRole("button", { name: /player 4 voted for seat 4/i });
    expect(firstSelected).toHaveClass("is-inactive", "is-voting-highlight");
    await user.click(screen.getByRole("button", { name: /vote as player 1 for player 4/i }));
    expect(screen.getByRole("button", { name: /player 1 voted for seat 4/i })).toHaveClass(
      "is-voting-highlight",
    );
    expect(firstSelected).toHaveClass("is-voting-highlight");
    for (const seat of [2, 3, 5, 6, 7]) {
      await user.click(
        screen.getByRole("button", {
          name: new RegExp(`vote as player ${seat} for player 4`, "i"),
        }),
      );
    }
    await user.click(screen.getByRole("button", { name: /next candidate/i }));

    const firstCandidateVoters = screen.getAllByRole("button", { name: /voted for seat 4/i });
    const autoAssignedVoters = screen.getAllByRole("button", { name: /voted for seat 6/i });
    expect(firstCandidateVoters).toHaveLength(7);
    expect(
      firstCandidateVoters.every((card) => !card.classList.contains("is-voting-highlight")),
    ).toBe(true);
    expect(autoAssignedVoters).toHaveLength(3);
    expect(autoAssignedVoters.every((card) => card.classList.contains("is-voting-highlight"))).toBe(
      true,
    );
    expect(screen.getByText("3 votes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /resolve voting/i }));

    expect(onResolved).toHaveBeenCalledWith(expect.any(Object), [4]);
  });
});
