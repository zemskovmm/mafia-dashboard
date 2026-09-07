import { describe, expect, it, vi } from "vitest";
import {
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSetup,
  drawRoleForSeat,
  type GameLogEntry,
} from "@mafia/game-domain";
import { ApiError, type GameSessionState } from "./api/client.js";
import { withBrowserGameStorageGuard } from "./browser-game-storage-lock.js";
import { GameSessionOutbox, gameSessionStorageKey } from "./session-outbox.js";

const clubId = "00000000-0000-4000-8000-000000000101";
const gameId = "00000000-0000-4000-8000-000000000201";

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const setupPlayers = Array.from({ length: 10 }, (_, index) => ({
  id: `00000000-0000-4000-8000-0000000005${String(index + 1).padStart(2, "0")}`,
  name: `Player ${index + 1}`,
  seat: index + 1,
}));

const emptyPlayerSetup = () => ({
  step: "players" as const,
  hostPlayerId: "",
  selectedPlayerIds: Array.from({ length: 10 }, () => ""),
  setup: null,
});

const roleDrawSetup = () => ({
  step: "roles" as const,
  hostPlayerId: "00000000-0000-4000-8000-000000000511",
  selectedPlayerIds: setupPlayers.map(({ id }) => id),
  setup: beginRoleDraw(createSetup(setupPlayers), () => 0),
});

const playedGame = () => {
  let setup = beginRoleDraw(createSetup(setupPlayers), () => 0);
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return createGame(completeRoleDraw(setup));
};

const completeState = (playlistId = "PL-current"): GameSessionState => ({
  setup: emptyPlayerSetup(),
  game: null,
  hostPlayerId: null,
  hostName: null,
  playlistId,
  log: [{ type: "ui.note", value: playlistId }],
  undoHistory: [{ before: "draft" }],
  undoBudget: 2,
  initialGame: null,
  events: [],
  headEventId: null,
  resetReturnEventId: null,
  legacyLog: [{ type: "activity", value: playlistId }],
});

const eventState = (sequence = 1, game = gameId): GameSessionState => ({
  ...completeState(`PL-event-${sequence}`),
  initialGame: null,
  events: [
    {
      replayVersion: 1,
      id: `00000000-0000-4000-8000-0000000004${String(sequence).padStart(2, "0")}`,
      gameId: game,
      sequence,
      parentEventId: null,
      type: "game.checkpointed",
      payload: {},
      phaseBefore: "day",
      phaseAfter: "day",
      dayBefore: 1,
      dayAfter: 1,
      stateHashAfter: `sha256:${sequence.toString(16).padStart(64, "0")}`,
      createdAt: "2026-09-05T12:00:00.000Z",
    } as unknown as GameLogEntry,
  ],
  headEventId: `00000000-0000-4000-8000-0000000004${String(sequence).padStart(2, "0")}`,
});

const ids = (...values: string[]) => {
  const valuesToReturn = [...values];
  return () => valuesToReturn.shift() ?? "00000000-0000-4000-8000-000000000999";
};

const readPersisted = (storage: Storage) =>
  JSON.parse(storage.getItem(gameSessionStorageKey) ?? "null") as Record<string, unknown>;

const currentEnvelope = (state: GameSessionState, ownerGameId = gameId) =>
  JSON.stringify({
    version: 5,
    clubId,
    gameId: ownerGameId,
    revision: 0,
    claimGeneration: 0,
    current: { name: "Current table", state, results: null },
    outbox: [],
    failed: false,
    clearFailed: false,
    clearingGameId: null,
  });

describe("GameSessionOutbox current-v5 persistence", () => {
  it("persists the entire current snapshot without deriving or stripping setup, log, or drafts", () => {
    const storage = memoryStorage();
    const state = completeState();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId, "00000000-0000-4000-8000-000000000301"),
      save: vi.fn(),
    });

    outbox.enqueue("Draft table", state, null);

    expect(outbox.current).toEqual({ name: "Draft table", state, results: null });
    expect(readPersisted(storage)).toMatchObject({
      version: 5,
      clubId,
      gameId,
      current: { name: "Draft table", state, results: null },
      outbox: [
        {
          kind: "snapshot",
          name: "Draft table",
          baseRevision: 0,
          state,
          results: null,
        },
      ],
    });
  });

  it("uses only full snapshot operations and replaces stale queued snapshots", () => {
    const storage = memoryStorage();
    const save = vi.fn().mockResolvedValue({ revision: 1, duplicate: false });
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(
        gameId,
        "00000000-0000-4000-8000-000000000302",
        "00000000-0000-4000-8000-000000000303",
      ),
      save,
    });

    outbox.enqueue("Table", completeState("PL-first"), null);
    outbox.enqueue("Table", completeState("PL-second"), null);

    expect(outbox.pendingCount).toBe(1);
    expect(readPersisted(storage).outbox).toEqual([
      expect.objectContaining({
        kind: "snapshot",
        baseRevision: 0,
        state: completeState("PL-second"),
      }),
    ]);
  });

  it("keeps an in-flight snapshot and queues the latest snapshot after it", async () => {
    const storage = memoryStorage();
    const firstSave = deferred<{ revision: number; duplicate: boolean }>();
    const save = vi.fn().mockImplementation(() => firstSave.promise);
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(
        gameId,
        "00000000-0000-4000-8000-000000000304",
        "00000000-0000-4000-8000-000000000305",
      ),
      save,
    });
    outbox.enqueue("Table", completeState("PL-first"), null);
    const flushing = outbox.flush();
    outbox.enqueue("Table", completeState("PL-second"), null);

    expect(readPersisted(storage).outbox).toEqual([
      expect.objectContaining({ baseRevision: 0, state: completeState("PL-first") }),
      expect.objectContaining({ baseRevision: 1, state: completeState("PL-second") }),
    ]);
    firstSave.resolve({ revision: 1, duplicate: false });
    await flushing;
    expect(save).toHaveBeenCalledTimes(2);
    expect(outbox.current?.state).toEqual(completeState("PL-second"));
    expect(outbox.pendingCount).toBe(0);
  });

  it("does not overwrite a newer raw record after a stale save completes", async () => {
    const storage = memoryStorage();
    const firstSave = deferred<{ revision: number; duplicate: boolean }>();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId, "00000000-0000-4000-8000-000000000306"),
      save: () => firstSave.promise,
    });
    outbox.enqueue("Old table", completeState("PL-old"), null);
    const flushing = outbox.flush();
    const newerRaw = JSON.stringify({
      version: 5,
      clubId,
      gameId,
      revision: 9,
      claimGeneration: 0,
      current: { name: "New table", state: completeState("PL-new"), results: null },
      outbox: [],
      failed: false,
      clearFailed: false,
      clearingGameId: null,
    });
    storage.setItem(gameSessionStorageKey, newerRaw);
    firstSave.resolve({ revision: 1, duplicate: false });

    await flushing;
    expect(storage.getItem(gameSessionStorageKey)).toBe(newerRaw);
    expect(outbox.current?.name).toBe("New table");
  });

  it("preserves a newer browser record when a stale remote clear completes", async () => {
    const storage = memoryStorage();
    const remoteClear = deferred<void>();
    const stale = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId, "00000000-0000-4000-8000-000000000307"),
      save: vi.fn(),
    });
    stale.restore(gameId, 3, "Old table", completeState("PL-old"), null);
    const clearing = stale.clear(() => remoteClear.promise);
    const replacementGameId = "00000000-0000-4000-8000-000000000202";
    const active = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids("00000000-0000-4000-8000-000000000308"),
      save: vi.fn(),
    });
    active.replaceAfterTakeover(
      replacementGameId,
      7,
      "New table",
      completeState("PL-new"),
      null,
      2,
    );
    remoteClear.resolve();

    await clearing;
    expect(stale.gameId).toBe(replacementGameId);
    expect(readPersisted(storage)).toMatchObject({ gameId: replacementGameId });
  });

  it.each([
    new Error("offline"),
    new ApiError("rejected", 400, "validation_failed", {
      issues: [
        {
          path: "state.events",
          message: "Invalid value",
          diagnostic: { code: "history.hash_mismatch", eventIndex: 0, replayIndex: 0 },
        },
      ],
    }),
  ])("retains a failed current snapshot across rejected retries: %s", async (failure) => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId, "00000000-0000-4000-8000-000000000309"),
      save: vi.fn().mockRejectedValue(failure),
    });
    outbox.enqueue("Offline table", completeState(), null);

    await expect(outbox.flush()).rejects.toBe(failure);
    const persistedFailure = storage.getItem(gameSessionStorageKey);
    await expect(outbox.flush()).rejects.toBe(failure);
    expect(storage.getItem(gameSessionStorageKey)).toBe(persistedFailure);
    expect(outbox.status).toBe("offline");
    expect(outbox.pendingCount).toBe(1);
    expect(readPersisted(storage)).toMatchObject({
      failed: true,
      current: { name: "Offline table" },
    });
  });

  it("requires the browser storage guard for guarded writes", async () => {
    const storage = memoryStorage();
    let outbox: GameSessionOutbox | null = null;
    await withBrowserGameStorageGuard((storageGuard) => {
      outbox = new GameSessionOutbox({
        storage,
        storageGuard,
        clubId,
        createId: ids(gameId, "00000000-0000-4000-8000-000000000310"),
        save: vi.fn(),
      });
      outbox.enqueue("Locked table", completeState(), null);
    });

    expect(() => outbox?.enqueue("Late table", completeState("PL-late"), null)).toThrow(
      "Browser game storage lock is not held",
    );
  });

  it("rejects malformed current storage without replacing its raw bytes", () => {
    const storage = memoryStorage();
    const raw = '{"version":5,"current":{}}';
    storage.setItem(gameSessionStorageKey, raw);

    expect(
      () => new GameSessionOutbox({ storage, clubId, createId: vi.fn(), save: vi.fn() }),
    ).toThrow("Browser game storage is invalid");
    expect(storage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it("rejects historical eight-hex event hashes from a current-v5 snapshot", () => {
    const storage = memoryStorage();
    const state = eventState();
    const raw = currentEnvelope({
      ...state,
      events: [{ ...state.events![0]!, stateHashAfter: "deadbeef" }],
    });
    storage.setItem(gameSessionStorageKey, raw);

    expect(
      () => new GameSessionOutbox({ storage, clubId, createId: vi.fn(), save: vi.fn() }),
    ).toThrow("Browser game storage is invalid");
    expect(storage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it.each([
    ["a retired event type", { type: "speech.started" }],
    ["a retired checkpoint payload", { payload: { sequence: 1 } }],
    ["an unsupported event field", { idempotencyKey: "old-key" }],
  ])("rejects %s without rewriting the current record", (_label, patch) => {
    const storage = memoryStorage();
    const state = eventState();
    const raw = currentEnvelope({
      ...state,
      events: [{ ...state.events![0]!, ...patch } as GameLogEntry],
    });
    storage.setItem(gameSessionStorageKey, raw);

    expect(
      () => new GameSessionOutbox({ storage, clubId, createId: vi.fn(), save: vi.fn() }),
    ).toThrow("Browser game storage is invalid");
    expect(storage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it("rejects current events that belong to a different game than the durable owner", () => {
    const storage = memoryStorage();
    const raw = currentEnvelope(eventState(1, "00000000-0000-4000-8000-000000000202"));
    storage.setItem(gameSessionStorageKey, raw);

    expect(
      () => new GameSessionOutbox({ storage, clubId, createId: vi.fn(), save: vi.fn() }),
    ).toThrow("Browser game storage is invalid");
    expect(storage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it.each([
    ["an empty game object", { ...completeState(), game: {} }],
    ["an empty setup object", { ...completeState(), setup: {} }],
  ])("rejects %s instead of passing it into the workspace", (_label, state) => {
    const storage = memoryStorage();
    const raw = currentEnvelope(state);
    storage.setItem(gameSessionStorageKey, raw);

    expect(
      () => new GameSessionOutbox({ storage, clubId, createId: vi.fn(), save: vi.fn() }),
    ).toThrow("Browser game storage is invalid");
    expect(storage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it("accepts the player and role-draw snapshots emitted by the setup UI", () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId),
      save: vi.fn(),
    });
    const state = { ...completeState(), setup: roleDrawSetup(), game: playedGame() };

    outbox.enqueue("Usable snapshot", state, null);
    expect(outbox.current?.state).toEqual(state);
  });

  it.each([
    ["a null setup", { ...completeState(), setup: null }],
    ["an empty player-selection draft", { ...completeState(), setup: emptyPlayerSetup() }],
    ["a null game draft", { ...completeState(), game: null }],
    ["an empty activity log", { ...completeState(), log: [], legacyLog: [] }],
  ])("keeps %s exactly in the current snapshot", (_label, state) => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId, "00000000-0000-4000-8000-000000000311"),
      save: vi.fn(),
    });
    outbox.enqueue("Draft", state, null);

    expect(outbox.current?.state).toEqual(state);
    expect((readPersisted(storage).current as { state: GameSessionState }).state).toEqual(state);
  });

  it("keeps current head, reset return, undo budget, and live legacy activity authoritative", () => {
    const storage = memoryStorage();
    const state = {
      ...eventState(),
      undoBudget: 3,
      resetReturnEventId: "00000000-0000-4000-8000-000000000499",
      legacyLog: [{ type: "activity", value: "live" }],
    };
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId, "00000000-0000-4000-8000-000000000312"),
      save: vi.fn(),
    });
    outbox.enqueue("Head table", state, null);

    expect(outbox.current?.state).toEqual(state);
    expect(readPersisted(storage)).toMatchObject({ current: { state } });
  });

  it("retains claim generation through a durable claim update", () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId, "00000000-0000-4000-8000-000000000313"),
      save: vi.fn(),
    });
    outbox.enqueue("Claimed", completeState(), null);
    outbox.setClaimGeneration(4);

    expect(outbox.claimGeneration).toBe(4);
    expect(readPersisted(storage)).toMatchObject({ claimGeneration: 4 });
  });

  it("rebinds a failed outbox to a takeover claim without dropping its snapshot", async () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId, "00000000-0000-4000-8000-000000000314"),
      save: vi.fn().mockRejectedValue(new Error("offline")),
    });
    outbox.enqueue("Takeover", completeState(), null);
    await expect(outbox.flush()).rejects.toThrow("offline");
    outbox.rebindClaimGeneration(5);

    expect(outbox.status).toBe("saving");
    expect(outbox.claimGeneration).toBe(5);
    expect(outbox.current?.name).toBe("Takeover");
    expect(outbox.pendingCount).toBe(1);
  });

  it("replaces a completed owner only through explicit takeover", () => {
    const storage = memoryStorage();
    const first = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId),
      save: vi.fn(),
    });
    first.restore(gameId, 2, "First", completeState("PL-first"), null, 1);
    const nextGame = "00000000-0000-4000-8000-000000000202";

    expect(() => first.restore(nextGame, 3, "Second", completeState("PL-second"), null, 2)).toThrow(
      "different game",
    );
    first.replaceAfterTakeover(nextGame, 3, "Second", completeState("PL-second"), null, 2);
    expect(first.current).toEqual({
      name: "Second",
      state: completeState("PL-second"),
      results: null,
    });
  });

  it("does not clear a current game until its remote clear succeeds", async () => {
    const storage = memoryStorage();
    const clear = deferred<void>();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId),
      save: vi.fn(),
    });
    outbox.restore(gameId, 2, "Clear me", completeState(), null, 1);
    const clearing = outbox.clear(() => clear.promise);

    expect(outbox.status).toBe("clearing");
    expect(outbox.current?.name).toBe("Clear me");
    clear.resolve();
    await clearing;
    expect(outbox.current).toBeNull();
    expect(storage.getItem(gameSessionStorageKey)).toBeNull();
  });

  it("retains a current game and exposes clear failure for retry", async () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(gameId), save: vi.fn() });
    outbox.restore(gameId, 2, "Keep me", completeState(), null, 1);

    await expect(outbox.clear(() => Promise.reject(new Error("offline")))).rejects.toThrow(
      "offline",
    );
    expect(outbox.current?.name).toBe("Keep me");
    expect(outbox.clearFailed).toBe(true);
  });

  it("notifies listeners for enqueue, failure, claim, and clear lifecycle changes", async () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId),
      save: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const listener = vi.fn();
    const unsubscribe = outbox.subscribe(listener);
    outbox.enqueue("Observed", completeState(), null);
    await expect(outbox.flush()).rejects.toThrow("offline");
    outbox.setClaimGeneration(2);
    unsubscribe();

    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects incomplete snapshots instead of manufacturing missing current fields", () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(gameId), save: vi.fn() });

    expect(() => outbox.enqueue("Incomplete", { setup: null } as GameSessionState, null)).toThrow(
      "Invalid current game session state",
    );
    expect(storage.getItem(gameSessionStorageKey)).toBeNull();
  });

  it("rejects cross-game events before a stale snapshot can overwrite the owner", () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(gameId), save: vi.fn() });
    const otherGame = "00000000-0000-4000-8000-000000000202";

    expect(() => outbox.enqueue("Wrong event", eventState(1, otherGame), null)).toThrow(
      "different durable game",
    );
    expect(storage.getItem(gameSessionStorageKey)).toBeNull();
  });

  it("does not create a record when clearing an empty browser", async () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(gameId), save: vi.fn() });

    await outbox.clear(vi.fn());
    expect(storage.getItem(gameSessionStorageKey)).toBeNull();
  });

  it("surfaces storage write failure without claiming durability", () => {
    const storage = memoryStorage();
    storage.setItem = vi.fn(() => {
      throw new Error("quota exceeded");
    });
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(gameId), save: vi.fn() });

    expect(() => outbox.enqueue("Quota", completeState(), null)).toThrow("quota exceeded");
    expect(outbox.pendingCount).toBe(1);
  });

  it("surfaces storage removal failure after remote clear instead of pretending it completed", async () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(gameId), save: vi.fn() });
    outbox.restore(gameId, 2, "Removal", completeState(), null, 1);
    storage.removeItem = vi.fn(() => {
      throw new Error("remove failed");
    });

    await expect(outbox.clear(() => Promise.resolve())).rejects.toThrow("remove failed");
    expect(storage.getItem(gameSessionStorageKey)).not.toBeNull();
  });
});
