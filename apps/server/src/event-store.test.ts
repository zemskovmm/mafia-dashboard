import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { EventStore } from "./event-store.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const pool = new Pool({ connectionString: databaseUrl });
const store = new EventStore(pool);

beforeAll(async () => {
  await store.initialize();
});

afterAll(async () => {
  await pool.end();
});

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
      type: "timer.started",
      phase: "day",
      payload: { seconds: 60 },
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
});
