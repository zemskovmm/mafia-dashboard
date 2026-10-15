import { describe, expect, it, vi } from "vitest";
import {
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createInitialGameBaseline,
  hashGameState,
  replayGameLog,
  type CanonicalGameEventDraft,
  createSetup,
  drawRoleForSeat,
  FEDERATION_RULES_EDITION,
  type GameLogEntry,
  type RulesEdition,
} from "@mafia/game-domain";
import { ApiError, type GameSessionState, type RemoteGameSession } from "./api/client.js";
import { withBrowserGameStorageGuard } from "./browser-game-storage-lock.js";
import { prepareBrowserGameStorage } from "./browser-game-storage.js";
import {
  GameSessionOutbox,
  gameSessionStorageKey,
  parseCurrentGameSessionEnvelope,
} from "./session-outbox.js";

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

const playedGame = (rulesEdition?: RulesEdition) => {
  let setup = beginRoleDraw(createSetup(setupPlayers, { rulesEdition }), () => 0);
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

const remoteSession = (
  name = "Baseline",
  state: GameSessionState = completeState("PL-baseline"),
  revision = 1,
  id = gameId,
) => ({
  gameId: id,
  name,
  revision,
  state,
  results: null,
  status: "active" as const,
  rulesetId: "classic",
  rulesetVersion: 1,
  duplicate: false,
  updatedAt: "2026-09-26T20:00:00.000Z",
});

const ids = (...values: string[]) => {
  const valuesToReturn = [...values];
  return () => valuesToReturn.shift() ?? "00000000-0000-4000-8000-000000000999";
};

const readPersisted = (storage: Storage) =>
  JSON.parse(storage.getItem(gameSessionStorageKey) ?? "null") as Record<string, unknown>;

const currentEnvelope = (state: unknown, ownerGameId = gameId) =>
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
  it.each([undefined, FEDERATION_RULES_EDITION])(
    "recovers nomination selections, supports and append-only corrections through browser reload and retry (%s)",
    async (rulesEdition) => {
      const storage = memoryStorage();
      let game = playedGame(rulesEdition);
      const baseline = createInitialGameBaseline(game);
      const entries: GameLogEntry[] = [];
      const append = (draft: CanonicalGameEventDraft) => {
        const accepted = createGameLogEntry({
          gameId,
          id: crypto.randomUUID(),
          sequence: entries.length + 1,
          parentEventId: entries.at(-1)?.id ?? null,
          createdAt: "2026-10-15T16:00:00.000Z",
          before: game,
          draft,
        });
        entries.push(accepted.entry);
        game = accepted.after;
      };
      append({ type: "game.started", payload: {} });
      for (const to of rulesEdition
        ? ([
            "mafia-sleep",
            "don-identification",
            "sheriff-identification",
            "free-seating",
            "day",
          ] as const)
        : (["sheriff-wake", "day"] as const))
        append({ type: "phase.changed", payload: { to } });
      // Keep a real old-style nomination in the same accepted chain.
      append({
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 7 },
      });
      expect(game.nominations[0]).not.toHaveProperty("supporterSeats");
      append({ type: "turn.completed", payload: { seat: 1 } });
      const select = (nominatorSeat: number, candidateSeat: number, selected = true) =>
        append({
          type: "nomination.selection-set",
          payload: { nominatorSeat, candidateSeat, selected },
        });
      select(2, 7);
      select(2, 8);
      append({ type: "turn.completed", payload: { seat: 2 } });
      select(3, 7);
      select(3, 8);
      select(3, 9);
      append({
        type: "foul.issued",
        payload: { seat: 10, foulNumber: 1, redCarded: false },
      });
      const retained = JSON.stringify(entries);
      select(3, 7, false);
      select(3, 9, false);
      append({
        type: "foul.issued",
        payload: { seat: 6, foulNumber: 1, redCarded: false },
      });
      select(3, 9);
      select(3, 7);
      expect(JSON.stringify(entries.slice(0, JSON.parse(retained).length))).toBe(retained);
      expect(game.nominations).toEqual([
        {
          nominatorSeat: 1,
          candidateSeat: 7,
          order: 1,
          supporterSeats: [2, 3],
        },
        { nominatorSeat: 2, candidateSeat: 8, order: 2, supporterSeats: [3] },
        { nominatorSeat: 3, candidateSeat: 9, order: 3 },
      ]);
      expect(game.voteAssignments).toEqual({});
      const state = {
        ...completeState(),
        setup: null,
        game,
        initialGame: baseline,
        events: entries,
        headEventId: entries.at(-1)!.id,
      };
      const failedSave = vi.fn().mockRejectedValue(new Error("offline nomination save"));
      const outbox = new GameSessionOutbox({
        storage,
        clubId,
        createId: () => crypto.randomUUID(),
        save: failedSave,
      });
      outbox.activateRemote(remoteSession());
      outbox.enqueue("Selections", state, null);
      await expect(outbox.flush()).rejects.toThrow("offline nomination save");
      const raw = storage.getItem(gameSessionStorageKey)!;
      const persisted = parseCurrentGameSessionEnvelope(raw)!;
      expect(persisted.current?.state).toEqual(state);
      expect(persisted.outbox[0]?.state).toEqual(state);
      expect(await prepareBrowserGameStorage({ localStorage: storage })).toMatchObject({
        kind: "ready",
        attachment: { clubId, gameId, pendingCount: 1, unresolved: true },
      });
      expect(storage.getItem(gameSessionStorageKey)).toBe(raw);
      const save = vi.fn().mockResolvedValue({ revision: 2 });
      const restored = new GameSessionOutbox({
        storage,
        clubId,
        createId: () => crypto.randomUUID(),
        save,
      });
      restored.activateRemote(remoteSession());
      expect(restored.current?.state).toEqual(state);
      await restored.flush();
      expect(save).toHaveBeenCalledExactlyOnceWith(gameId, persisted.outbox[0]);
      const loaded = new GameSessionOutbox({
        storage,
        clubId,
        createId: () => crypto.randomUUID(),
        save,
      });
      expect(loaded.pendingCount).toBe(0);
      expect(loaded.current?.state).toEqual(state);
      const actual = loaded.current!.state;
      const replay = replayGameLog(actual.initialGame!, actual.events, gameId);
      expect(replay.game).toEqual(game);
      expect(hashGameState(replay.game)).toBe(entries.at(-1)!.stateHashAfter);
      expect(replay.frames.map(({ after }) => hashGameState(after))).toEqual(
        entries.map(({ stateHashAfter }) => stateHashAfter),
      );
      expect(actual.headEventId).toBe(entries.at(-1)!.id);
      expect(
        replay.frames.find(({ entry }) => entry.type === "player.nominated")!.after.nominations[0],
      ).not.toHaveProperty("supporterSeats");
      expect(replay.game.nominations[2]).not.toHaveProperty("supporterSeats");
      expect(
        replay.game.players.filter(({ fouls }) => fouls === 1).map(({ seat }) => seat),
      ).toEqual([6, 10]);
      expect(
        actual.events.every(
          ({ replayVersion, rulesEdition }) =>
            replayVersion === baseline.replayVersion && rulesEdition === baseline.rulesEdition,
        ),
      ).toBe(true);
    },
  );

  it("round-trips a supported federation edition without rewriting its draft", () => {
    const game = playedGame(FEDERATION_RULES_EDITION);
    const state = {
      ...completeState(),
      setup: null,
      game,
      initialGame: createInitialGameBaseline(game),
    };
    const raw = currentEnvelope(state);
    expect(parseCurrentGameSessionEnvelope(raw)?.current?.state).toEqual(state);
  });

  it.each([
    { game: { ...playedGame(), rulesEdition: "unknown-future-rules" } },
    { initialGame: { replayVersion: 99, game: playedGame() } },
    { initialGame: { game: playedGame() } },
    {
      game: { ...playedGame(), rulesEdition: FEDERATION_RULES_EDITION },
      initialGame: { replayVersion: 1, game: playedGame() },
    },
    { setup: { ...emptyPlayerSetup(), rulesEdition: "unknown-future-rules" } },
    { events: [{ replayVersion: 2, rulesEdition: FEDERATION_RULES_EDITION }] },
  ])("rejects unsupported or crossed editions without clearing the original", (changes) => {
    const storage = memoryStorage();
    const raw = currentEnvelope({ ...completeState(), ...changes });
    storage.setItem(gameSessionStorageKey, raw);
    expect(parseCurrentGameSessionEnvelope(raw)).toBeNull();
    expect(
      () => new GameSessionOutbox({ storage, clubId, createId: ids(), save: vi.fn() }),
    ).toThrow();
    expect(storage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it("refuses an unsupported server edition before replacing unsent current work", () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(), save: vi.fn() });
    outbox.activateRemote(remoteSession());
    outbox.enqueue("Unsent correction", completeState("PL-pending"), null);
    const original = storage.getItem(gameSessionStorageKey);
    expect(() =>
      outbox.activateRemote(
        remoteSession("Unsupported", {
          ...completeState(),
          game: { ...playedGame(), rulesEdition: "unknown-future-rules" },
        }),
      ),
    ).toThrow("Invalid server game session");
    expect(storage.getItem(gameSessionStorageKey)).toBe(original);
    expect(outbox.pendingCount).toBe(1);
  });

  it("preserves an unsupported parked copy and the active pending game on resume", () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(), save: vi.fn() });
    outbox.activateRemote(
      remoteSession("Other game", completeState(), 1, "00000000-0000-4000-8000-000000000202"),
    );
    outbox.enqueue("Current unsent work", completeState("PL-unsent"), null);
    const original = storage.getItem(gameSessionStorageKey);
    const parkedKey = `${gameSessionStorageKey}.parked.${gameId}`;
    const parked = currentEnvelope({
      ...completeState(),
      game: {
        ...playedGame(),
        rulesEdition: "unknown-future-rules",
      },
    });
    storage.setItem(parkedKey, parked);
    expect(() => outbox.activateRemote(remoteSession())).toThrow("Unsupported parked game session");
    expect(storage.getItem(parkedKey)).toBe(parked);
    expect(storage.getItem(gameSessionStorageKey)).toBe(original);
    expect(outbox.pendingCount).toBe(1);
  });

  it("writes identity-only canonical game/setup while leaving the game title independent", () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids("00000000-0000-4000-8000-000000000300"),
      create: vi.fn(),
      save: vi.fn(),
    });
    const game = playedGame();
    const state = { ...completeState(), setup: roleDrawSetup(), game };
    outbox.beginCreation("Named table title", state, null);
    const saved = JSON.parse(storage.getItem(gameSessionStorageKey)!) as {
      current: { name: string; state: Record<string, unknown> };
    };
    expect(saved.current.name).toBe("Named table title");
    expect(JSON.stringify(saved.current.state)).not.toContain('"name"');
    expect(JSON.stringify(saved.current.state)).not.toContain("Player 1");
    expect(saved.current.state).toHaveProperty("hostPlayerId", null);
  });
  it("persists the entire current snapshot without deriving or stripping setup, log, or drafts", () => {
    const storage = memoryStorage();
    const state = completeState();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId, "00000000-0000-4000-8000-000000000301"),
      save: vi.fn(),
    });

    outbox.activateRemote(remoteSession());
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

    outbox.activateRemote(remoteSession());
    outbox.enqueue("Table", completeState("PL-first"), null);
    outbox.enqueue("Table", completeState("PL-second"), null);

    expect(outbox.pendingCount).toBe(1);
    expect(readPersisted(storage).outbox).toEqual([
      expect.objectContaining({
        kind: "snapshot",

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
    outbox.activateRemote(remoteSession());
    outbox.enqueue("Table", completeState("PL-first"), null);
    const flushing = outbox.flush();
    outbox.enqueue("Table", completeState("PL-second"), null);

    expect(readPersisted(storage).outbox).toEqual([
      expect.objectContaining({ state: completeState("PL-first") }),
      expect.objectContaining({ state: completeState("PL-second") }),
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
    outbox.activateRemote(remoteSession());
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

    await expect(flushing).rejects.toThrow("Local session changed in another browser context");
    expect(storage.getItem(gameSessionStorageKey)).toBe(newerRaw);
    const reloaded = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId),
      save: vi.fn(),
    });
    expect(reloaded.current?.name).toBe("New table");
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
    stale.activateRemote(remoteSession("Old table", completeState("PL-old"), 3));
    const clearing = stale.clear(() => remoteClear.promise);
    const replacementGameId = "00000000-0000-4000-8000-000000000202";
    const active = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids("00000000-0000-4000-8000-000000000308"),
      save: vi.fn(),
    });
    active.activateRemote({
      gameId: replacementGameId,
      revision: 7,
      name: "New table",
      state: completeState("PL-new"),
      results: null,
      status: "active",
      rulesetId: "classic",
      rulesetVersion: 1,
      duplicate: false,
      updatedAt: "2026-09-26T20:00:00.000Z",
    });
    remoteClear.resolve();

    await expect(clearing).rejects.toThrow("Local session changed in another browser context");
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
    outbox.activateRemote(remoteSession());
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
      outbox?.activateRemote(remoteSession());
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

  it("retains a historical eight-hex event hash without rewriting its stored bytes", () => {
    const storage = memoryStorage();
    const state = eventState();
    const raw = currentEnvelope({
      ...state,
      events: [{ ...state.events![0]!, stateHashAfter: "deadbeef" }],
    });
    storage.setItem(gameSessionStorageKey, raw);

    expect(
      () => new GameSessionOutbox({ storage, clubId, createId: vi.fn(), save: vi.fn() }),
    ).not.toThrow();
    expect(storage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it.each([
    ["a retired event type", { type: "speech.started" }],
    ["a retired checkpoint payload", { payload: { sequence: 1 } }],
    ["an unsupported event field", { idempotencyKey: "old-key" }],
  ])("retains historical %s without rewriting the current record", (_label, patch) => {
    const storage = memoryStorage();
    const state = eventState();
    const raw = currentEnvelope({
      ...state,
      events: [{ ...state.events![0]!, ...patch } as GameLogEntry],
    });
    storage.setItem(gameSessionStorageKey, raw);

    expect(
      () => new GameSessionOutbox({ storage, clubId, createId: vi.fn(), save: vi.fn() }),
    ).not.toThrow();
    expect(storage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it("retains historical foreign event IDs until the server GUID is adopted", () => {
    const storage = memoryStorage();
    const raw = currentEnvelope(eventState(1, "00000000-0000-4000-8000-000000000202"));
    storage.setItem(gameSessionStorageKey, raw);

    expect(
      () => new GameSessionOutbox({ storage, clubId, createId: vi.fn(), save: vi.fn() }),
    ).not.toThrow();
    expect(storage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it.each([
    ["an empty game object", { ...completeState(), game: {} }],
    ["an empty setup object", { ...completeState(), setup: {} }],
  ])("retains opaque historical %s without mutating stored bytes", (_label, state) => {
    const storage = memoryStorage();
    const raw = currentEnvelope(state);
    storage.setItem(gameSessionStorageKey, raw);

    expect(
      () => new GameSessionOutbox({ storage, clubId, createId: vi.fn(), save: vi.fn() }),
    ).not.toThrow();
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

    outbox.activateRemote(remoteSession());
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
    outbox.activateRemote(remoteSession());
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
    outbox.activateRemote(remoteSession());
    outbox.enqueue("Head table", state, null);

    expect(outbox.current?.state).toEqual(state);
    expect(readPersisted(storage)).toMatchObject({ current: { state } });
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
    outbox.activateRemote(remoteSession("Clear me", completeState(), 2));
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
    outbox.activateRemote(remoteSession("Keep me", completeState(), 2));

    await expect(outbox.clear(() => Promise.reject(new Error("offline")))).rejects.toThrow(
      "offline",
    );
    expect(outbox.current?.name).toBe("Keep me");
    expect(outbox.status).toBe("offline");
    expect(readPersisted(storage)).toMatchObject({ clearFailed: true });
  });

  it("notifies listeners for enqueue and failure lifecycle changes", async () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({
      storage,
      clubId,
      createId: ids(gameId),
      save: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const listener = vi.fn();
    const unsubscribe = outbox.subscribe(listener);
    outbox.activateRemote(remoteSession());
    outbox.enqueue("Observed", completeState(), null);
    await expect(outbox.flush()).rejects.toThrow("offline");
    outbox.enqueue("Observed", completeState("PL-second"), null);
    unsubscribe();

    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects incomplete snapshots instead of manufacturing missing current fields", () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(gameId), save: vi.fn() });

    outbox.activateRemote(remoteSession());
    outbox.activateRemote(remoteSession());
    expect(() => outbox.enqueue("Incomplete", { setup: null } as GameSessionState, null)).toThrow(
      "Invalid current game session state",
    );
    expect(outbox.current?.name).toBe("Baseline");
  });

  it("remaps foreign draft events to the server GUID before saving", () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(gameId), save: vi.fn() });
    const otherGame = "00000000-0000-4000-8000-000000000202";

    outbox.activateRemote(remoteSession());
    outbox.activateRemote(remoteSession());
    outbox.enqueue("Wrong event", eventState(1, otherGame), null);
    expect(outbox.current?.state.events?.[0]?.gameId).toBe(gameId);
    expect(readPersisted(storage)).toMatchObject({ gameId });
  });

  it("does not create a record when clearing an empty browser", async () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(gameId), save: vi.fn() });

    await outbox.clear(vi.fn());
    expect(storage.getItem(gameSessionStorageKey)).toBeNull();
  });

  it("surfaces storage write failure without claiming durability", () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(gameId), save: vi.fn() });
    outbox.activateRemote(remoteSession());
    storage.setItem = vi.fn(() => {
      throw new Error("quota exceeded");
    });
    expect(() => outbox.enqueue("Quota", completeState(), null)).toThrow("quota exceeded");
    expect(outbox.pendingCount).toBe(1);
  });

  it("surfaces storage removal failure after remote clear instead of pretending it completed", async () => {
    const storage = memoryStorage();
    const outbox = new GameSessionOutbox({ storage, clubId, createId: ids(gameId), save: vi.fn() });
    outbox.activateRemote(remoteSession("Removal", completeState(), 2));
    storage.removeItem = vi.fn(() => {
      throw new Error("remove failed");
    });

    await expect(outbox.clear(() => Promise.resolve())).rejects.toThrow("remove failed");
    expect(storage.getItem(gameSessionStorageKey)).not.toBeNull();
  });
});

const serverGameId = "00000000-0000-4000-8000-000000000002";
const creationId = "00000000-0000-4000-8000-000000000003";
const mutationId = "00000000-0000-4000-8000-000000000004";

const storage = (): Storage => {
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

const state = {
  setup: null,
  game: null,
  hostPlayerId: null,
  hostName: null,
  playlistId: "",
  log: [],
  undoHistory: [],
  undoBudget: 0,
  initialGame: null,
  events: [],
  headEventId: null,
  resetReturnEventId: null,
  legacyLog: [],
};

const remote = (gameId = serverGameId): RemoteGameSession => ({
  gameId,
  name: "Table A",
  status: "active",
  rulesetId: "classic",
  rulesetVersion: 1,
  revision: 1,
  duplicate: false,
  updatedAt: "2026-09-26T20:00:00.000Z",
  state,
  results: null,
});

describe("GameSessionOutbox", () => {
  it("prefers a newer server snapshot over a parked copy that has no unsent work", () => {
    const localStorage = storage();
    const outbox = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: () => mutationId,
      create: vi.fn(),
      save: vi.fn(),
    });
    outbox.activateRemote(remote());
    outbox.park();
    outbox.activateRemote({
      ...remote(),
      revision: 3,
      state: { ...state, playlistId: "newer-server" },
    });

    expect(outbox.current?.state.playlistId).toBe("newer-server");
    expect(outbox.revision).toBe(3);
    expect(outbox.pendingCount).toBe(0);
  });

  it("does not resurrect an acknowledged legacy game when GET returns 404", () => {
    const localStorage = storage();
    localStorage.setItem(
      gameSessionStorageKey,
      JSON.stringify({
        version: 5,
        clubId,
        gameId: serverGameId,
        revision: 1,
        current: { name: "Deleted table", state, results: null },
        outbox: [],
        failed: false,
        clearFailed: false,
        clearingGameId: null,
      }),
    );
    const create = vi.fn();
    const outbox = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: () => creationId,
      create,
      save: vi.fn(),
    });
    expect(outbox.needsRemoteVerification).toBe(true);

    outbox.adoptLegacyDraft();
    expect(outbox.isRemoved).toBe(true);
    expect(outbox.isCreating).toBe(false);
    expect(outbox.pendingCount).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("retains a genuinely unsent legacy snapshot for POST with one stable creation ID", async () => {
    const localStorage = storage();
    localStorage.setItem(
      gameSessionStorageKey,
      JSON.stringify({
        version: 5,
        clubId,
        gameId: serverGameId,
        revision: 0,
        current: { name: "Unsent table", state, results: null },
        outbox: [{ kind: "snapshot", name: "Unsent table", mutationId, state, results: null }],
        failed: true,
        clearFailed: false,
        clearingGameId: null,
      }),
    );
    const create = vi.fn().mockResolvedValue({ ...remote(), name: "Unsent table" });
    const outbox = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: () => creationId,
      create,
      save: vi.fn(),
    });
    outbox.adoptLegacyDraft();
    expect(outbox.isCreating).toBe(true);
    expect(outbox.current?.state).toEqual(state);
    await outbox.flush();
    expect(create).toHaveBeenCalledWith({ creationId, name: "Unsent table", state, results: null });
  });
  it("persists pending-creation edits and saves the latest snapshot after a late POST", async () => {
    const localStorage = storage();
    const posting = deferred<RemoteGameSession>();
    const create = vi.fn().mockReturnValue(posting.promise);
    const save = vi.fn().mockResolvedValue({ revision: 2 });
    const outbox = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: ids(creationId, mutationId),
      create,
      save,
    });
    const first = { ...state, playlistId: "initial" };
    const latest = eventState(1, creationId);
    const results = {
      hostPlayerId: setupPlayers[0]!.id,
      outcome: "cancelled" as const,
      winner: null,
      reason: "test",
      playedAt: "2026-09-26T20:00:00.000Z",
      players: [],
    };
    outbox.beginCreation("Initial", first, null);
    const flushing = outbox.flush();
    outbox.enqueue("Middle", { ...state, playlistId: "middle" }, null);
    outbox.enqueue("Latest", latest, results);
    expect(readPersisted(localStorage)).toMatchObject({
      gameId: null,
      creationId,
      current: { name: "Latest", state: latest, results },
    });
    expect(outbox.pendingCount).toBeGreaterThan(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      creationId,
      name: "Initial",
      state: first,
      results: null,
    });

    posting.resolve({ ...remote(), name: "Initial", state: first });
    await flushing;
    const mapped = {
      ...latest,
      events: latest.events.map((event) => ({ ...event, gameId: serverGameId })),
    };
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(serverGameId, {
      kind: "snapshot",
      name: "Latest",
      mutationId,
      state: mapped,
      results,
    });
    expect(outbox.current).toEqual({ name: "Latest", state: mapped, results });
    expect(readPersisted(localStorage)).toMatchObject({
      gameId: serverGameId,
      creationId: null,
      revision: 2,
      current: { name: "Latest", state: mapped, results },
      outbox: [],
    });
    const reloaded = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: vi.fn(),
      create,
      save,
    });
    expect(reloaded.current).toEqual(outbox.current);
    expect(reloaded.pendingCount).toBe(0);
  });

  it("retries the latest pending draft with one creation ID across reload, then updates a stale duplicate", async () => {
    const localStorage = storage();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ...remote(),
        name: "Initial",
        state: { ...state, playlistId: "initial" },
        duplicate: true,
      });
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("save offline"))
      .mockResolvedValueOnce({ revision: 2 });
    const first = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: ids(creationId, mutationId),
      create,
      save,
    });
    first.beginCreation("Initial", { ...state, playlistId: "initial" }, null);
    await expect(first.flush()).rejects.toThrow("offline");
    first.enqueue("Edited", { ...state, playlistId: "edited" }, null);
    expect(readPersisted(localStorage)).toMatchObject({
      gameId: null,
      creationId,
      current: { name: "Edited" },
    });

    const reloaded = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: () => mutationId,
      create,
      save,
    });
    reloaded.enqueue("Latest", { ...state, playlistId: "latest" }, null);
    await expect(reloaded.flush()).rejects.toThrow("save offline");
    expect(create).toHaveBeenNthCalledWith(2, {
      creationId,
      name: "Latest",
      state: { ...state, playlistId: "latest" },
      results: null,
    });
    expect(readPersisted(localStorage)).toMatchObject({
      gameId: serverGameId,
      creationId: null,
      failed: true,
      current: { name: "Latest", state: { ...state, playlistId: "latest" } },
      outbox: [{ mutationId, name: "Latest" }],
    });
    const afterSaveFailure = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: vi.fn(),
      create,
      save,
    });
    await afterSaveFailure.flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
    expect(afterSaveFailure.current?.name).toBe("Latest");
    expect(afterSaveFailure.pendingCount).toBe(0);
  });

  it("ignores a late creation response after clearing the unacknowledged draft", async () => {
    const localStorage = storage();
    const posting = deferred<RemoteGameSession>();
    const save = vi.fn();
    const outbox = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: () => creationId,
      create: () => posting.promise,
      save,
    });
    outbox.beginCreation("Discard", state, null);
    const flushing = outbox.flush();
    await outbox.clear(vi.fn());
    posting.resolve(remote());
    await flushing;
    expect(outbox.gameId).toBeNull();
    expect(outbox.current).toBeNull();
    expect(localStorage.getItem(gameSessionStorageKey)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps a newer browser record when an obsolete creation response arrives", async () => {
    const localStorage = storage();
    const posting = deferred<RemoteGameSession>();
    const outbox = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: () => creationId,
      create: () => posting.promise,
      save: vi.fn(),
    });
    outbox.beginCreation("Original", state, null);
    const flushing = outbox.flush();
    const newerRaw = JSON.stringify({
      ...readPersisted(localStorage),
      current: { name: "Replacement", state: { ...state, playlistId: "newer" }, results: null },
    });
    localStorage.setItem(gameSessionStorageKey, newerRaw);
    posting.resolve(remote());
    await expect(flushing).rejects.toThrow("Local session changed in another browser context");
    expect(localStorage.getItem(gameSessionStorageKey)).toBe(newerRaw);
  });

  it("requires creation acknowledgment before parking and switching games", async () => {
    const localStorage = storage();
    const posting = deferred<RemoteGameSession>();
    const save = vi.fn().mockResolvedValue(remote());
    const outbox = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: () => creationId,
      create: () => posting.promise,
      save,
    });
    outbox.beginCreation("Draft", state, null);
    const flushing = outbox.flush();
    outbox.enqueue("Edited", { ...state, playlistId: "edited" }, null);
    const other = { ...remote(), gameId: "00000000-0000-4000-8000-000000000005" };
    expect(() => outbox.activateRemote(other)).toThrow(
      "Game creation must finish before switching games",
    );
    expect(outbox.current?.name).toBe("Edited");
    posting.resolve(remote());
    await flushing;
    expect(save).toHaveBeenCalledWith(
      serverGameId,
      expect.objectContaining({
        name: "Edited",
        state: { ...state, playlistId: "edited" },
      }),
    );
    outbox.activateRemote(other);
    expect(outbox.gameId).toBe("00000000-0000-4000-8000-000000000005");
    expect(outbox.current?.name).toBe("Table A");
    expect(localStorage.getItem(`${gameSessionStorageKey}.parked.${creationId}`)).toBeNull();
    expect(
      parseCurrentGameSessionEnvelope(
        localStorage.getItem(`${gameSessionStorageKey}.parked.${serverGameId}`)!,
      ),
    ).toMatchObject({
      gameId: serverGameId,
      creationId: null,
      current: { name: "Edited", state: { playlistId: "edited" } },
    });
  });

  it("requires the storage guard for edits before creation acknowledgment", async () => {
    const localStorage = storage();
    let outbox: GameSessionOutbox | undefined;
    await withBrowserGameStorageGuard((storageGuard) => {
      outbox = new GameSessionOutbox({
        storage: localStorage,
        storageGuard,
        clubId,
        createId: () => creationId,
        create: vi.fn(),
        save: vi.fn(),
      });
      outbox.beginCreation("Draft", state, null);
    });
    expect(() => outbox?.enqueue("Edited", { ...state, playlistId: "edited" }, null)).toThrow(
      "Browser game storage lock is not held",
    );
    expect(readPersisted(localStorage)).toMatchObject({ current: { name: "Draft" } });
  });

  it("persists the creation retry identity before the first POST and adopts only its server GUID", async () => {
    const localStorage = storage();
    const create = vi.fn().mockResolvedValue(remote());
    const outbox = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: vi.fn().mockReturnValueOnce(creationId).mockReturnValueOnce(mutationId),
      create,
      save: vi.fn(),
    });

    outbox.beginCreation("Table A", state, null);
    const persisted = parseCurrentGameSessionEnvelope(localStorage.getItem(gameSessionStorageKey)!);
    expect(persisted).toMatchObject({
      version: 5,
      gameId: null,
      creationId,
      current: { name: "Table A" },
    });

    await outbox.flush();

    expect(create).toHaveBeenCalledWith({ creationId, name: "Table A", state, results: null });
    expect(outbox.gameId).toBe(serverGameId);
    expect(outbox.pendingCount).toBe(0);
  });

  it("uses the server GUID for snapshots and keeps newer local changes after a save", async () => {
    const save = vi.fn().mockResolvedValue(remote());
    const outbox = new GameSessionOutbox({
      storage: storage(),
      clubId,
      createId: () => mutationId,
      create: vi.fn().mockResolvedValue(remote()),
      save,
    });
    outbox.activateRemote(remote());
    outbox.enqueue("Table A", { ...state, playlistId: "changed" }, null);

    await outbox.flush();

    expect(save).toHaveBeenCalledWith(
      serverGameId,
      expect.objectContaining({
        mutationId,
        state: expect.objectContaining({ playlistId: "changed" }),
      }),
    );
    expect(outbox.pendingCount).toBe(0);
  });

  it("marks a deleted GUID removed, clears retries, and never creates a replacement", async () => {
    const create = vi.fn();
    const outbox = new GameSessionOutbox({
      storage: storage(),
      clubId,
      createId: () => mutationId,
      create,
      save: vi.fn().mockRejectedValue(new ApiError("missing", 404, "not_found")),
    });
    outbox.activateRemote(remote());
    outbox.enqueue("Table A", { ...state, playlistId: "deleted" }, null);

    await outbox.flush().catch(() => undefined);
    outbox.enqueue("Table A", state, null);

    expect(outbox.isRemoved).toBe(true);
    expect(outbox.pendingCount).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("parks unsent changes before opening another server game and restores them when reopened", () => {
    const localStorage = storage();
    const outbox = new GameSessionOutbox({
      storage: localStorage,
      clubId,
      createId: () => mutationId,
      create: vi.fn().mockResolvedValue(remote()),
      save: vi.fn(),
    });
    outbox.activateRemote(remote());
    outbox.enqueue("Table A", { ...state, playlistId: "pending" }, null);

    outbox.activateRemote(remote("00000000-0000-4000-8000-000000000005"));
    expect(outbox.gameId).toBe("00000000-0000-4000-8000-000000000005");

    outbox.activateRemote(remote());
    expect(outbox.current?.state.playlistId).toBe("pending");
    expect(outbox.pendingCount).toBe(1);
  });

  it("keeps queued offline edits when reopening the same active game", () => {
    const outbox = new GameSessionOutbox({
      storage: storage(),
      clubId,
      createId: () => mutationId,
      save: vi.fn(),
    });
    outbox.activateRemote(remote());
    outbox.enqueue("Table A", { ...state, playlistId: "offline-edit" }, null);

    outbox.activateRemote(remote());

    expect(outbox.current?.state.playlistId).toBe("offline-edit");
    expect(outbox.pendingCount).toBe(1);
  });
});
