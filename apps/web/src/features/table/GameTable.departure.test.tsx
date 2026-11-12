import * as domain from "@mafia/game-domain";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { DEFAULT_PLAYER_EXIT_SETTINGS } from "../effects/player-exit-preferences.js";
import { PlayerExitProvider } from "../game/PlayerExitProvider.js";
import { PlayerCardStyleContext } from "../theme/PlayerCardStyleContext.js";
import type { PlayerCardStyle } from "../theme/player-card-preferences.js";
import { GameTable } from "./GameTable.js";

const day = () => {
  let setup = domain.beginRoleDraw(
    domain.createSetup(
      Array.from({ length: 10 }, (_, index) => ({ id: `player-${index + 1}`, seat: index + 1 })),
    ),
    domain.createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  let game = domain.createGame(domain.completeRoleDraw(setup), { bestMoveEnabled: false });
  while (game.phase !== "day") game = domain.advanceSetupPhase(game);
  return game;
};

const fixture = (
  game: domain.GameState,
  style: PlayerCardStyle,
  { privacyHidden = false, completed = false, readOnly = false, provisionalDeceased = false } = {},
) => (
  <FancyFeaturesContext.Provider value={true}>
    <PlayerCardStyleContext.Provider value={{ style, rolePlacement: "below" }}>
      <PlayerExitProvider
        game={game}
        live={!readOnly}
        privacyHidden={privacyHidden}
        settings={DEFAULT_PLAYER_EXIT_SETTINGS}
      >
        <GameTable
          seats={game.players.map((player) => ({
            ...player,
            name: `Player ${player.seat}`,
            nominated: true,
            supportCount: 2,
            muted: player.mutePending,
            provisionalDeceased: provisionalDeceased && player.status === "eliminated",
          }))}
          privacyHidden={privacyHidden}
          completed={completed}
          readOnly={readOnly}
        />
      </PlayerExitProvider>
    </PlayerCardStyleContext.Provider>
  </FancyFeaturesContext.Provider>
);
const card = (seat: number, readOnly = false) =>
  screen.getByRole(readOnly ? "group" : "button", { name: `Seat ${seat}: Player ${seat}` });
const expectFouls = (seat: number, count: number) => {
  expect(card(seat).querySelector(".foul-markers")).toHaveAccessibleName(`Foul ×${count}`);
  expect(card(seat).querySelectorAll(".foul-dot")).toHaveLength(Math.min(3, count));
};
const expectNoFouls = (element: HTMLElement) => {
  expect(element.querySelector(".foul-markers,.foul-dot,[aria-label^='Foul ×']")).toBeNull();
  expect(element.querySelector(".card-mute")).toBeNull();
};

describe.each(["glass", "classic", "heritage", "noir"] as const)(
  "%s departure discipline indicators",
  (style) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    beforeEach(() => {
      vi.useFakeTimers();
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        value: vi.fn(() => ({ finished: new Promise(() => {}), cancel: vi.fn() })),
      });
    });
    afterEach(() => {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "animate", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "animate");
      vi.useRealTimers();
    });

    it.each([false, true])(
      "removes dots from both turning faces and the settled reverse, not pending goodbye (privacy: %s)",
      (privacyHidden) => {
        let initial = day();
        const victim = initial.players.find((player) => player.role === "citizen")!.seat;
        for (let count = 0; count < 3; count++) initial = domain.issueFoul(initial, victim);
        const neighbor = initial.players.find((player) => player.seat !== victim)!.seat;
        initial = domain.issueFoul(initial, neighbor);
        const goodbye = domain.completeEliminations(initial, [victim]);
        const departed = domain.completeGoodbyeSpeech(goodbye);
        const snapshot = JSON.stringify(departed);
        const tree = (game: domain.GameState, readOnly = false) =>
          fixture(game, style, { privacyHidden, readOnly });
        const { rerender, unmount } = render(tree(initial));
        expectFouls(victim, 3);
        expect(card(victim).querySelector(".card-mute")).not.toBeNull();
        rerender(tree(goodbye));
        expect(card(victim)).toHaveClass("is-awaiting-goodbye");
        expectFouls(victim, 3);
        expect(card(victim).querySelector(".card-mute")).not.toBeNull();
        rerender(tree(departed));
        expect(card(victim)).toHaveAttribute("data-player-exit");
        expectNoFouls(card(victim));
        expect(card(victim).querySelector(".card-nomination-symbol")).not.toBeNull();
        expect(card(victim).querySelector(".card-support")).toHaveTextContent("+2");
        expect(card(victim).parentElement?.querySelector(".player-seat-caption")).toHaveTextContent(
          `Player ${victim}`,
        );
        expectFouls(neighbor, 1);
        act(() => vi.runAllTimers());
        expect(card(victim)).not.toHaveAttribute("data-player-exit");
        expectNoFouls(card(victim));
        unmount();
        const restored = render(tree(departed, true));
        expectNoFouls(card(victim, true));
        expect(card(victim, true)).not.toHaveAttribute("data-player-exit");
        restored.rerender(tree(initial));
        expectFouls(victim, 3);
        expect(card(victim).querySelector(".card-mute")).not.toBeNull();
        expect(card(victim)).not.toHaveAttribute("data-departure-cause");
        expect(JSON.stringify(departed)).toBe(snapshot);
      },
    );

    it.each(["fourth-foul", "direct"] as const)(
      "hides dots immediately for %s exclusion while retaining the ribbon and completed presentation",
      (cause) => {
        let initial = day();
        const victim = initial.players.find((player) => player.role === "citizen")!.seat;
        for (let count = 0; count < 3; count++) initial = domain.issueFoul(initial, victim);
        const removed =
          cause === "fourth-foul"
            ? domain.issueFoul(initial, victim)
            : domain.applyGameEvent(initial, {
                type: "discipline.removal-observed",
                payload: {
                  seat: victim,
                  stage: "day-discussion",
                  rule: "6.2.3",
                  reason: "Fixture exclusion",
                  checkInProgress: false,
                },
              });
        const { rerender } = render(fixture(initial, style));
        expectFouls(victim, 3);
        rerender(fixture(removed, style));
        expect(card(victim)).toHaveAttribute("data-player-exit");
        expectNoFouls(card(victim));
        expect(card(victim).querySelector(".player-disciplinary-ribbon")).not.toBeNull();
        act(() => vi.runAllTimers());
        expectNoFouls(card(victim));
        rerender(fixture(removed, style, { completed: true, privacyHidden: true }));
        expectFouls(victim, cause === "fourth-foul" ? 4 : 3);
        expect(card(victim)).not.toHaveAttribute("data-departure-cause");
      },
    );

    it("retains dots through private/provisional shooting and pending morning goodbye", () => {
      let initial = day();
      const victim = initial.players.find((player) => player.role === "citizen")!.seat;
      initial = domain.issueFoul(initial, victim);
      const night = domain.beginNight(initial);
      const result = domain.resolveMafiaShots(
        domain.toggleAllMafiaShotsForTarget(night, victim),
      ).game;
      const applied = domain.completeMafiaShots(result);
      const afterDon = applied.phase === "night-don" ? domain.skipDonCheck(applied) : applied;
      const afterSheriff =
        afterDon.phase === "night-sheriff" ? domain.skipSheriffCheck(afterDon) : afterDon;
      const goodbye = domain.completeNight(afterSheriff);
      const { rerender } = render(fixture(night, style));
      for (const game of [result, applied, afterDon, afterSheriff, goodbye]) {
        rerender(fixture(game, style, { provisionalDeceased: game !== goodbye }));
        expectFouls(victim, 1);
        expect(card(victim)).not.toHaveAttribute("data-player-exit");
      }
      rerender(fixture(domain.completeGoodbyeSpeech(goodbye), style));
      expectNoFouls(card(victim));
    });
  },
);
