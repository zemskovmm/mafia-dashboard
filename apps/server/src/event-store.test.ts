import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { EventStore } from "./event-store.js";
import { GameSessionStore } from "./game-session-store.js";
import { ClubStore, DEFAULT_CLUB_ID } from "./club-store.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const pool = new Pool({ connectionString: databaseUrl });
const store = new EventStore(pool);
const legacyOwnerId = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  await store.initialize();
});

afterAll(async () => {
  await pool.end();
});

const waitForAdvisoryWaiters = async (expected: number): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiters: number }>(
      `SELECT COUNT(*)::int AS waiters
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%pg_advisory_xact_lock%'`,
    );
    if ((result.rows[0]?.waiters ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for advisory lock waiter");
};

describe("PostgreSQL event store", () => {
  it("assigns monotonic per-game sequences and reads events in order", async () => {
    const gameId = randomUUID();

    const first = await store.append({
      gameId,
      idempotencyKey: "first",
      type: "game.created",
      phase: "setup-players",
      payload: { name: "Friday game" },
      secret: false,
    });
    const second = await store.append({
      gameId,
      idempotencyKey: "second",
      type: "players.selected",
      phase: "setup-players",
      payload: { seats: 10 },
      secret: false,
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect((await store.read(gameId)).map(({ type }) => type)).toEqual([
      "game.created",
      "players.selected",
    ]);
  });

  it("returns the original event for a duplicate idempotency key", async () => {
    const gameId = randomUUID();
    const input = {
      gameId,
      idempotencyKey: "same-tap",
      type: "turn.started",
      phase: "day",
      seat: 3,
      payload: { seat: 3, seconds: 60 },
      secret: false,
    } as const;

    const first = await store.append(input);
    const duplicate = await store.append(input);

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.sequence).toBe(1);
    expect(await store.read(gameId)).toHaveLength(1);
  });

  it("redacts secret payloads from public reads", async () => {
    const gameId = randomUUID();
    await store.append({
      gameId,
      idempotencyKey: "don-check",
      type: "don.checked",
      phase: "night-don",
      seat: 4,
      payload: { targetSeat: 2, match: true },
      secret: true,
    });

    const host = await store.read(gameId, { includeSecrets: true });
    const publicEvents = await store.read(gameId, { includeSecrets: false });

    expect(host[0]?.payload).toEqual({ targetSeat: 2, match: true });
    expect(publicEvents[0]?.payload).toEqual({ redacted: true });
  });

  it("truncates the undone event tail by idempotency key while preserving game.created", async () => {
    const gameId = randomUUID();
    await store.append({
      gameId,
      idempotencyKey: "game-created",
      type: "game.created",
      phase: "setup-players",
      payload: {},
      secret: false,
    });
    await store.append({
      gameId,
      idempotencyKey: "undo-from-here",
      type: "turn.completed",
      phase: "day",
      payload: { day: 2 },
      secret: false,
    });
    await store.append({
      gameId,
      idempotencyKey: "later-event",
      type: "foul.issued",
      phase: "day",
      payload: { seat: 1 },
      secret: false,
    });

    await store.truncateFrom(gameId, "undo-from-here");
    await store.truncateFrom(gameId, "undo-from-here");
    await store.truncateFrom(gameId, "game-created");

    await expect(store.read(gameId)).resolves.toMatchObject([
      { sequence: 1, idempotencyKey: "game-created", type: "game.created" },
    ]);
  });

  it("tombstones an abandoned game, removes its active setup roster, and rejects late appends", async () => {
    const gameId = randomUUID();
    await store.append({
      gameId,
      idempotencyKey: "setup-roster",
      type: "setup.players-selected",
      phase: "setup-players",
      payload: { hostPlayerId: randomUUID(), players: [] },
      secret: false,
    });

    await store.deleteGame(gameId);

    await expect(store.read(gameId)).resolves.toEqual([]);
    await expect(
      store.append({
        gameId,
        idempotencyKey: "late-event",
        type: "turn.started",
        phase: "day",
        payload: {},
        secret: false,
      }),
    ).rejects.toMatchObject({ code: "game_deleted" });
  });

  it("serializes concurrent appends without duplicate sequence numbers", async () => {
    const gameId = randomUUID();

    const events = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.append({
          gameId,
          idempotencyKey: `event-${index}`,
          type: "log.test",
          phase: "day",
          payload: { index },
          secret: false,
        }),
      ),
    );

    expect(events.map(({ sequence }) => sequence).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("does not serialize the same game UUID across independent clubs", async () => {
    const club = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Independent lock ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      ownerConsent: true,
    });
    const gameId = randomUUID();
    const locker = await pool.connect();
    let local: ReturnType<EventStore["append"]> | undefined;
    let foreign: ReturnType<EventStore["append"]> | undefined;
    let foreignOutcome: string | undefined;
    let localOutcome: string | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [gameId]);
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [
        DEFAULT_CLUB_ID,
        gameId,
      ]);
      local = store.append({
        clubId: DEFAULT_CLUB_ID,
        gameId,
        idempotencyKey: "local",
        type: "game.created",
        phase: "setup-players",
        payload: {},
        secret: false,
      });
      foreign = store.append({
        clubId: club.id,
        gameId,
        idempotencyKey: "foreign",
        type: "game.created",
        phase: "setup-players",
        payload: {},
        secret: false,
      });
      foreignOutcome = await Promise.race([
        foreign.then(() => "completed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 250)),
      ]);
      localOutcome = await Promise.race([
        local.then(() => "completed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
      await Promise.allSettled([
        ...(local === undefined ? [] : [local]),
        ...(foreign === undefined ? [] : [foreign]),
      ]);
    }

    expect(foreignOutcome).toBe("completed");
    expect(localOutcome).toBe("blocked");
    await expect(store.read(gameId, { includeSecrets: true }, club.id)).resolves.toHaveLength(1);
    await expect(
      store.read(gameId, { includeSecrets: true }, DEFAULT_CLUB_ID),
    ).resolves.toHaveLength(1);
  });

  it("rejects an append queued behind an aggregate tombstone", async () => {
    const gameId = randomUUID();
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [
        DEFAULT_CLUB_ID,
        gameId,
      ]);
      const clear = new GameSessionStore(pool).clear(gameId);
      await waitForAdvisoryWaiters(1);
      const append = store.append({
        gameId,
        idempotencyKey: randomUUID(),
        type: "turn.started",
        phase: "day",
        payload: {},
        secret: false,
      });
      await waitForAdvisoryWaiters(2);
      await locker.query("COMMIT");

      await clear;
      await expect(append).rejects.toMatchObject({ code: "game_deleted" });
      await expect(store.read(gameId)).resolves.toEqual([]);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });
});
