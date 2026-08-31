import { describe, expect, it, vi } from "vitest";
import {
  advanceSetupPhase,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "@mafia/game-domain";
import type { GameSessionState } from "./api/client.js";
import { GameSessionOutbox, type SessionSaveResponse } from "./session-outbox.js";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

const state = (playlistId: string) => ({
  setup: null,
  game: null,
  hostPlayerId: null,
  hostName: null,
  playlistId,
  log: [],
  undoHistory: [],
  undoBudget: 0,
  initialGame: null,
  events: [],
  headEventId: null,
  resetReturnEventId: null,
  legacyLog: [],
});

const canonicalGame = () => {
  const players = Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(41));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  const game = createGame(completeRoleDraw(setup));
  return { ...advanceSetupPhase(advanceSetupPhase(game)), day: 2 };
};

const resetReturnScenario = () => {
  const gameId = "00000000-0000-4000-8000-000000000801";
  const mutationId = "00000000-0000-4000-8000-000000000802";
  const game = { ...canonicalGame(), phase: "finished" as const, winner: "red" as const };
  const baseline = { replayVersion: 1 as const, game };
  const root = createGameLogEntry({
    gameId,
    id: "00000000-0000-4000-8000-000000000803",
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    before: game,
    draft: { type: "game.checkpointed", payload: {} },
  });
  const returned = createGameLogEntry({
    gameId,
    id: "00000000-0000-4000-8000-000000000804",
    sequence: 2,
    parentEventId: root.entry.id,
    createdAt: "2026-08-30T00:01:00.000Z",
    before: root.after,
    draft: { type: "game.completed", payload: { winner: "red" } },
  });
  const sessionState = (
    headEventId: string,
    resetReturnEventId: string | null,
    materializedGame: unknown,
  ): GameSessionState => ({
    ...state("PL-reset"),
    game: materializedGame,
    hostPlayerId: "host-player",
    initialGame: baseline,
    events: [root.entry, returned.entry],
    headEventId,
    resetReturnEventId,
  });
  return { gameId, mutationId, root, returned, sessionState };
};

const normalizationResponse = (
  gameId: string,
  revision: number,
  name = "Legacy table",
  playlistId = "PL-old",
): SessionSaveResponse => {
  const game = canonicalGame();
  const eventId = "00000000-0000-4000-8000-000000000900";
  const started = createGameLogEntry({
    gameId,
    id: eventId,
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    before: game,
    draft: { type: "game.checkpointed", payload: {} },
  });
  return {
    gameId,
    name,
    revision,
    duplicate: false,
    state: {
      ...state(playlistId),
      initialGame: { replayVersion: 1, game },
      events: [started.entry],
      headEventId: eventId,
    } as unknown as GameSessionState,
    results: null,
  };
};

describe("GameSessionOutbox", () => {
  it("persists and uploads the complete browser snapshot without replacing its game from a response", async () => {
    const storage = memoryStorage();
    let nextId = 810;
    const save = vi.fn().mockResolvedValue({ revision: 9, duplicate: false });
    const outbox = new GameSessionOutbox({
      storage,
      createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
      save,
    });
    const game = canonicalGame();
    const snapshot = { ...state("PL-authoritative"), game };

    outbox.enqueue("Browser table", snapshot, null);

    expect(outbox.current?.state.game).toEqual(game);
    await outbox.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kind: "snapshot",
        state: expect.objectContaining({ game }),
        results: null,
      }),
    );
    expect(outbox.current?.state.game).toEqual(game);
  });

  it("reissues a still-desired browser snapshot with a fresh mutation ID after an older duplicate", async () => {
    const storage = memoryStorage();
    const ids = [
      "00000000-0000-4000-8000-000000000820",
      "00000000-0000-4000-8000-000000000821",
      "00000000-0000-4000-8000-000000000822",
    ];
    const local = state("PL-local");
    const remote = state("PL-remote");
    const save = vi
      .fn()
      .mockResolvedValueOnce({
        gameId: "00000000-0000-4000-8000-000000000820",
        name: "Remote table",
        revision: 8,
        duplicate: true,
        state: remote,
        results: null,
      })
      .mockResolvedValueOnce({ revision: 9, duplicate: false });
    const outbox = new GameSessionOutbox({
      storage,
      createId: () => ids.shift()!,
      save,
    });

    outbox.enqueue("Local table", local, null);
    await outbox.flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]?.[1]).toMatchObject({
      mutationId: "00000000-0000-4000-8000-000000000821",
      state: local,
    });
    expect(save.mock.calls[1]?.[1]).toMatchObject({
      mutationId: "00000000-0000-4000-8000-000000000822",
      baseRevision: 8,
      state: local,
    });
    expect(outbox.current).toMatchObject({ name: "Local table", state: local });
    expect(outbox.pendingCount).toBe(0);
  });

  it("migrates a branch-preserving v4 envelope to one authoritative snapshot prefix", () => {
    const storage = memoryStorage();
    const { gameId, root, returned, sessionState } = resetReturnScenario();
    storage.setItem(
      "mafia-dashboard.game-session.v4",
      JSON.stringify({
        version: 4,
        gameId,
        revision: 5,
        name: "Legacy reset table",
        metadata: {
          setup: null,
          hostPlayerId: "host-player",
          hostName: null,
          playlistId: "PL-reset",
          legacyLog: [],
        },
        baseline: sessionState(root.entry.id, returned.entry.id, root.after).initialGame,
        entries: [root.entry, returned.entry],
        headEventId: root.entry.id,
        resetReturnEventId: returned.entry.id,
        results: null,
        outbox: [],
        failed: false,
        clearFailed: false,
        clearingGameId: null,
      }),
    );

    const outbox = new GameSessionOutbox({
      storage,
      createId: () => "00000000-0000-4000-8000-000000000805",
      save: vi.fn(),
    });

    expect(outbox.current).toMatchObject({
      state: {
        game: root.after,
        events: [root.entry],
        headEventId: root.entry.id,
        resetReturnEventId: null,
      },
    });
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4")!)).toMatchObject({
      game: root.after,
      entries: [root.entry],
      resetReturnEventId: null,
      outbox: [expect.objectContaining({ kind: "snapshot", baseRevision: 5 })],
    });
  });

  it("prunes a legacy remote Reset Return while restoring its browser-authoritative snapshot", () => {
    const storage = memoryStorage();
    const { gameId, root, returned, sessionState } = resetReturnScenario();
    const outbox = new GameSessionOutbox({
      storage,
      createId: () => "00000000-0000-4000-8000-000000000806",
      save: vi.fn(),
    });

    outbox.restore(
      gameId,
      5,
      "Remote reset table",
      sessionState(root.entry.id, returned.entry.id, root.after),
      null,
    );

    expect(outbox.current).toMatchObject({
      state: {
        game: root.after,
        events: [root.entry],
        resetReturnEventId: null,
      },
    });
    expect(outbox.pendingCount).toBe(1);
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4")!)).toMatchObject({
      entries: [root.entry],
      resetReturnEventId: null,
      outbox: [expect.objectContaining({ kind: "snapshot", baseRevision: 5 })],
    });
  });

  it("coalesces canonical game changes into the latest full browser snapshot", () => {
    const storage = memoryStorage();
    const ids = [
      "00000000-0000-4000-8000-000000000901",
      "00000000-0000-4000-8000-000000000902",
      "00000000-0000-4000-8000-000000000903",
      "00000000-0000-4000-8000-000000000904",
    ];
    const outbox = new GameSessionOutbox({
      storage,
      createId: () => ids.shift()!,
      save: vi.fn(),
    });
    const game = canonicalGame();
    const baseline = { replayVersion: 1 as const, game };
    const started = createGameLogEntry({
      gameId: "00000000-0000-4000-8000-000000000901",
      id: "00000000-0000-4000-8000-000000000911",
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-25T00:00:00.000Z",
      before: game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    const turn = createGameLogEntry({
      gameId: "00000000-0000-4000-8000-000000000901",
      id: "00000000-0000-4000-8000-000000000912",
      sequence: 2,
      parentEventId: started.entry.id,
      createdAt: "2026-08-25T00:01:00.000Z",
      before: started.after,
      draft: {
        type: "turn.completed",
        payload: { seat: started.after.turnOrder[0]! },
      },
    });
    const canonicalState = (events: readonly { readonly id: string }[]) =>
      ({
        ...state("PL-replay"),
        game: events.length === 1 ? started.after : turn.after,
        initialGame: baseline,
        events,
        headEventId: events.at(-1)?.id ?? null,
        resetReturnEventId: null,
        legacyLog: [],
      }) as unknown as Parameters<GameSessionOutbox["enqueue"]>[1];

    outbox.enqueue("Replay table", canonicalState([started.entry]), null);
    outbox.enqueue("Replay table", canonicalState([started.entry, turn.entry]), null);

    const persisted = JSON.parse(storage.getItem("mafia-dashboard.game-session.v4") ?? "null") as {
      version: number;
      outbox: readonly Record<string, unknown>[];
    } | null;
    expect(persisted?.version).toBe(4);
    expect(persisted?.outbox).toHaveLength(1);
    expect(persisted?.outbox[0]).toMatchObject({
      kind: "snapshot",
      state: {
        game: turn.after,
        events: [started.entry, turn.entry],
        headEventId: turn.entry.id,
      },
    });
  });

  it("drains pending v3 mutations unchanged before uploading one authoritative snapshot", async () => {
    const storage = memoryStorage();
    const legacyKey = "pending-session.v3";
    const storageKey = "pending-session.v4";
    const gameId = "00000000-0000-4000-8000-000000000931";
    const mutation = {
      name: "Offline table",
      mutationId: "00000000-0000-4000-8000-000000000932",
      baseRevision: 4,
      state: state("PL-offline"),
      results: null,
    };
    storage.setItem(
      legacyKey,
      JSON.stringify({
        version: 3,
        gameId,
        revision: 4,
        current: { name: mutation.name, state: mutation.state, results: null },
        outbox: [mutation],
        failed: true,
        clearFailed: false,
        clearingGameId: null,
      }),
    );
    const saveLegacy = vi.fn().mockResolvedValue({ revision: 5, duplicate: false });
    const save = vi
      .fn()
      .mockResolvedValue(normalizationResponse(gameId, 6, mutation.name, "PL-offline"));
    const outbox = new GameSessionOutbox({
      storage,
      storageKey,
      legacyStorageKey: legacyKey,
      createId: () => "00000000-0000-4000-8000-000000000933",
      save,
      saveLegacy,
    } as unknown as ConstructorParameters<typeof GameSessionOutbox>[0]);

    expect(outbox.current).toMatchObject({ name: mutation.name, state: mutation.state });
    await outbox.flush();

    expect(saveLegacy).toHaveBeenCalledWith(gameId, mutation);
    expect(save).toHaveBeenCalledWith(
      gameId,
      expect.objectContaining({
        kind: "snapshot",
        baseRevision: 5,
        state: mutation.state,
      }),
    );
    expect(storage.getItem(legacyKey)).toBeNull();
    expect(JSON.parse(storage.getItem(storageKey) ?? "null")).toMatchObject({
      version: 4,
      revision: 6,
      outbox: [],
    });
  });

  it("keeps pending v3 mutations authoritative when setup reasserts the game ID", () => {
    const storage = memoryStorage();
    const legacyKey = "pending-identity.v3";
    const storageKey = "pending-identity.v4";
    const gameId = "00000000-0000-4000-8000-000000000991";
    const mutation = {
      name: "Offline identity table",
      mutationId: "00000000-0000-4000-8000-000000000992",
      baseRevision: 4,
      state: state("PL-identity"),
      results: null,
    };
    storage.setItem(
      legacyKey,
      JSON.stringify({
        version: 3,
        gameId,
        revision: 4,
        current: { name: mutation.name, state: mutation.state, results: null },
        outbox: [mutation],
        failed: false,
        clearFailed: false,
        clearingGameId: null,
      }),
    );
    const outbox = new GameSessionOutbox({
      storage,
      storageKey,
      legacyStorageKey: legacyKey,
      createId: () => "00000000-0000-4000-8000-000000000993",
      save: vi.fn(),
      saveLegacy: vi.fn(),
    } as unknown as ConstructorParameters<typeof GameSessionOutbox>[0]);

    outbox.ensureGameId(gameId);

    expect(storage.getItem(storageKey)).toBeNull();
    expect(JSON.parse(storage.getItem(legacyKey) ?? "null")).toMatchObject({
      gameId,
      outbox: [mutation],
    });
    expect(outbox.pendingCount).toBe(1);
  });

  it("keeps local session state isolated by club storage key", () => {
    const storage = memoryStorage();
    const first = new GameSessionOutbox({
      storage,
      storageKey: "club-one",
      createId: () => "00000000-0000-4000-8000-000000000001",
      save: vi.fn(),
    });
    first.enqueue("Club one", state("one"), null);

    const second = new GameSessionOutbox({
      storage,
      storageKey: "club-two",
      createId: () => "00000000-0000-4000-8000-000000000002",
      save: vi.fn(),
    });
    expect(second.current).toBeNull();
  });

  it("rejects a malformed persisted v4 operation before it can be flushed", async () => {
    const storage = memoryStorage();
    const save = vi.fn();
    storage.setItem(
      "mafia-dashboard.game-session.v4",
      JSON.stringify({
        version: 4,
        gameId: "00000000-0000-4000-8000-000000000991",
        revision: 3,
        name: "Corrupt table",
        metadata: {
          setup: null,
          hostPlayerId: null,
          hostName: null,
          playlistId: "PL-corrupt",
          legacyLog: [],
        },
        baseline: null,
        entries: [],
        headEventId: null,
        resetReturnEventId: null,
        results: null,
        outbox: [{ kind: "metadata", baseRevision: 3 }],
        failed: false,
        clearFailed: false,
        clearingGameId: null,
      }),
    );

    const outbox = new GameSessionOutbox({ storage, createId: vi.fn(), save });

    expect(outbox.current).toBeNull();
    expect(outbox.pendingCount).toBe(0);
    await outbox.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects persisted canonical entries bound to another game", () => {
    const storage = memoryStorage();
    const storageKey = "cross-game-envelope.v4";
    const gameId = "00000000-0000-4000-8000-000000000971";
    const canonical = normalizationResponse(gameId, 1);
    const outbox = new GameSessionOutbox({
      storage,
      storageKey,
      createId: () => "00000000-0000-4000-8000-000000000973",
      save: vi.fn(),
    });
    outbox.restore(gameId, 1, canonical.name!, canonical.state!, canonical.results!);
    const persisted = JSON.parse(storage.getItem(storageKey) ?? "null") as {
      entries: { gameId: string }[];
    };
    persisted.entries[0]!.gameId = "00000000-0000-4000-8000-000000000972";
    storage.setItem(storageKey, JSON.stringify(persisted));

    const fresh = new GameSessionOutbox({
      storage,
      storageKey,
      createId: vi.fn(),
      save: vi.fn(),
    });
    expect(fresh.current).toBeNull();
  });

  it("rejects a malformed persisted v3 mutation before legacy migration", async () => {
    const storage = memoryStorage();
    const legacyKey = "malformed.v3";
    const saveLegacy = vi.fn();
    const missingGameState = Object.fromEntries(
      Object.entries(state("PL-corrupt")).filter(([key]) => key !== "game"),
    );
    storage.setItem(
      legacyKey,
      JSON.stringify({
        version: 3,
        gameId: "00000000-0000-4000-8000-000000000992",
        revision: 3,
        current: { name: "Corrupt legacy", state: state("PL-corrupt"), results: null },
        outbox: [
          {
            name: "Corrupt legacy",
            mutationId: "00000000-0000-4000-8000-000000000993",
            baseRevision: 3,
            state: missingGameState,
            results: null,
          },
        ],
        failed: false,
        clearFailed: false,
        clearingGameId: null,
      }),
    );

    const outbox = new GameSessionOutbox({
      storage,
      legacyStorageKey: legacyKey,
      createId: vi.fn(),
      save: vi.fn(),
      saveLegacy,
    });

    expect(outbox.current).toBeNull();
    expect(outbox.pendingCount).toBe(0);
    await outbox.flush();
    expect(saveLegacy).not.toHaveBeenCalled();
  });

  it("keeps a mutation durable when the save API returns an invalid response", async () => {
    const storage = memoryStorage();
    const ids = ["00000000-0000-4000-8000-000000000994", "00000000-0000-4000-8000-000000000995"];
    const outbox = new GameSessionOutbox({
      storage,
      createId: () => ids.shift()!,
      save: vi.fn().mockResolvedValue({ revision: 1, duplicate: "false" }),
    } as unknown as ConstructorParameters<typeof GameSessionOutbox>[0]);
    outbox.enqueue("Table", state("PL-pending"), null);

    await expect(outbox.flush()).rejects.toThrow("Invalid game session save response");

    expect(outbox.status).toBe("offline");
    expect(outbox.pendingCount).toBe(1);
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4") ?? "null")).toMatchObject({
      revision: 0,
      failed: true,
      outbox: [expect.objectContaining({ kind: "snapshot" })],
    });
  });

  it("does not queue a no-op when PostgreSQL JSONB reorders restored object keys", () => {
    const storage = memoryStorage();
    const createId = vi.fn(() => "00000000-0000-4000-8000-000000000099");
    const save = vi.fn();
    const outbox = new GameSessionOutbox({ storage, createId, save });
    const restoredState = {
      undoHistory: [],
      log: [],
      playlistId: "PL-restored",
      hostName: null,
      hostPlayerId: null,
      game: null,
      setup: null,
    };
    outbox.restore("00000000-0000-4000-8000-000000000090", 7, "Table", restoredState, null);

    outbox.enqueue(
      "Table",
      {
        setup: null,
        game: null,
        hostPlayerId: null,
        hostName: null,
        playlistId: "PL-restored",
        log: [],
        undoHistory: [],
      },
      null,
    );

    expect(outbox.pendingCount).toBe(0);
    expect(createId).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("adopts the server-allocated dated name for current and queued mutations", async () => {
    const storage = memoryStorage();
    const firstSave = deferred<SessionSaveResponse>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce({ revision: 2, duplicate: false, name: "12.02.26 #4" });
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ];
    const outbox = new GameSessionOutbox({ storage, createId: () => ids.shift()!, save });
    outbox.enqueue("12.02.26 #1", state("first"), null);
    const flush = outbox.flush();
    outbox.enqueue("12.02.26 #1", state("second"), null);

    firstSave.resolve({ revision: 1, duplicate: false, name: "12.02.26 #4" });
    await flush;

    expect(save.mock.calls[1]?.[1]).toMatchObject({ name: "12.02.26 #4" });
    expect(outbox.current?.name).toBe("12.02.26 #4");
  });

  it("reuses the client game UUID and first mutation after reload while its save is unresolved", async () => {
    const storage = memoryStorage();
    const firstSave = deferred<SessionSaveResponse>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce({ revision: 1, duplicate: true });
    const createId = vi
      .fn()
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const firstMount = new GameSessionOutbox({ storage, createId, save });
    firstMount.enqueue("Table", state("PL-one"), null);
    const unresolvedFlush = firstMount.flush();
    await Promise.resolve();

    const freshMount = new GameSessionOutbox({ storage, createId, save });
    await freshMount.flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
    expect(save.mock.calls[0]?.[0]).toBe("00000000-0000-4000-8000-000000000001");
    expect(save.mock.calls[0]?.[1]).toMatchObject({
      mutationId: "00000000-0000-4000-8000-000000000002",
      baseRevision: 0,
    });
    expect(createId).toHaveBeenCalledTimes(2);
    firstSave.resolve({ revision: 1, duplicate: false });
    await unresolvedFlush;
  });

  it("stays local-only when an older snapshot succeeds before the newer queued mutation fails", async () => {
    const storage = memoryStorage();
    const firstSave = deferred<SessionSaveResponse>();
    const newerSave = deferred<SessionSaveResponse>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => newerSave.promise);
    const ids = [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ];
    const outbox = new GameSessionOutbox({ storage, createId: () => ids.shift()!, save });
    outbox.enqueue("Table", state("older"), null);
    const flush = outbox.flush();
    outbox.enqueue("Table", state("newer"), null);

    expect(save).toHaveBeenCalledTimes(1);
    firstSave.resolve({ revision: 1, duplicate: false });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    newerSave.reject(new Error("offline"));
    await expect(flush).rejects.toThrow("offline");

    expect(outbox.status).toBe("offline");
    expect(outbox.pendingCount).toBe(1);
    expect(outbox.current?.state).toEqual(state("newer"));
  });

  it("does not let a stale StrictMode instance erase a newer durable mutation", async () => {
    const storage = memoryStorage();
    const firstSave = deferred<SessionSaveResponse>();
    const duplicateSave = deferred<SessionSaveResponse>();
    const newerSave = deferred<SessionSaveResponse>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => duplicateSave.promise)
      .mockImplementationOnce(() => newerSave.promise);
    const ids = [
      "00000000-0000-4000-8000-000000000030",
      "00000000-0000-4000-8000-000000000031",
      "00000000-0000-4000-8000-000000000032",
    ];
    const createId = () => ids.shift()!;
    const staleMount = new GameSessionOutbox({ storage, createId, save });
    staleMount.enqueue("Table", state("first"), null);
    const staleFlush = staleMount.flush();
    const activeMount = new GameSessionOutbox({ storage, createId, save });
    const activeFlush = activeMount.flush();
    activeMount.enqueue("Table", state("newer"), null);

    firstSave.resolve({ revision: 1, duplicate: false });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(3));

    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4") ?? "null")).toMatchObject({
      revision: 1,
      name: "Table",
      metadata: { playlistId: "newer" },
      outbox: [expect.objectContaining({ baseRevision: 1, kind: "snapshot" })],
    });

    newerSave.resolve({ revision: 2, duplicate: false });
    await staleFlush;
    duplicateSave.resolve({ revision: 1, duplicate: true });
    await activeFlush;
    expect(save).toHaveBeenCalledTimes(3);
    expect(activeMount.status).toBe("saved");
    expect(activeMount.current?.state).toEqual(state("newer"));
  });

  it("does not let an obsolete duplicate-save failure clear a newer save failure", async () => {
    const storage = memoryStorage();
    const staleSave = deferred<SessionSaveResponse>();
    const ids = [
      "00000000-0000-4000-8000-000000000084",
      "00000000-0000-4000-8000-000000000085",
      "00000000-0000-4000-8000-000000000086",
    ];
    const createId = () => ids.shift()!;
    const staleMount = new GameSessionOutbox({ storage, createId, save: () => staleSave.promise });
    staleMount.enqueue("Table", state("old"), null);
    const staleFlush = staleMount.flush();

    const activeSave = vi
      .fn()
      .mockResolvedValueOnce({ revision: 1, duplicate: true })
      .mockRejectedValueOnce(new Error("newer save failed"));
    const activeMount = new GameSessionOutbox({ storage, createId, save: activeSave });
    await activeMount.flush();
    activeMount.enqueue("Table", state("newer"), null);
    await expect(activeMount.flush()).rejects.toThrow("newer save failed");
    expect(activeMount.status).toBe("offline");

    staleSave.reject(new Error("obsolete duplicate failed"));
    await expect(staleFlush).rejects.toThrow("obsolete duplicate failed");

    expect(staleMount.status).toBe("offline");
    expect(staleMount.pendingCount).toBe(1);
    expect(staleMount.current?.state).toEqual(state("newer"));
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4") ?? "null")).toMatchObject({
      failed: true,
      metadata: { playlistId: "newer" },
      outbox: [expect.objectContaining({ mutationId: "00000000-0000-4000-8000-000000000086" })],
    });
  });

  it("does not let a stale save completion replace a newer durable game identity", async () => {
    const storage = memoryStorage();
    const staleSave = deferred<SessionSaveResponse>();
    const staleIds = [
      "00000000-0000-4000-8000-000000000070",
      "00000000-0000-4000-8000-000000000071",
    ];
    const staleMount = new GameSessionOutbox({
      storage,
      createId: () => staleIds.shift()!,
      save: () => staleSave.promise,
    });
    staleMount.enqueue("Old table", state("old"), null);
    const staleFlush = staleMount.flush();

    const activeIds = [
      "00000000-0000-4000-8000-000000000072",
      "00000000-0000-4000-8000-000000000073",
    ];
    const activeMount = new GameSessionOutbox({
      storage,
      createId: () => activeIds.shift()!,
      save: vi.fn(),
    });
    await activeMount.clear(() => Promise.resolve());
    activeMount.enqueue("New table", state("new"), null);

    staleSave.resolve({ revision: 1, duplicate: false });
    await staleFlush;

    expect(staleMount.gameId).toBe("00000000-0000-4000-8000-000000000072");
    expect(staleMount.current).toMatchObject({ name: "New table", state: state("new") });
    expect(staleMount.pendingCount).toBe(1);
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4") ?? "null")).toMatchObject({
      gameId: "00000000-0000-4000-8000-000000000072",
      name: "New table",
      metadata: { playlistId: "new" },
      outbox: [expect.objectContaining({ mutationId: "00000000-0000-4000-8000-000000000073" })],
    });
  });

  it("does not let a stale save failure replace or fail a newer durable game identity", async () => {
    const storage = memoryStorage();
    const staleSave = deferred<SessionSaveResponse>();
    const staleIds = [
      "00000000-0000-4000-8000-000000000074",
      "00000000-0000-4000-8000-000000000075",
    ];
    const staleMount = new GameSessionOutbox({
      storage,
      createId: () => staleIds.shift()!,
      save: () => staleSave.promise,
    });
    staleMount.enqueue("Old table", state("old"), null);
    const staleFlush = staleMount.flush();

    const activeIds = [
      "00000000-0000-4000-8000-000000000076",
      "00000000-0000-4000-8000-000000000077",
    ];
    const activeMount = new GameSessionOutbox({
      storage,
      createId: () => activeIds.shift()!,
      save: vi.fn(),
    });
    await activeMount.clear(() => Promise.resolve());
    activeMount.enqueue("New table", state("new"), null);

    staleSave.reject(new Error("old request failed"));
    await expect(staleFlush).rejects.toThrow("old request failed");

    expect(staleMount.gameId).toBe("00000000-0000-4000-8000-000000000076");
    expect(staleMount.status).toBe("saving");
    expect(staleMount.current).toMatchObject({ name: "New table", state: state("new") });
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4") ?? "null")).toMatchObject({
      gameId: "00000000-0000-4000-8000-000000000076",
      failed: false,
      name: "New table",
      metadata: { playlistId: "new" },
    });
  });

  it("clears by the known game UUID while first save is pending and preserves local state on failure", async () => {
    const storage = memoryStorage();
    const pendingSave = deferred<SessionSaveResponse>();
    const ids = ["00000000-0000-4000-8000-000000000020", "00000000-0000-4000-8000-000000000021"];
    const outbox = new GameSessionOutbox({
      storage,
      createId: () => ids.shift()!,
      save: () => pendingSave.promise,
    });
    outbox.enqueue("Table", state("pending"), null);
    void outbox.flush();
    const clear = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);

    await expect(outbox.clear(clear)).rejects.toThrow("offline");

    expect(clear).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000020", 0);
    expect(outbox.current?.state).toEqual(state("pending"));
    expect(outbox.pendingCount).toBe(1);
    expect(outbox.status).toBe("offline");

    await outbox.clear(clear);
    expect(outbox.current).toBeNull();
    expect(outbox.pendingCount).toBe(0);
    expect(outbox.gameId).toBeNull();
    expect(outbox.status).toBe("saved");
    pendingSave.resolve({ revision: 1, duplicate: false });
  });

  it("resumes a durable clear after a remount", async () => {
    const storage = memoryStorage();
    const gameId = "00000000-0000-4000-8000-000000000039";
    const never = deferred<void>();
    const firstMount = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    firstMount.restore(gameId, 7, "Clearing", state("clearing"), null);
    void firstMount.clear(() => never.promise);
    await Promise.resolve();

    const clearRemote = vi.fn().mockResolvedValue(undefined);
    const remounted = new GameSessionOutbox({
      storage,
      createId: vi.fn(),
      save: vi.fn(),
      clearRemote,
    });

    await vi.waitFor(() => expect(clearRemote).toHaveBeenCalledWith(gameId, 7));
    await vi.waitFor(() => expect(remounted.current).toBeNull());
    expect(remounted.status).toBe("saved");
  });

  it("keeps a failed clear latched after an older in-flight save succeeds", async () => {
    const storage = memoryStorage();
    const pendingSave = deferred<SessionSaveResponse>();
    const ids = ["00000000-0000-4000-8000-000000000040", "00000000-0000-4000-8000-000000000041"];
    const outbox = new GameSessionOutbox({
      storage,
      createId: () => ids.shift()!,
      save: () => pendingSave.promise,
    });
    outbox.enqueue("Table", state("pending"), null);
    const flush = outbox.flush();

    await expect(outbox.clear(() => Promise.reject(new Error("offline")))).rejects.toThrow(
      "offline",
    );
    expect(outbox.status).toBe("offline");

    pendingSave.resolve({ revision: 1, duplicate: false });
    await flush;

    expect(outbox.pendingCount).toBe(0);
    expect(outbox.current?.state).toEqual(state("pending"));
    expect(outbox.status).toBe("offline");
  });

  it("refuses to restore over a pending durable mutation", () => {
    const storage = memoryStorage();
    const ids = ["00000000-0000-4000-8000-000000000050", "00000000-0000-4000-8000-000000000051"];
    const outbox = new GameSessionOutbox({
      storage,
      createId: () => ids.shift()!,
      save: vi.fn(),
    });
    outbox.enqueue("Table", state("local-newer"), null);

    expect(() =>
      outbox.restore(
        "00000000-0000-4000-8000-000000000050",
        1,
        "Table",
        state("remote-older"),
        null,
      ),
    ).toThrow("Cannot restore while local game changes are unresolved");
    expect(outbox.pendingCount).toBe(1);
    expect(outbox.current?.state).toEqual(state("local-newer"));
  });

  it("refuses a stale instance restore after another instance restored a newer game", () => {
    const storage = memoryStorage();
    const stale = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    const active = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    const newerGameId = "00000000-0000-4000-8000-000000000091";
    active.restore(newerGameId, 8, "Newer game", state("B"), null);

    expect(() =>
      stale.restore("00000000-0000-4000-8000-000000000090", 3, "Stale game", state("A"), null),
    ).toThrow("Local session changed in another browser context");

    expect(stale.gameId).toBe(newerGameId);
    expect(stale.current?.state.playlistId).toBe("B");
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4") ?? "null")).toMatchObject({
      gameId: newerGameId,
      revision: 8,
      metadata: { playlistId: "B" },
    });
  });

  it("does not let an older clear completion erase a newer restored session", async () => {
    const storage = memoryStorage();
    const clearRemote = deferred<void>();
    const outbox = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    outbox.restore("00000000-0000-4000-8000-000000000060", 3, "A", state("A"), null);
    const clearing = outbox.clear(() => clearRemote.promise);

    outbox.restore("00000000-0000-4000-8000-000000000061", 9, "B", state("B"), null);
    clearRemote.resolve();
    await clearing;

    expect(outbox.gameId).toBe("00000000-0000-4000-8000-000000000061");
    expect(outbox.revision).toBe(9);
    expect(outbox.current).toMatchObject({ name: "B", state: state("B") });
  });

  it("does not let a clear success erase another instance's newer game", async () => {
    const storage = memoryStorage();
    const clearRemote = deferred<void>();
    const clearingMount = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    const clearedGameId = "00000000-0000-4000-8000-000000000080";
    const newerGameId = "00000000-0000-4000-8000-000000000081";
    clearingMount.restore(clearedGameId, 3, "A", state("A"), null);
    const clearing = clearingMount.clear(() => clearRemote.promise);

    const activeMount = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    activeMount.restore(newerGameId, 9, "B", state("B"), null);
    clearRemote.resolve();
    await clearing;

    expect(clearingMount.gameId).toBe(newerGameId);
    expect(clearingMount.current).toMatchObject({ name: "B", state: state("B") });
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4") ?? "null")).toMatchObject({
      gameId: newerGameId,
      name: "B",
      metadata: { playlistId: "B" },
    });
  });

  it("does not let a clear failure replace another instance's newer game", async () => {
    const storage = memoryStorage();
    const clearRemote = deferred<void>();
    const clearingMount = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    const clearedGameId = "00000000-0000-4000-8000-000000000082";
    const newerGameId = "00000000-0000-4000-8000-000000000083";
    clearingMount.restore(clearedGameId, 3, "A", state("A"), null);
    const clearing = clearingMount.clear(() => clearRemote.promise);

    const activeMount = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    activeMount.restore(newerGameId, 9, "B", state("B"), null);
    clearRemote.reject(new Error("old clear failed"));
    await expect(clearing).rejects.toThrow("old clear failed");

    expect(clearingMount.gameId).toBe(newerGameId);
    expect(clearingMount.status).toBe("saved");
    expect(clearingMount.current).toMatchObject({ name: "B", state: state("B") });
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4") ?? "null")).toMatchObject({
      gameId: newerGameId,
      clearFailed: false,
      name: "B",
      metadata: { playlistId: "B" },
    });
  });

  it("preserves a newer enqueue while an older game clear is pending", async () => {
    const storage = memoryStorage();
    const clearRemote = deferred<void>();
    const ids = ["00000000-0000-4000-8000-000000000062", "00000000-0000-4000-8000-000000000063"];
    const outbox = new GameSessionOutbox({
      storage,
      createId: () => ids.shift()!,
      save: vi.fn(),
    });
    const clearedGameId = "00000000-0000-4000-8000-000000000061";
    outbox.restore(clearedGameId, 3, "A", state("A"), null);
    const clearing = outbox.clear(() => clearRemote.promise);

    outbox.enqueue("B", state("B"), null);
    clearRemote.resolve();
    await clearing;

    expect(outbox.gameId).toBe("00000000-0000-4000-8000-000000000062");
    expect(outbox.gameId).not.toBe(clearedGameId);
    expect(outbox.revision).toBe(0);
    expect(outbox.pendingCount).toBe(1);
    expect(outbox.current).toMatchObject({ name: "B", state: state("B") });
  });

  it("gives another instance a fresh game identity while clear is pending", async () => {
    const storage = memoryStorage();
    const clearRemote = deferred<void>();
    const clearingMount = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    const clearedGameId = "00000000-0000-4000-8000-000000000087";
    clearingMount.restore(clearedGameId, 3, "A", state("A"), null);
    const clearing = clearingMount.clear(() => clearRemote.promise);

    const ids = ["00000000-0000-4000-8000-000000000088", "00000000-0000-4000-8000-000000000089"];
    const activeMount = new GameSessionOutbox({
      storage,
      createId: () => ids.shift()!,
      save: vi.fn(),
    });
    expect(activeMount.status).toBe("saving");
    activeMount.enqueue("B", state("B"), null);
    expect(activeMount.gameId).toBe("00000000-0000-4000-8000-000000000088");
    expect(activeMount.gameId).not.toBe(clearedGameId);

    clearRemote.resolve();
    await clearing;
    expect(activeMount.current).toMatchObject({ name: "B", state: state("B") });
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4") ?? "null")).toMatchObject({
      gameId: "00000000-0000-4000-8000-000000000088",
      name: "B",
      metadata: { playlistId: "B" },
    });
  });

  it("rejects a corrupted persisted game ID before it can reach a request path", () => {
    const storage = memoryStorage();
    const seed = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    seed.restore("00000000-0000-4000-8000-000000000101", 2, "Safe", state("safe"), null);
    const persisted = JSON.parse(storage.getItem("mafia-dashboard.game-session.v4")!);
    storage.setItem(
      "mafia-dashboard.game-session.v4",
      JSON.stringify({ ...persisted, gameId: "../api/players" }),
    );

    const loaded = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });

    expect(loaded.gameId).toBeNull();
    expect(loaded.current).toBeNull();
  });

  it("reloads durable identity before a stale mount can overwrite it", () => {
    const storage = memoryStorage();
    const stale = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    const active = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    const gameId = "00000000-0000-4000-8000-000000000102";
    active.restore(gameId, 7, "Current", state("current"), null);

    stale.ensureGameId(gameId);

    expect(stale.current).toMatchObject({ name: "Current", state: state("current") });
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4")!)).toMatchObject({
      gameId,
      revision: 7,
      name: "Current",
    });
  });

  it("reloads durable operations before a stale mount flushes", async () => {
    const storage = memoryStorage();
    const save = vi.fn().mockResolvedValue({ revision: 1, duplicate: false });
    const stale = new GameSessionOutbox({ storage, createId: vi.fn(), save });
    const ids = ["00000000-0000-4000-8000-000000000103", "00000000-0000-4000-8000-000000000104"];
    const active = new GameSessionOutbox({ storage, createId: () => ids.shift()!, save });
    active.enqueue("Queued", state("queued"), null);

    await stale.flush();

    expect(save).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000103",
      expect.objectContaining({ kind: "snapshot", baseRevision: 0 }),
    );
    expect(stale.pendingCount).toBe(0);
    expect(stale.revision).toBe(1);
  });

  it("lets the last browser snapshot overwrite another context's newer local revision", () => {
    const storage = memoryStorage();
    const stale = new GameSessionOutbox({
      storage,
      createId: () => "00000000-0000-4000-8000-000000000120",
      save: vi.fn(),
    });
    const active = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    const gameId = "00000000-0000-4000-8000-000000000110";
    active.restore(gameId, 5, "Current", state("current"), null);

    expect(() => stale.enqueue("Stale", state("stale"), null)).not.toThrow();
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4")!)).toMatchObject({
      gameId,
      revision: 5,
      name: "Stale",
      metadata: { playlistId: "stale" },
      outbox: [expect.objectContaining({ kind: "snapshot", baseRevision: 5 })],
    });
  });

  it("keeps a later browser snapshot authoritative while an older save finishes", async () => {
    const storage = memoryStorage();
    const firstSave = deferred<SessionSaveResponse>();
    const ids = [
      "00000000-0000-4000-8000-000000000116",
      "00000000-0000-4000-8000-000000000117",
      "00000000-0000-4000-8000-000000000118",
    ];
    let saveCount = 0;
    const saving = new GameSessionOutbox({
      storage,
      createId: () => ids.shift()!,
      save: (_gameId, operation) => {
        saveCount += 1;
        return saveCount === 1
          ? firstSave.promise
          : Promise.resolve({ revision: operation.baseRevision + 1, duplicate: false });
      },
    });
    saving.enqueue("First", state("first"), null);
    const flushing = saving.flush();

    const newer = new GameSessionOutbox({
      storage,
      createId: () => "00000000-0000-4000-8000-000000000119",
      save: vi.fn(),
    });
    newer.enqueue("Newer", state("newer"), null);

    expect(() => saving.enqueue("Stale", state("stale"), null)).not.toThrow();
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4")!)).toMatchObject({
      name: "Stale",
      metadata: { playlistId: "stale" },
    });

    firstSave.resolve({ revision: 1, duplicate: false });
    await flushing;
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4")!)).toMatchObject({
      name: "Stale",
      metadata: { playlistId: "stale" },
    });
  });

  it("accepts a synchronized same-game event that extends the durable head", () => {
    const storage = memoryStorage();
    const gameId = "00000000-0000-4000-8000-000000000112";
    const game = canonicalGame();
    const root = createGameLogEntry({
      gameId,
      id: "00000000-0000-4000-8000-000000000113",
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-25T00:00:00.000Z",
      before: game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    const child = createGameLogEntry({
      gameId,
      id: "00000000-0000-4000-8000-000000000114",
      sequence: 2,
      parentEventId: root.entry.id,
      createdAt: "2026-08-25T00:01:00.000Z",
      before: root.after,
      draft: {
        type: "turn.completed",
        payload: { seat: root.after.turnOrder[0]! },
      },
    });
    const canonicalState = (events: readonly (typeof root.entry | typeof child.entry)[]) =>
      ({
        ...state("same-game"),
        game: events.length === 1 ? root.after : child.after,
        initialGame: { replayVersion: 1 as const, game },
        events,
        headEventId: events.at(-1)?.id ?? null,
      }) as unknown as Parameters<GameSessionOutbox["enqueue"]>[1];
    const stale = new GameSessionOutbox({
      storage,
      createId: () => "00000000-0000-4000-8000-000000000115",
      save: vi.fn(),
    });
    const active = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    active.restore(gameId, 1, "Game", canonicalState([root.entry]), null);

    expect(() =>
      stale.enqueue("Game", canonicalState([root.entry, child.entry]), null),
    ).not.toThrow();

    expect(stale.current?.state).toMatchObject({ headEventId: child.entry.id });
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4")!)).toMatchObject({
      gameId,
      revision: 1,
      headEventId: child.entry.id,
      outbox: [
        expect.objectContaining({
          kind: "snapshot",
          state: expect.objectContaining({
            game: child.after,
            events: [root.entry, child.entry],
          }),
        }),
      ],
    });
  });

  it("refuses to let a stale mount clear another context's game", async () => {
    const storage = memoryStorage();
    const stale = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    const active = new GameSessionOutbox({ storage, createId: vi.fn(), save: vi.fn() });
    const gameId = "00000000-0000-4000-8000-000000000111";
    active.restore(gameId, 6, "Current", state("current"), null);
    const clearRemote = vi.fn().mockResolvedValue(undefined);

    await expect(stale.clear(clearRemote)).rejects.toThrow(/another browser context/i);
    expect(clearRemote).not.toHaveBeenCalled();
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v4")!)).toMatchObject({
      gameId,
      revision: 6,
      name: "Current",
    });
  });

  it("clears pending legacy state instead of allowing it to flush after reset", async () => {
    const storage = memoryStorage();
    const legacyKey = "clear-pending.v3";
    const gameId = "00000000-0000-4000-8000-000000000105";
    storage.setItem(
      legacyKey,
      JSON.stringify({
        version: 3,
        gameId,
        revision: 4,
        current: { name: "Legacy", state: state("legacy"), results: null },
        outbox: [
          {
            name: "Legacy",
            mutationId: "00000000-0000-4000-8000-000000000106",
            baseRevision: 4,
            state: state("legacy-pending"),
            results: null,
          },
        ],
        failed: false,
        clearFailed: false,
        clearingGameId: null,
      }),
    );
    const clearRemote = vi.fn().mockResolvedValue(undefined);
    const outbox = new GameSessionOutbox({
      storage,
      legacyStorageKey: legacyKey,
      createId: vi.fn(),
      save: vi.fn(),
      saveLegacy: vi.fn(),
    } as unknown as ConstructorParameters<typeof GameSessionOutbox>[0]);

    await outbox.clear(clearRemote);

    expect(clearRemote).toHaveBeenCalledWith(gameId, 4);
    expect(storage.getItem(legacyKey)).toBeNull();
    expect(outbox.current).toBeNull();
    expect(outbox.pendingCount).toBe(0);
  });

  it("refuses to restore over unresolved legacy mutations", () => {
    const storage = memoryStorage();
    const legacyKey = "restore-pending.v3";
    storage.setItem(
      legacyKey,
      JSON.stringify({
        version: 3,
        gameId: "00000000-0000-4000-8000-000000000107",
        revision: 1,
        current: { name: "Legacy", state: state("legacy"), results: null },
        outbox: [
          {
            name: "Legacy",
            mutationId: "00000000-0000-4000-8000-000000000108",
            baseRevision: 1,
            state: state("legacy-pending"),
            results: null,
          },
        ],
        failed: false,
        clearFailed: false,
        clearingGameId: null,
      }),
    );
    const outbox = new GameSessionOutbox({
      storage,
      legacyStorageKey: legacyKey,
      createId: vi.fn(),
      save: vi.fn(),
      saveLegacy: vi.fn(),
    } as unknown as ConstructorParameters<typeof GameSessionOutbox>[0]);

    expect(() =>
      outbox.restore(
        "00000000-0000-4000-8000-000000000109",
        2,
        "Replacement",
        state("replacement"),
        null,
      ),
    ).toThrow(/legacy game changes are unresolved/i);
  });
});
