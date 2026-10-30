import * as domain from "@mafia/game-domain";
import type { GameState, ReplayFrame, CanonicalGameEventDraft } from "@mafia/game-domain";
import { StrictMode, useLayoutEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { DEFAULT_PLAYER_EXIT_SETTINGS } from "../effects/player-exit-preferences.js";
import { PlayerExitProvider, usePlayerExits } from "./PlayerExitProvider.js";
import { projectPlayerActions } from "./player-action-presentation.js";
import { playerDepartureTimeline } from "../effects/player-departure-timeline.js";
import { PlayerCardStyleContext } from "../theme/PlayerCardStyleContext.js";
import type { PlayerCardStyle } from "../theme/player-card-preferences.js";

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
  it.each(["classic", "heritage", "noir"] as const)(
    "settles %s → Glass style changes before replacement renderers can join old work",
    (style) => {
      const initial = day();
      const seat = initial.players.find((player) => player.role === "citizen")!.seat;
      const removed = exclude(initial, seat);
      const Probe = () => (
        <output data-testid="presentation">{JSON.stringify(usePlayerExits())}</output>
      );
      const fixture = (game: GameState, selected: PlayerCardStyle) => (
        <PlayerCardStyleContext.Provider value={{ style: selected, rolePlacement: "below" }}>
          <FancyFeaturesContext.Provider value={true}>
            <PlayerExitProvider
              game={game}
              live
              privacyHidden={false}
              settings={DEFAULT_PLAYER_EXIT_SETTINGS}
            >
              <Probe />
            </PlayerExitProvider>
          </FancyFeaturesContext.Provider>
        </PlayerCardStyleContext.Provider>
      );
      const { rerender } = render(fixture(initial, style));
      rerender(fixture(removed, style));
      const read = () => JSON.parse(screen.getByTestId("presentation").textContent!);
      expect(read().requests[seat]).toBeDefined();
      rerender(fixture(removed, "glass"));
      expect(read().requests).toEqual({});
      expect(read().endpoints[seat]).toBe("discipline");
      expect(vi.getTimerCount()).toBe(0);
      rerender(fixture(removed, style));
      expect(read().requests).toEqual({});
    },
  );

  it("binds feedback to accepted heads, preserves endpoints after expiry, and never replays restoration", () => {
    const frames: ReplayFrame[] = [];
    const initial = day();
    let game = initial;
    const seat = game.players.find((player) => player.role === "citizen")!.seat;
    const Probe = () => (
      <output data-testid="presentation">{JSON.stringify(usePlayerExits())}</output>
    );
    const fixture = (live = true) => (
      <StrictMode>
        <FancyFeaturesContext.Provider value={true}>
          <PlayerExitProvider
            game={game}
            live={live}
            privacyHidden={false}
            settings={DEFAULT_PLAYER_EXIT_SETTINGS}
            presentation={projectPlayerActions(frames, game)}
          >
            <Probe />
          </PlayerExitProvider>
        </FancyFeaturesContext.Provider>
      </StrictMode>
    );
    const { rerender, unmount } = render(fixture());
    const read = () => JSON.parse(screen.getByTestId("presentation").textContent!);
    const accept = (draft: CanonicalGameEventDraft) => {
      const before = frames.at(-1)?.after ?? initial;
      const next = domain.createGameLogEntry({
        before,
        draft,
        gameId: "fixture",
        id: `e-${frames.length + 1}`,
        sequence: frames.length + 1,
        parentEventId: frames.at(-1)?.entry.id ?? null,
        createdAt: "2026-10-28T12:00:00.000Z",
      });
      frames.push({ before, ...next });
      game = next.after;
      rerender(fixture());
    };
    // Unaccepted display drafts cannot manufacture a foul cue or consume the accepted baseline.
    game = domain.issueFoul(initial, seat);
    rerender(fixture());
    expect(read().feedback).toEqual({});
    accept({ type: "foul.issued", payload: { seat, foulNumber: 1, redCarded: false } });
    expect(read().feedback[seat].foulNumber).toBe(1);
    const id = read().feedback[seat].id;
    game = { ...game };
    rerender(fixture());
    expect(read().feedback[seat].id).toBe(id);
    for (const foulNumber of [2, 3])
      accept({ type: "foul.issued", payload: { seat, foulNumber, redCarded: false } });
    expect(read().feedback[seat].foulNumber).toBe(3);
    expect(read().requests).toEqual({});
    expect(game.players.find((player) => player.seat === seat)?.mutePending).toBe(true);
    accept({ type: "foul.issued", payload: { seat, foulNumber: 4, redCarded: true } });
    const request = read().requests[seat];
    expect(request.cause).toBe("discipline");
    expect(read().endpoints[seat]).toBe("discipline");
    accept({ type: "discipline.removals-announced", payload: { seats: [seat] } });
    expect(read().requests[seat].id).toBe(request.id);
    act(() =>
      vi.advanceTimersByTime(
        playerDepartureTimeline(request.settings, request.cause).duration + 100,
      ),
    );
    expect(read().requests).toEqual({});
    expect(read().feedback).toEqual({});
    expect(read().endpoints[seat]).toBe("discipline");
    unmount();
    render(fixture(false));
    expect(read().requests).toEqual({});
    expect(read().feedback).toEqual({});
    expect(read().endpoints[seat]).toBe("discipline");
  });

  it("keeps each mixed terminal departure's cause and clock; adjudication only cues the result", () => {
    const Probe = () => (
      <output data-testid="presentation">{JSON.stringify(usePlayerExits())}</output>
    );
    const fixture = (game: GameState) => (
      <FancyFeaturesContext.Provider value={true}>
        <PlayerExitProvider
          game={game}
          live
          privacyHidden={false}
          settings={DEFAULT_PLAYER_EXIT_SETTINGS}
        >
          <Probe />
        </PlayerExitProvider>
      </FancyFeaturesContext.Provider>
    );
    const initial = day();
    const seats = initial.players
      .filter((player) => player.role === "citizen")
      .map((player) => player.seat);
    const goodbye = domain.completeEliminations(initial, seats.slice(0, 3));
    const { rerender } = render(fixture(goodbye));
    const removed = domain.redCard(goodbye, seats[3]!, {
      seat: seats[3]!,
      stage: "farewell",
      rule: "6.2.3",
      reason: "Fixture",
      checkInProgress: false,
    });
    rerender(fixture(removed));
    const read = () => JSON.parse(screen.getByTestId("presentation").textContent!);
    const requests = read().requests;
    for (const seat of seats.slice(0, 3)) expect(requests[seat].cause).toBe("vote");
    expect(requests[seats[3]!].cause).toBe("discipline");
    expect(
      new Set(
        Object.values(requests).map((request) => (request as { startedAt: number }).startedAt),
      ).size,
    ).toBe(1);
    rerender(fixture(initial));
    const awarded = domain.adjudicateOpponentVictory(initial, {
      losingTeam: "red",
      rule: "6.3.1",
      reason: "Fixture",
      committeeApproved: false,
    });
    rerender(fixture(awarded));
    expect(read().requests).toEqual({});
    expect(read().adjudication).toBeDefined();
    expect(awarded.players.map((player) => player.status)).toEqual(
      initial.players.map((player) => player.status),
    );
  });

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
