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
  });

  it("shows current vote totals only during voting-related phases", () => {
    const base: GameState = {
      ...createDayGame(),
      nominations: [{ candidateSeat: 2, nominatorSeat: 1, order: 1 }],
      voteAssignments: { 1: 2 },
    };
    const { rerender } = render(<GameUtilityPanels game={base} />);
    expect(screen.queryByText(/active vote/i)).toBeNull();

    rerender(<GameUtilityPanels game={{ ...base, phase: "voting" }} />);
    expect(screen.getByText("1 active vote")).toBeInTheDocument();
  });

  it("keeps Timer available and shows an empty voting state before a game exists", () => {
    render(<GameUtilityPanels game={null} />);

    expect(screen.getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Voting order" })).toHaveTextContent(
      "No nominations yet",
    );
  });
});
