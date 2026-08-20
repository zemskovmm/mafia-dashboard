import { describe, expect, it, vi } from "vitest";
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
});

describe("GameSessionOutbox", () => {
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
      game: { day: 1, phase: "day" },
      setup: null,
    };
    outbox.restore("00000000-0000-4000-8000-000000000090", 7, "Table", restoredState, null);

    outbox.enqueue(
      "Table",
      {
        setup: null,
        game: { phase: "day", day: 1 },
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

    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v3") ?? "null")).toMatchObject({
      revision: 1,
      current: { state: state("newer") },
      outbox: [expect.objectContaining({ baseRevision: 1, state: state("newer") })],
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
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v3") ?? "null")).toMatchObject({
      failed: true,
      current: { state: state("newer") },
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
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v3") ?? "null")).toMatchObject({
      gameId: "00000000-0000-4000-8000-000000000072",
      current: { name: "New table", state: state("new") },
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
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v3") ?? "null")).toMatchObject({
      gameId: "00000000-0000-4000-8000-000000000076",
      failed: false,
      current: { name: "New table", state: state("new") },
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
    ).toThrow("Local session changed while the restore request was pending");

    expect(stale.gameId).toBe(newerGameId);
    expect(stale.current?.state.playlistId).toBe("B");
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v3") ?? "null")).toMatchObject({
      gameId: newerGameId,
      revision: 8,
      current: { state: { playlistId: "B" } },
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
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v3") ?? "null")).toMatchObject({
      gameId: newerGameId,
      current: { name: "B", state: state("B") },
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
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v3") ?? "null")).toMatchObject({
      gameId: newerGameId,
      clearFailed: false,
      current: { name: "B", state: state("B") },
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
    expect(JSON.parse(storage.getItem("mafia-dashboard.game-session.v3") ?? "null")).toMatchObject({
      gameId: "00000000-0000-4000-8000-000000000088",
      current: { name: "B", state: state("B") },
    });
  });
});
