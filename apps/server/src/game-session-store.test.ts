import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { GameSessionStore } from "./game-session-store.js";

const ownerId = "00000000-0000-4000-8000-000000000001";
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia@127.0.0.1:54329/mafia_test";
const pool = new Pool({ connectionString: databaseUrl });
const store = new GameSessionStore(pool);
const createdGames = new Set<string>();
const createdClubs = new Set<string>();

const currentSetupState = () => ({
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
});

const saveCurrentSetup = async (clubId = DEFAULT_CLUB_ID, gameId = randomUUID()) => {
  createdGames.add(gameId);
  return store.save({
    clubId,
    gameId,
    name: `Current snapshot ${gameId}`,
    mutationId: randomUUID(),
    baseRevision: 0,
    state: currentSetupState(),
    results: null,
    claim: { claimId: randomUUID(), claimGeneration: 0 },
    claimedByUserId: ownerId,
  });
};

const createClub = async (): Promise<string> => {
  const clubId = randomUUID();
  createdClubs.add(clubId);
  await pool.query(
    `INSERT INTO clubs (id, name, city, created_by)
     VALUES ($1, $2, 'Málaga', $3)`,
    [clubId, `Current store ${clubId}`, ownerId],
  );
  return clubId;
};

beforeAll(async () => {
  await store.initialize();
});

afterEach(async () => {
  const gameIds = [...createdGames];
  createdGames.clear();
  if (gameIds.length > 0) {
    await pool.query("DELETE FROM game_events WHERE game_id = ANY($1::uuid[])", [gameIds]);
    await pool.query("DELETE FROM game_sessions WHERE id = ANY($1::uuid[])", [gameIds]);
    await pool.query("DELETE FROM deleted_games WHERE game_id = ANY($1::uuid[])", [gameIds]);
  }
  for (const clubId of createdClubs) await pool.query("DELETE FROM clubs WHERE id = $1", [clubId]);
  createdClubs.clear();
});

afterAll(async () => {
  await pool.end();
});

describe("GameSessionStore current snapshot contract", () => {
  it("does not expose the obsolete normalization operation", () => {
    expect("normalize" in store).toBe(false);
  });

  it("stores the complete browser-authoritative setup snapshot and its projections", async () => {
    const saved = await saveCurrentSetup();

    expect(saved.state).toStrictEqual(currentSetupState());
    expect(saved.results).toBeNull();
    const projection = await pool.query<{
      initial_game: unknown;
      head_event_id: string | null;
      reset_return_event_id: string | null;
      event_count: number;
    }>(
      `SELECT session.initial_game, session.head_event_id, session.reset_return_event_id,
              COUNT(event.id)::int AS event_count
         FROM game_sessions AS session
         LEFT JOIN game_events AS event
           ON event.club_id = session.club_id AND event.game_id = session.id
        WHERE session.id = $1
        GROUP BY session.id, session.initial_game, session.head_event_id, session.reset_return_event_id`,
      [saved.gameId],
    );
    expect(projection.rows).toEqual([
      { initial_game: null, head_event_id: null, reset_return_event_id: null, event_count: 1 },
    ]);
  });

  it("rejects a persisted snapshot missing current replay fields instead of repairing it", async () => {
    const saved = await saveCurrentSetup();
    await pool.query("UPDATE game_sessions SET state = $2::jsonb WHERE id = $1", [
      saved.gameId,
      JSON.stringify({
        setup: null,
        game: null,
        hostPlayerId: null,
        hostName: null,
        playlistId: "",
        log: [],
        undoHistory: [],
      }),
    ]);

    await expect(store.get(saved.gameId)).rejects.toMatchObject({
      code: "game_session_replay_invalid",
    });
  });

  it("keeps session reads isolated by club", async () => {
    const firstClubId = await createClub();
    const secondClubId = await createClub();
    const saved = await saveCurrentSetup(firstClubId);

    await expect(store.get(saved.gameId, secondClubId)).resolves.toBeNull();
    await expect(store.listActive(firstClubId)).resolves.toMatchObject([{ gameId: saved.gameId }]);
    await expect(store.listActive(secondClubId)).resolves.toEqual([]);
  });

  it("rejects a completed row without an explicit current result", async () => {
    const saved = await saveCurrentSetup();
    await pool.query("UPDATE game_sessions SET status = 'completed' WHERE id = $1", [saved.gameId]);

    await expect(store.get(saved.gameId)).rejects.toMatchObject({
      code: "game_session_replay_invalid",
    });
  });
});
