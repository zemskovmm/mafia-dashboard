import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginNight,
  createGameLogEntry,
  createInitialGameBaseline,
  replayGameLog,
  type GameState,
  type ReplayFrame,
} from "@mafia/game-domain";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { DEFAULT_PLAYER_EXIT_SETTINGS } from "../effects/player-exit-preferences.js";
import { createSampleGameHistory } from "../timeline/sample-game-data.js";
import { PlayerExitProvider, usePlayerExits } from "./PlayerExitProvider.js";
import { projectPlayerActions } from "./player-action-presentation.js";

const reasons = [
  ["voted-out", "vote"],
  ["mafia-kill", "mafia"],
  ["other", "unknown"],
] as const;
const Probe = () => (
  <output data-testid="departure-state">{JSON.stringify(usePlayerExits())}</output>
);
const view = (game: GameState, frames: readonly ReplayFrame[], live = true) => (
  <FancyFeaturesContext.Provider value={true}>
    <PlayerExitProvider
      game={game}
      live={live}
      privacyHidden
      settings={DEFAULT_PLAYER_EXIT_SETTINGS}
      presentation={projectPlayerActions(frames, game)}
    >
      <Probe />
    </PlayerExitProvider>
  </FancyFeaturesContext.Provider>
);
const read = () => JSON.parse(screen.getByTestId("departure-state").textContent!);
afterEach(() => vi.useRealTimers());

describe.each([false, true])("manual departure lifecycle (night=%s)", (night) => {
  it.each(reasons)(
    "animates accepted %s privately once, then restores Undo/reload/preview without cues",
    (reason, cause) => {
      vi.useFakeTimers();
      const day = createSampleGameHistory().frames.find(
        ({ after }) => after.phase === "day",
      )!.after;
      const initial = night ? beginNight(day) : day;
      const seat = initial.players.find((player) => player.role === "citizen")!.seat;
      const checkpoint = createGameLogEntry({
        gameId: "manual-presentation",
        id: "checkpoint",
        sequence: 1,
        parentEventId: null,
        createdAt: "2026-11-12T12:00:00.000Z",
        before: initial,
        draft: { type: "game.checkpointed", payload: {} },
      });
      const accepted = createGameLogEntry({
        gameId: "manual-presentation",
        id: "manual-removal",
        sequence: 2,
        parentEventId: checkpoint.entry.id,
        createdAt: "2026-11-12T12:00:01.000Z",
        before: checkpoint.after,
        draft: { type: "player.manually-removed", payload: { seat, reason } },
      });
      const baseline = createInitialGameBaseline(initial);
      const prefix = replayGameLog(baseline, [checkpoint.entry]);
      const replay = replayGameLog(baseline, [checkpoint.entry, accepted.entry]);
      const bytes = JSON.stringify(replay);
      const mounted = render(view(prefix.game, prefix.frames));
      expect(read().requests).toEqual({});
      mounted.rerender(view(replay.game, replay.frames));
      expect(read().requests[seat]).toMatchObject({ cause, hideRole: true, fromFaceDown: true });
      expect(read().endpoints).toEqual({ [seat]: cause });
      expect(read().pendingDepartures).not.toContain(seat);
      expect(read().waiting).not.toContain(seat);
      expect(read().feedback).toEqual({});
      expect(read().adjudication).toBeUndefined();
      const id = read().requests[seat].id;
      mounted.rerender(view({ ...replay.game }, [...replay.frames]));
      expect(read().requests[seat].id).toBe(id);
      mounted.unmount();

      // Undo changes GameScreen generation; restoration starts from its admitted prefix.
      const undone = render(view(prefix.game, prefix.frames));
      expect(read().requests).toEqual({});
      expect(read().endpoints).toEqual({});
      undone.unmount();
      const restored = JSON.parse(bytes) as typeof replay;
      const reloaded = render(view(restored.game, restored.frames));
      expect(read().requests).toEqual({});
      expect(read().feedback).toEqual({});
      expect(read().endpoints).toEqual({ [seat]: cause });
      reloaded.unmount();
      const preview = render(view(replay.game, replay.frames, false));
      expect(read().requests).toEqual({});
      expect(read().endpoints).toEqual({ [seat]: cause });
      preview.unmount();
      expect(JSON.stringify(replay)).toBe(bytes);
    },
  );
});
