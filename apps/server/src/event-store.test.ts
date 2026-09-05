import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { ClubStore, DEFAULT_CLUB_ID } from "./club-store.js";
import { EventStore } from "./event-store.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const schemaName = `event_store_test_${randomUUID().replaceAll("-", "")}`;
const bootstrapPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const store = new EventStore(pool);

beforeAll(async () => {
  await bootstrapPool.query(`CREATE SCHEMA ${schemaName}`);
  await store.initialize();
});

afterAll(async () => {
  await pool.end();
  await bootstrapPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await bootstrapPool.end();
});

const canonicalHash = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const createClub = async (): Promise<string> => {
  const userId = randomUUID();
  await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [
    userId,
    `event-store-${userId}@example.test`,
    "Event store test user",
  ]);
  const club = await new ClubStore(pool).create(userId, {
    name: `Event store club ${randomUUID().slice(0, 8)}`,
    city: "Málaga",
    headerLogo: null,
    cardLogo: null,
    language: "en",
    ownerConsent: true,
  });
  return club.id;
};

const insertEvent = async ({
  id = randomUUID(),
  clubId = DEFAULT_CLUB_ID,
  gameId,
  sequence,
  type,
  phase,
  payload,
  parentEventId = null,
  createdAt = "2026-08-18T08:00:00.000Z",
}: {
  readonly id?: string;
  readonly clubId?: string;
  readonly gameId: string;
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly parentEventId?: string | null;
  readonly createdAt?: string;
}): Promise<string> => {
  await pool.query(
    `INSERT INTO game_events
       (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload,
        parent_event_id, replay_version, replay_sequence, phase_after, day_before, day_after,
        state_hash_after, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 1, $4, $7, 0, 0, $10, $11)`,
    [
      id,
      clubId,
      gameId,
      sequence,
      randomUUID(),
      type,
      phase,
      JSON.stringify(payload),
      parentEventId,
      canonicalHash(`${gameId}:${sequence}:${type}`),
      createdAt,
    ],
  );
  return id;
};

describe("EventStore", () => {
  it("reads ordered canonical event records without mutating the event stream", async () => {
    const gameId = randomUUID();
    const checkpointId = await insertEvent({
      gameId,
      sequence: 1,
      type: "game.checkpointed",
      phase: "finished",
      payload: {},
      createdAt: "2026-08-18T07:59:00.000Z",
    });
    const completionId = await insertEvent({
      gameId,
      sequence: 2,
      type: "game.completed",
      phase: "finished",
      payload: { winner: "red" },
      parentEventId: checkpointId,
    });

    await expect(store.read(gameId)).resolves.toEqual([
      expect.objectContaining({
        id: checkpointId,
        sequence: 1,
        type: "game.checkpointed",
        payload: {},
        parentEventId: null,
        replayVersion: 1,
        stateHashAfter: canonicalHash(`${gameId}:1:game.checkpointed`),
      }),
      expect.objectContaining({
        id: completionId,
        sequence: 2,
        type: "game.completed",
        payload: { winner: "red" },
        parentEventId: checkpointId,
        replayVersion: 1,
        stateHashAfter: canonicalHash(`${gameId}:2:game.completed`),
      }),
    ]);
  });

  it("redacts secret event payloads and state hashes from public reads", async () => {
    const gameId = randomUUID();
    await insertEvent({
      gameId,
      sequence: 1,
      type: "sheriff.checked",
      phase: "night-sheriff-result",
      payload: { targetSeat: 4, match: true },
    });
    await insertEvent({
      gameId,
      sequence: 2,
      type: "game.completed",
      phase: "finished",
      payload: { winner: "black" },
    });

    const privateEvents = await store.read(gameId, { includeSecrets: true });
    const publicEvents = await store.read(gameId, { includeSecrets: false });

    expect(privateEvents[0]).toMatchObject({
      type: "sheriff.checked",
      payload: { targetSeat: 4, match: true },
      stateHashAfter: canonicalHash(`${gameId}:1:sheriff.checked`),
    });
    expect(publicEvents).toEqual([
      expect.objectContaining({
        type: "sheriff.checked",
        payload: { redacted: true },
        stateHashAfter: null,
      }),
      expect.objectContaining({
        type: "game.completed",
        payload: { winner: "black" },
        stateHashAfter: null,
      }),
    ]);
  });

  it("isolates event reads by club even when game IDs collide", async () => {
    const gameId = randomUUID();
    const foreignClubId = await createClub();
    await insertEvent({
      gameId,
      sequence: 1,
      type: "game.completed",
      phase: "finished",
      payload: { winner: "red" },
    });
    await insertEvent({
      clubId: foreignClubId,
      gameId,
      sequence: 1,
      type: "game.completed",
      phase: "finished",
      payload: { winner: "black" },
    });

    await expect(store.read(gameId, { includeSecrets: true })).resolves.toMatchObject([
      { payload: { winner: "red" } },
    ]);
    await expect(
      store.read(gameId, { includeSecrets: true }, foreignClubId),
    ).resolves.toMatchObject([{ payload: { winner: "black" } }]);
  });

  it("does not retain the removed raw event mutation surface", () => {
    const legacyStore = store as unknown as Record<string, unknown>;
    expect(legacyStore.append).toBeUndefined();
    expect(legacyStore.createGame).toBeUndefined();
    expect(legacyStore.complete).toBeUndefined();
    expect(legacyStore.clear).toBeUndefined();
  });
});
