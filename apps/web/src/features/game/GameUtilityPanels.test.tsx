import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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

const HideHarness = () => {
  const [timerHidden, setTimerHidden] = useState(false);
  const [votingHidden, setVotingHidden] = useState(false);
  return (
    <GameUtilityPanels
      game={createDayGame()}
      timerHidden={timerHidden}
      votingHidden={votingHidden}
      onTimerHiddenChange={setTimerHidden}
      onVotingHiddenChange={setVotingHidden}
    />
  );
};

describe("GameUtilityPanels", () => {
  it("renders the timer and nomination order from the current game", () => {
    const game: GameState = {
      ...createDayGame(),
      nominations: [{ candidateSeat: 2, nominatorSeat: 1, order: 1 }],
    };

    render(
      <GameUtilityPanels
        game={game}
        timerHidden={false}
        votingHidden={false}
        onTimerHiddenChange={() => undefined}
        onVotingHiddenChange={() => undefined}
      />,
    );

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
    const { rerender } = render(
      <GameUtilityPanels
        game={base}
        timerHidden={false}
        votingHidden={false}
        onTimerHiddenChange={() => undefined}
        onVotingHiddenChange={() => undefined}
      />,
    );
    expect(screen.queryByText(/active vote/i)).toBeNull();

    rerender(
      <GameUtilityPanels
        game={{ ...base, phase: "voting" }}
        timerHidden={false}
        votingHidden={false}
        onTimerHiddenChange={() => undefined}
        onVotingHiddenChange={() => undefined}
      />,
    );
    expect(screen.getByText("1 active vote")).toBeInTheDocument();
  });

  it("hides Timer on a right swipe and restores it by tap", () => {
    render(<HideHarness />);
    const handle = screen.getByRole("button", { name: "Timer panel handle" });

    fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 20 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 70, clientY: 22 }] });

    expect(screen.queryByRole("region", { name: "Timer controls" })).toBeNull();
    const restore = screen.getByRole("button", { name: "Show timer" });
    fireEvent.touchStart(restore, { touches: [{ clientX: 10, clientY: 20 }] });
    fireEvent.touchEnd(restore, { changedTouches: [{ clientX: 14, clientY: 24 }] });
    fireEvent.click(restore);
    expect(screen.getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
  });

  it("keeps a running Timer mounted while its panel is hidden", () => {
    render(<HideHarness />);
    const timer = screen.getByRole("region", { name: "Timer controls" });
    fireEvent.click(screen.getByRole("button", { name: "Start 60 second timer" }));

    fireEvent.click(screen.getByRole("button", { name: "Timer panel handle" }));
    fireEvent.click(screen.getByRole("button", { name: "Show timer" }));

    expect(screen.getByRole("region", { name: "Timer controls" })).toBe(timer);
    expect(screen.getByRole("button", { name: "Stop timer" })).toHaveTextContent("60");
  });

  it("hides Voting on a right swipe and restores it on a left swipe", () => {
    render(<HideHarness />);
    const handle = screen.getByRole("button", { name: "Voting panel handle" });

    fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 20 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 70, clientY: 22 }] });
    expect(screen.queryByRole("region", { name: "Voting order" })).toBeNull();

    const restore = screen.getByRole("button", { name: "Show voting" });
    fireEvent.touchStart(restore, { touches: [{ clientX: 70, clientY: 20 }] });
    fireEvent.touchEnd(restore, { changedTouches: [{ clientX: 10, clientY: 22 }] });
    expect(screen.getByRole("region", { name: "Voting order" })).toBeInTheDocument();
  });

  it("ignores the compatibility click after a wrong-axis swipe reaches the threshold", () => {
    render(<HideHarness />);
    const handle = screen.getByRole("button", { name: "Timer panel handle" });

    fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 64 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 10, clientY: 20 }] });
    fireEvent.click(handle);

    expect(screen.getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
  });

  it("ignores the compatibility click after a wrong-axis restore swipe reaches the threshold", () => {
    render(<HideHarness />);
    const handle = screen.getByRole("button", { name: "Voting panel handle" });
    fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 20 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 70, clientY: 22 }] });
    const restore = screen.getByRole("button", { name: "Show voting" });

    fireEvent.touchStart(restore, { touches: [{ clientX: 70, clientY: 20 }] });
    fireEvent.touchEnd(restore, { changedTouches: [{ clientX: 70, clientY: 64 }] });
    fireEvent.click(restore);

    expect(screen.queryByRole("region", { name: "Voting order" })).toBeNull();
  });

  it("uses the compatibility click after a short touch tap", () => {
    render(<HideHarness />);
    const handle = screen.getByRole("button", { name: "Timer panel handle" });

    fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 20 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 14, clientY: 24 }] });
    fireEvent.click(handle);

    expect(screen.queryByRole("region", { name: "Timer controls" })).toBeNull();
  });
});
