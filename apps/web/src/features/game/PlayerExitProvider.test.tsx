import * as domain from "@mafia/game-domain";
import type { GameState } from "@mafia/game-domain";
import { useLayoutEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { DEFAULT_PLAYER_EXIT_SETTINGS } from "../effects/player-exit-preferences.js";
import { PlayerExitProvider, usePlayerExits } from "./PlayerExitProvider.js";

const day = (): GameState => {
  let setup = domain.beginRoleDraw(
    domain.createSetup(
      Array.from({ length: 10 }, (_, index) => ({
        id: `player-${index + 1}`,
        seat: index + 1,
      })),
    ),
    domain.createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  let game = domain.createGame(domain.completeRoleDraw(setup), { bestMoveEnabled: false });
  for (let index = 0; index < 8 && game.phase !== "day"; index++)
    game = domain.advanceSetupPhase(game);
  return game;
};
const exclude = (game: GameState, seat: number) => {
  for (let index = 0; index < 4; index++) game = domain.issueFoul(game, seat);
  return game;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PlayerExitProvider Fancy policy", () => {
  it("settles requests immediately on opt-out and never replays disabled departures", () => {
    const query = Object.assign(new EventTarget(), { matches: false });
    const subscribe = vi.spyOn(query, "addEventListener");
    const unsubscribe = vi.spyOn(query, "removeEventListener");
    const matchMedia = vi.fn(() => query);
    vi.stubGlobal("matchMedia", matchMedia);
    const commits: number[][] = [];
    const mounted = vi.fn();
    const Probe = () => {
      const exits = usePlayerExits();
      const seats = Object.keys(exits.requests).map(Number);
      useLayoutEffect(() => {
        commits.push(seats);
      });
      useLayoutEffect(() => {
        mounted();
      }, []);
      return <output data-testid="requests">{seats.join(",")}</output>;
    };
    const fixture = (game: GameState, fancy: boolean) => (
      <FancyFeaturesContext.Provider value={fancy}>
        <PlayerExitProvider
          game={game}
          live
          privacyHidden={false}
          settings={DEFAULT_PLAYER_EXIT_SETTINGS}
        >
          <Probe />
          <input aria-label="Draft" defaultValue="kept" />
        </PlayerExitProvider>
      </FancyFeaturesContext.Provider>
    );
    const initial = day();
    const seats = initial.players
      .filter((player) => player.role === "citizen")
      .map((player) => player.seat);
    const { rerender, unmount } = render(fixture(initial, false));
    const draft = screen.getByRole("textbox", { name: "Draft" });
    expect(matchMedia).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const first = exclude(initial, seats[0]!);
    rerender(fixture(first, false));
    expect(screen.getByTestId("requests")).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
    // A simultaneous latest game and OFF→ON update must not turn old work into a new departure.
    const second = exclude(first, seats[1]!);
    rerender(fixture(second, true));
    expect(screen.getByTestId("requests")).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);

    const third = exclude(second, seats[2]!);
    rerender(fixture(third, true));
    expect(screen.getByTestId("requests")).toHaveTextContent(String(seats[2]));
    expect(vi.getTimerCount()).toBe(1);
    const last = commits.length;
    rerender(fixture(third, false));
    expect(commits.slice(last).every((requests) => requests.length === 0)).toBe(true);
    expect(screen.getByTestId("requests")).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledWith("change", expect.any(Function));
    act(() => vi.advanceTimersByTime(2_000));
    rerender(fixture(third, true));
    expect(screen.getByTestId("requests")).toBeEmptyDOMElement();
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("kept");
    expect(mounted).toHaveBeenCalledOnce();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains reduced-motion and child-setting constraints after re-enabling", () => {
    const query = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => query),
    );
    const Probe = () => (
      <output data-testid="requests">{Object.keys(usePlayerExits().requests).join(",")}</output>
    );
    const initial = day();
    const seat = initial.players.find((player) => player.role === "citizen")!.seat;
    const fixture = (game: GameState, fancy: boolean, enabled = true) => (
      <FancyFeaturesContext.Provider value={fancy}>
        <PlayerExitProvider
          game={game}
          live
          privacyHidden={false}
          settings={{ ...DEFAULT_PLAYER_EXIT_SETTINGS, enabled }}
        >
          <Probe />
        </PlayerExitProvider>
      </FancyFeaturesContext.Provider>
    );
    const { rerender } = render(fixture(initial, false));
    rerender(fixture(initial, true));
    rerender(fixture(exclude(initial, seat), true));
    expect(screen.getByTestId("requests")).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
    rerender(fixture(initial, false, false));
    Object.assign(query, { matches: false });
    rerender(fixture(initial, true, false));
    rerender(fixture(exclude(initial, seat), true, false));
    expect(screen.getByTestId("requests")).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
  });
});
