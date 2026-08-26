import { render, screen, within } from "@testing-library/react";
import type { ComponentType } from "react";
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
import { LiveSidePanel } from "./LiveSidePanel.js";
import { DEFAULT_GLASS_SETTINGS } from "../theme/glass-settings.js";

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

describe("LiveSidePanel", () => {
  it("groups timer, voting, and the persistent player in that order", () => {
    render(
      <LiveSidePanel game={createDayGame()}>
        <div data-testid="persistent-player">Music</div>
      </LiveSidePanel>,
    );

    const rail = screen.getByRole("complementary", { name: "Live game controls" });
    expect(rail).toHaveClass("has-live-utilities");
    expect(within(rail).getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
    expect(within(rail).getByRole("region", { name: "Voting order" })).toBeInTheDocument();
    expect(rail.lastElementChild).toBe(screen.getByTestId("persistent-player"));
  });

  it("keeps the player mounted when live utility panels are unavailable", () => {
    const { rerender } = render(
      <LiveSidePanel game={createDayGame()}>
        <div data-testid="persistent-player">Music</div>
      </LiveSidePanel>,
    );
    const player = screen.getByTestId("persistent-player");

    rerender(
      <LiveSidePanel game={null} hidden>
        <div data-testid="persistent-player">Music</div>
      </LiveSidePanel>,
    );

    expect(screen.getByTestId("persistent-player")).toBe(player);
    expect(screen.getByRole("complementary", { hidden: true })).toHaveClass("is-player-only");
    expect(screen.queryByRole("region", { name: "Timer controls" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Voting order" })).toBeNull();
  });

  it("uses the Málaga Glass fallback as the single live rail surface", () => {
    const TestPanel = LiveSidePanel as unknown as ComponentType<Record<string, unknown>>;
    render(
      <TestPanel
        game={createDayGame()}
        theme="malaga-glass"
        glassSettings={DEFAULT_GLASS_SETTINGS}
        supportsTrueRefraction={false}
      >
        <div>Music</div>
      </TestPanel>,
    );

    const rail = screen.getByRole("complementary", { name: "Live game controls" });
    expect(rail.querySelector(".live-side-panel-glass")).toHaveClass(
      "glass-surface",
      "is-glass-fallback",
    );
  });
});
