import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
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
import { namedProfiles, renderWithProfiles } from "../../test-player-directory.js";

const render = (ui: Parameters<typeof renderWithProfiles>[0]) =>
  renderWithProfiles(ui, namedProfiles("player-"));

const createDayGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(13));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
};

describe("GameUtilityPanels", () => {
  it("offers the nominee names as pressed-state buttons only for an open live ballot", async () => {
    const user = userEvent.setup();
    const onSelectVotingCandidate = vi.fn();
    const game: GameState = {
      ...createDayGame(),
      phase: "voting",
      nominations: [
        { candidateSeat: 2, nominatorSeat: 1, order: 1 },
        { candidateSeat: 3, nominatorSeat: 2, order: 2 },
      ],
      turnOrder: [2, 3],
      currentTurnIndex: 0,
    };
    const { rerender } = render(
      <GameUtilityPanels game={game} onSelectVotingCandidate={onSelectVotingCandidate} />,
    );
    const first = screen.getByRole("button", { name: "#2 Player 2" });
    const second = screen.getByRole("button", { name: "#3 Player 3" });
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(second).toHaveAttribute("aria-pressed", "false");
    second.focus();
    await user.keyboard("{Enter}");
    expect(onSelectVotingCandidate).toHaveBeenCalledExactlyOnceWith(3);
    rerender(
      <GameUtilityPanels
        game={{ ...game, phase: "voting-cancelled" }}
        onSelectVotingCandidate={onSelectVotingCandidate}
      />,
    );
    expect(screen.queryByRole("button", { name: "#3 Player 3" })).toBeNull();
  });
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
