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
  completeCurrentTurn,
  nominate,
  selectVotingCandidate,
  startVoting,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { GameUtilityPanels } from "./GameUtilityPanels.js";
import { namedProfiles, renderWithProfiles } from "../../test-player-directory.js";

const render = (ui: Parameters<typeof renderWithProfiles>[0]) =>
  renderWithProfiles(ui, namedProfiles("player-"));

const createDayGame = (federation = false): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(
    createSetup(players, federation ? { rulesEdition: "mafgame-2026-07-01" } : {}),
    createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  let game = createGame(completeRoleDraw(setup));
  while (game.phase !== "day") game = advanceSetupPhase(game);
  return game;
};

describe("GameUtilityPanels", () => {
  it("highlights the selected nominee without disclosure or live-cursor reminders", async () => {
    const user = userEvent.setup();
    let day = nominate(createDayGame(true), 1, 2);
    day = nominate(completeCurrentTurn(day), 2, 3);
    const game = selectVotingCandidate(startVoting(day), 3);
    const onSelect = vi.fn();
    render(<GameUtilityPanels game={game} onSelectVotingCandidate={onSelect} />);
    expect(screen.getByRole("button", { name: "#2 Player 2" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "#3 Player 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getAllByRole("listitem")[1]).toHaveAttribute("aria-current", "step");
    expect(screen.queryByText("Live call: #2")).toBeNull();
    expect(
      screen.queryByText(
        "Judge-private nomination list. Do not disclose it in response to player requests.",
      ),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "#2 Player 2" })).toHaveClass(
      "nomination-row-target",
    );
    await user.click(screen.getByRole("button", { name: "#2 Player 2" }));
    expect(onSelect).toHaveBeenCalledWith(2);
  });
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

  it("keeps Timer available without an empty voting panel before a game exists", () => {
    render(<GameUtilityPanels game={null} />);

    expect(screen.getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Voting order" })).toBeNull();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it.each([
    "day",
    "voting-cancelled",
    "car-crash",
    "car-crash-decision",
    "car-crash-result",
    "goodbye-speech",
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

    rerender(<GameUtilityPanels game={{ ...game, phase, goodbyeNext: "night" }} />);
    expect(screen.getByRole("listitem")).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("listitem")).not.toHaveClass("is-voting-highlight");
  });
  it.each([
    "night-mafia",
    "night-don",
    "night-sheriff",
    "night-resolution",
    "best-move",
    "mafia-planning",
    "finished",
    "cancelled",
    "draw",
    "goodbye-speech",
  ] as const)("hides even stale nominations during %s and keeps the timer", (phase) => {
    render(
      <GameUtilityPanels
        game={{
          ...createDayGame(),
          phase,
          goodbyeNext: "day",
          nominations: [{ candidateSeat: 2, nominatorSeat: 1, order: 1 }],
        }}
      />,
    );
    expect(screen.queryByRole("region", { name: "Voting order" })).toBeNull();
    expect(document.querySelector('[data-panel="voting"]')).toBeNull();
    expect(screen.getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
  });
});
