import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
import { GameUtilityPanels } from "./GameUtilityPanels.js";

const createDayGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(13));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
};

describe("GameUtilityPanels", () => {
  it("renders the timer and nomination order from the current game", () => {
    const game: GameState = {
      ...createDayGame(),
      nominations: [{ candidateSeat: 2, nominatorSeat: 1, order: 1 }],
    };

    render(<GameUtilityPanels game={game} />);

    expect(screen.getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Voting order" })).toHaveTextContent("#2 Player 2");
    expect(screen.getByRole("region", { name: "Voting order" })).toHaveTextContent(
      "Initiated by #1 Player 1",
    );
    expect(screen.getByRole("listitem")).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("listitem")).not.toHaveClass("is-voting-highlight");
  });

  it("shows current vote totals only during voting-related phases", () => {
    const base: GameState = {
      ...createDayGame(),
      day: 2,
      nominations: [{ candidateSeat: 2, nominatorSeat: 1, order: 1 }],
      voteAssignments: { 1: 2 },
    };
    const { rerender } = render(<GameUtilityPanels game={base} />);
    expect(screen.queryByText(/active vote/i)).toBeNull();

    rerender(
      <GameUtilityPanels
        game={{ ...base, phase: "voting", turnOrder: [2], currentTurnIndex: 0 }}
      />,
    );
    expect(screen.getByText("1 active vote")).toBeInTheDocument();
  });

  it("keeps Timer available and shows an empty voting state before a game exists", () => {
    render(<GameUtilityPanels game={null} />);

    expect(screen.getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Voting order" })).toHaveTextContent(
      "No nominations yet",
    );
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it.each([
    "day",
    "voting-cancelled",
    "car-crash",
    "car-crash-decision",
    "car-crash-result",
    "goodbye-speech",
    "night-mafia",
  ] as const)("does not retain the candidate highlight in %s", (phase) => {
    const game: GameState = {
      ...createDayGame(),
      phase: "voting",
      nominations: [{ candidateSeat: 2, nominatorSeat: 1, order: 1 }],
      turnOrder: [2],
      currentTurnIndex: 0,
    };
    const { rerender } = render(<GameUtilityPanels game={game} />);
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("listitem")).toHaveClass("is-voting-highlight");

    rerender(<GameUtilityPanels game={{ ...game, phase }} />);
    expect(screen.getByRole("listitem")).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("listitem")).not.toHaveClass("is-voting-highlight");
  });
});
