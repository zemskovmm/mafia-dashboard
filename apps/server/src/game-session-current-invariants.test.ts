import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createGameLogEntry, type GameState } from "@mafia/game-domain";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { GameSessionStore } from "./game-session-store.js";

const ownerId = "00000000-0000-4000-8000-000000000001";
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia@127.0.0.1:54329/mafia_test";
const schemaName = `game_session_current_invariants_${randomUUID().replaceAll("-", "")}`;
const schemaPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schemaName}`,
});
const store = new GameSessionStore(pool);
const createdClubs = new Set<string>();

type SessionState = Parameters<GameSessionStore["save"]>[0]["state"];
type SaveInput = Parameters<GameSessionStore["save"]>[0];
type Claim = SaveInput["claim"];

const roles = [
  "sheriff",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "mafia",
  "mafia",
  "don",
] as const;

const currentState = (overrides: Partial<SessionState> = {}): SessionState => ({
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
  ...overrides,
});

const createClub = async (name = `Current invariant ${randomUUID()}`): Promise<string> => {
  const clubId = randomUUID();
  createdClubs.add(clubId);
  await pool.query(
    `INSERT INTO clubs (id, name, city, created_by)
     VALUES ($1, $2, 'Málaga', $3)`,
    [clubId, name, ownerId],
  );
  return clubId;
};

const createPlayers = async (clubId: string) => {
  const hostPlayerId = randomUUID();
  const playerIds = Array.from({ length: 10 }, () => randomUUID());
  const ids = [hostPlayerId, ...playerIds];
  await pool.query(
    `INSERT INTO players (id, club_id, nickname)
     SELECT fixture.id, $2, fixture.nickname
       FROM UNNEST($1::uuid[], $3::text[]) AS fixture(id, nickname)`,
    [ids, clubId, ids.map((id, index) => `Invariant ${index} ${id}`)],
  );
  return { hostPlayerId, playerIds };
};

const dayGame = (playerIds: readonly string[]): GameState => ({
  phase: "day",
  day: 1,
  players: playerIds.map((id, index) => {
    const role = roles[index]!;
    return {
      id,
      name: `Player ${index + 1}`,
      seat: index + 1,
      role,
      team: role === "mafia" || role === "don" ? "black" : "red",
      status: "active",
      fouls: 0,
      mutePending: false,
    };
  }),
  turnOrder: Array.from({ length: 10 }, (_value, index) => index + 1),
  currentTurnIndex: 0,
  nominations: [],
  voteAssignments: {},
  shotAssignments: {},
  winner: null,
});

const finishedGame = (playerIds: readonly string[]): GameState => ({
  ...dayGame(playerIds),
  phase: "finished",
  day: 2,
  bestMove: { playerSeat: 1, selectedSeats: [2, 3, 4], mafiaHits: 2 },
  winner: "red",
});

const createSession = async (
  clubId: string,
  state: SessionState = currentState(),
  name = "Current session",
) => {
  const gameId = randomUUID();
  const claimId = randomUUID();
  const input = {
    clubId,
    gameId,
    name,
    mutationId: randomUUID(),
    baseRevision: 0,
    state,
    results: null,
    claim: { claimId, claimGeneration: 0 },
    claimedByUserId: ownerId,
  } as const;
  const saved = await store.save(input);
  if (saved.claim === undefined) throw new Error("New active session did not return a claim");
  return {
    gameId,
    claim: { claimId, claimGeneration: saved.claim.generation } satisfies Claim,
    saved,
    input,
  };
};

const saveCurrent = async (
  clubId: string,
  gameId: string,
  claim: Claim,
  state: SessionState,
  baseRevision: number,
  name = "Current session",
  mutationId = randomUUID(),
) =>
  store.save({
    clubId,
    gameId,
    name,
    mutationId,
    baseRevision,
    state,
    results: null,
    claim,
    claimedByUserId: ownerId,
  });

const startDaySession = async (clubId: string, rootId = randomUUID()) => {
  const { hostPlayerId, playerIds } = await createPlayers(clubId);
  const session = await createSession(
    clubId,
    currentState({ hostPlayerId, hostName: "Invariant Host" }),
    "Current replay",
  );
  const initialGame = { replayVersion: 1 as const, game: dayGame(playerIds) };
  const root = createGameLogEntry({
    gameId: session.gameId,
    id: rootId,
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-09-05T10:00:00.000Z",
    before: initialGame.game,
    draft: { type: "game.checkpointed", payload: {} },
  });
  const started = await store.start({
    clubId,
    gameId: session.gameId,
    mutationId: randomUUID(),
    baseRevision: session.saved.revision,
    initialGame,
    event: root.entry,
    claim: session.claim,
  });
  return { ...session, hostPlayerId, playerIds, initialGame, root, started };
};

const completeRedSession = async (clubId: string, playedAt = "2026-09-05T10:02:00.000Z") => {
  const { hostPlayerId, playerIds } = await createPlayers(clubId);
  const session = await createSession(
    clubId,
    currentState({ hostPlayerId, hostName: "Completed Host" }),
    "Completed current replay",
  );
  const initialGame = { replayVersion: 1 as const, game: finishedGame(playerIds) };
  const root = createGameLogEntry({
    gameId: session.gameId,
    id: randomUUID(),
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-09-05T10:00:00.000Z",
    before: initialGame.game,
    draft: { type: "game.checkpointed", payload: {} },
  });
  await store.start({
    clubId,
    gameId: session.gameId,
    mutationId: randomUUID(),
    baseRevision: 1,
    initialGame,
    event: root.entry,
    claim: session.claim,
  });
  const terminal = createGameLogEntry({
    gameId: session.gameId,
    id: randomUUID(),
    sequence: 2,
    parentEventId: root.entry.id,
    createdAt: playedAt,
    before: root.after,
    draft: { type: "game.completed", payload: { winner: "red" } },
  });
  await store.appendEvent({
    clubId,
    gameId: session.gameId,
    mutationId: randomUUID(),
    baseRevision: 2,
    event: terminal.entry,
    claim: session.claim,
  });
  const results = {
    hostPlayerId,
    outcome: "red" as const,
    winner: "red" as const,
    reason: null,
    playedAt,
    players: terminal.after.players.map(({ id, seat, role, team, status, fouls }) => ({
      playerId: id,
      seat,
      role,
      team,
      status,
      fouls,
      bestMoveHits: seat === 1 ? 2 : null,
    })),
  };
  const completionMutationId = randomUUID();
  const completed = await store.complete({
    clubId,
    gameId: session.gameId,
    mutationId: completionMutationId,
    baseRevision: 3,
    results,
    claim: session.claim,
  });
  return {
    ...session,
    hostPlayerId,
    playerIds,
    root,
    terminal,
    results,
    completionMutationId,
    completed,
  };
};

beforeAll(async () => {
  await schemaPool.query(`CREATE SCHEMA ${schemaName}`);
  await store.initialize();
});

afterEach(async () => {
  const clubIds = [...createdClubs];
  createdClubs.clear();
  if (clubIds.length === 0) return;
  await pool.query("DELETE FROM game_events WHERE club_id = ANY($1::uuid[])", [clubIds]);
  await pool.query("DELETE FROM game_results WHERE club_id = ANY($1::uuid[])", [clubIds]);
  await pool.query("DELETE FROM game_sessions WHERE club_id = ANY($1::uuid[])", [clubIds]);
  await pool.query("DELETE FROM deleted_games WHERE club_id = ANY($1::uuid[])", [clubIds]);
  await pool.query("DELETE FROM players WHERE club_id = ANY($1::uuid[])", [clubIds]);
  await pool.query("DELETE FROM clubs WHERE id = ANY($1::uuid[])", [clubIds]);
});

afterAll(async () => {
  await pool.end();
  await schemaPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await schemaPool.end();
});

describe("GameSessionStore current snapshot invariants", () => {
  it("serializes concurrent first active saves in one club and keeps other clubs independent", async () => {
    const contestedClubId = await createClub("Contested current sessions");
    const firstIndependentClubId = await createClub("First independent current session");
    const secondIndependentClubId = await createClub("Second independent current session");

    const contested = await Promise.allSettled([
      createSession(contestedClubId),
      createSession(contestedClubId),
    ]);
    expect(contested.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(contested.find(({ status }) => status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { code: "club_active_game_exists" },
    });
    expect(await store.listActive(contestedClubId)).toHaveLength(1);

    const independent = await Promise.allSettled([
      createSession(firstIndependentClubId),
      createSession(secondIndependentClubId),
    ]);
    expect(independent.every(({ status }) => status === "fulfilled")).toBe(true);
    await expect(store.listActive(firstIndependentClubId)).resolves.toHaveLength(1);
    await expect(store.listActive(secondIndependentClubId)).resolves.toHaveLength(1);
  });

  it("starts a current replay with matching snapshot and relational projections", async () => {
    const clubId = await createClub();
    const fixture = await startDaySession(clubId);

    expect(fixture.started).toMatchObject({
      revision: 2,
      state: {
        game: fixture.root.after,
        initialGame: fixture.initialGame,
        events: [fixture.root.entry],
        headEventId: fixture.root.entry.id,
        resetReturnEventId: null,
      },
    });
    const projection = await pool.query<{
      initial_game: unknown;
      replay_base_event_id: string;
      head_event_id: string;
      event_count: number;
      replay_count: number;
    }>(
      `SELECT session.initial_game, session.replay_base_event_id, session.head_event_id,
              COUNT(event.id)::int AS event_count,
              COUNT(event.id) FILTER (WHERE event.replay_sequence IS NOT NULL)::int AS replay_count
         FROM game_sessions AS session
         LEFT JOIN game_events AS event
           ON event.club_id = session.club_id AND event.game_id = session.id
        WHERE session.club_id = $1 AND session.id = $2
        GROUP BY session.id, session.initial_game, session.replay_base_event_id, session.head_event_id`,
      [clubId, fixture.gameId],
    );
    expect(projection.rows).toEqual([
      {
        initial_game: fixture.initialGame,
        replay_base_event_id: fixture.root.entry.id,
        head_event_id: fixture.root.entry.id,
        event_count: 2,
        replay_count: 1,
      },
    ]);
  });

  it("rejects intermediate replay entries without changing the current head", async () => {
    const clubId = await createClub();
    const fixture = await startDaySession(clubId);
    const intermediate = createGameLogEntry({
      gameId: fixture.gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: fixture.root.entry.id,
      createdAt: "2026-09-05T10:01:00.000Z",
      before: fixture.root.after,
      draft: { type: "turn.completed", payload: { seat: 1 } },
    });

    await expect(
      store.appendEvent({
        clubId,
        gameId: fixture.gameId,
        mutationId: randomUUID(),
        baseRevision: 2,
        event: intermediate.entry,
        claim: fixture.claim,
      }),
    ).rejects.toMatchObject({ code: "game_session_event_intermediate" });
    await expect(store.get(fixture.gameId, clubId)).resolves.toMatchObject({
      revision: 2,
      state: { headEventId: fixture.root.entry.id, events: [fixture.root.entry] },
    });
    await expect(
      pool.query<{ replay_count: number }>(
        `SELECT COUNT(*)::int AS replay_count
           FROM game_events
          WHERE club_id = $1 AND game_id = $2 AND replay_sequence IS NOT NULL`,
        [clubId, fixture.gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ replay_count: 1 }] });
  });

  it("keeps inactive canonical history immutable while allowing a reset branch", async () => {
    const clubId = await createClub();
    const fixture = await startDaySession(clubId);
    const first = createGameLogEntry({
      gameId: fixture.gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: fixture.root.entry.id,
      createdAt: "2026-09-05T10:01:00.000Z",
      before: fixture.root.after,
      draft: { type: "foul.issued", payload: { seat: 1, foulNumber: 1, redCarded: false } },
    });
    await store.appendEvent({
      clubId,
      gameId: fixture.gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
      event: first.entry,
      claim: fixture.claim,
    });
    const reset = await store.moveHead({
      clubId,
      gameId: fixture.gameId,
      mutationId: randomUUID(),
      baseRevision: 3,
      targetEventId: fixture.root.entry.id,
      reason: "reset",
      claim: fixture.claim,
    });
    expect(reset).toMatchObject({
      revision: 4,
      state: {
        events: [fixture.root.entry],
        headEventId: fixture.root.entry.id,
        resetReturnEventId: first.entry.id,
      },
    });

    const branch = createGameLogEntry({
      gameId: fixture.gameId,
      id: randomUUID(),
      sequence: 3,
      parentEventId: fixture.root.entry.id,
      createdAt: "2026-09-05T10:02:00.000Z",
      before: fixture.root.after,
      draft: { type: "foul.issued", payload: { seat: 3, foulNumber: 1, redCarded: false } },
    });
    const branched = await store.appendEvent({
      clubId,
      gameId: fixture.gameId,
      mutationId: randomUUID(),
      baseRevision: 4,
      event: branch.entry,
      claim: fixture.claim,
    });
    expect(branched).toMatchObject({
      revision: 5,
      state: {
        events: [fixture.root.entry, branch.entry],
        headEventId: branch.entry.id,
        resetReturnEventId: null,
      },
    });

    const canonicalRows = await pool.query<{
      id: string;
      parent_event_id: string | null;
      replay_sequence: number;
    }>(
      `SELECT id, parent_event_id, replay_sequence
         FROM game_events
        WHERE club_id = $1 AND game_id = $2 AND replay_sequence IS NOT NULL
        ORDER BY replay_sequence`,
      [clubId, fixture.gameId],
    );
    expect(canonicalRows.rows).toEqual([
      { id: fixture.root.entry.id, parent_event_id: null, replay_sequence: 1 },
      { id: first.entry.id, parent_event_id: fixture.root.entry.id, replay_sequence: 2 },
      { id: branch.entry.id, parent_event_id: fixture.root.entry.id, replay_sequence: 3 },
    ]);

    const reused = createGameLogEntry({
      gameId: fixture.gameId,
      id: first.entry.id,
      sequence: 4,
      parentEventId: branch.entry.id,
      createdAt: "2026-09-05T10:03:00.000Z",
      before: branch.after,
      draft: { type: "foul.issued", payload: { seat: 4, foulNumber: 1, redCarded: false } },
    });
    await expect(
      store.appendEvent({
        clubId,
        gameId: fixture.gameId,
        mutationId: randomUUID(),
        baseRevision: 5,
        event: reused.entry,
        claim: fixture.claim,
      }),
    ).rejects.toMatchObject({ code: "game_session_event_conflict" });
  });

  it("serializes concurrent appends to one current replay head", async () => {
    const clubId = await createClub();
    const fixture = await startDaySession(clubId);
    const entries = [2, 3].map(
      (seat) =>
        createGameLogEntry({
          gameId: fixture.gameId,
          id: randomUUID(),
          sequence: 2,
          parentEventId: fixture.root.entry.id,
          createdAt: `2026-09-05T10:0${seat}:00.000Z`,
          before: fixture.root.after,
          draft: { type: "foul.issued", payload: { seat, foulNumber: 1, redCarded: false } },
        }).entry,
    );

    const settled = await Promise.allSettled(
      entries.map((event) =>
        store.appendEvent({
          clubId,
          gameId: fixture.gameId,
          mutationId: randomUUID(),
          baseRevision: 2,
          event,
          claim: fixture.claim,
        }),
      ),
    );
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(settled.find(({ status }) => status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { name: "GameSessionConflictError", currentRevision: 3 },
    });
    await expect(
      pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM game_events
          WHERE club_id = $1 AND game_id = $2 AND replay_sequence = 2`,
        [clubId, fixture.gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("persists a completed current snapshot and rejects new mutations while retaining exact retries", async () => {
    const clubId = await createClub();
    const fixture = await completeRedSession(clubId);
    const retry = await store.complete({
      clubId,
      gameId: fixture.gameId,
      mutationId: fixture.completionMutationId,
      baseRevision: 3,
      results: fixture.results,
      claim: fixture.claim,
    });
    expect(retry).toMatchObject({ duplicate: true, revision: 4, results: fixture.results });
    const stored = await store.get(fixture.gameId, clubId);
    expect(stored).toMatchObject({
      status: "completed",
      revision: 4,
      results: fixture.results,
      state: {
        game: fixture.terminal.after,
        events: [fixture.root.entry, fixture.terminal.entry],
        headEventId: fixture.terminal.entry.id,
      },
    });
    expect(stored).not.toHaveProperty("claim");

    await expect(
      store.moveHead({
        clubId,
        gameId: fixture.gameId,
        mutationId: randomUUID(),
        baseRevision: 4,
        targetEventId: fixture.root.entry.id,
        reason: "reset",
        claim: fixture.claim,
      }),
    ).rejects.toMatchObject({ code: "game_session_completed" });
    await expect(
      store.clear({
        clubId,
        gameId: fixture.gameId,
        expectedRevision: 4,
        claim: fixture.claim,
      }),
    ).rejects.toMatchObject({ code: "game_session_completed" });

    const projection = await pool.query<{
      results: number;
      player_results: number;
      canonical_events: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM game_results WHERE club_id = $1 AND game_id = $2) AS results,
         (SELECT COUNT(*)::int FROM game_player_results WHERE club_id = $1 AND game_id = $2) AS player_results,
         (SELECT COUNT(*)::int FROM game_events
           WHERE club_id = $1 AND game_id = $2 AND replay_sequence IS NOT NULL) AS canonical_events`,
      [clubId, fixture.gameId],
    );
    expect(projection.rows).toEqual([{ results: 1, player_results: 10, canonical_events: 2 }]);
  });

  it("keeps completed history filters scoped to current result projections", async () => {
    const clubId = await createClub();
    const first = await completeRedSession(clubId, "2026-09-04T23:59:59.999Z");
    const second = await completeRedSession(clubId, "2026-09-05T00:00:00.000Z");

    const onSecondDate = await store.listCompleted(clubId, {
      from: "2026-09-05",
      to: "2026-09-05",
      playerId: second.playerIds[0],
      outcome: "red",
    });
    expect(onSecondDate).toEqual([
      expect.objectContaining({
        gameId: second.gameId,
        outcome: "red",
        winner: "red",
        playedAt: "2026-09-05T00:00:00.000Z",
        eventCount: 3,
      }),
    ]);
    expect(onSecondDate.map(({ gameId }) => gameId)).not.toContain(first.gameId);
  });

  it("allows the same canonical event ID in independent clubs without cross-tenant reads", async () => {
    const firstClubId = await createClub("First event tenant");
    const secondClubId = await createClub("Second event tenant");
    const sharedEventId = randomUUID();
    const first = await startDaySession(firstClubId, sharedEventId);
    const second = await startDaySession(secondClubId, sharedEventId);

    await expect(store.get(first.gameId, secondClubId)).resolves.toBeNull();
    await expect(store.get(second.gameId, firstClubId)).resolves.toBeNull();
    const eventTenants = await pool.query<{ club_id: string }>(
      "SELECT club_id FROM game_events WHERE id = $1 ORDER BY club_id",
      [sharedEventId],
    );
    expect(eventTenants.rows).toEqual(
      [{ club_id: firstClubId }, { club_id: secondClubId }].sort((left, right) =>
        left.club_id.localeCompare(right.club_id),
      ),
    );
  });

  it("uses the full current browser snapshot as the save aggregate and preserves its projections", async () => {
    const clubId = await createClub();
    const fixture = await startDaySession(clubId);
    const snapshot = currentState({
      ...fixture.started.state,
      playlistId: "browser-authoritative",
    });

    const saved = await saveCurrent(
      clubId,
      fixture.gameId,
      fixture.claim,
      snapshot,
      0,
      "Current replay",
    );
    expect(saved).toMatchObject({ revision: 3, duplicate: false, state: snapshot });
    await expect(store.get(fixture.gameId, clubId)).resolves.toMatchObject({
      revision: 3,
      state: snapshot,
    });
    await expect(
      pool.query<{
        replay_base_event_id: string;
        head_event_id: string;
        state: { playlistId: string };
      }>(
        `SELECT replay_base_event_id, head_event_id, state
           FROM game_sessions
          WHERE club_id = $1 AND id = $2`,
        [clubId, fixture.gameId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          replay_base_event_id: fixture.root.entry.id,
          head_event_id: fixture.root.entry.id,
          state: { playlistId: "browser-authoritative" },
        },
      ],
    });
  });

  it("makes save retries exact and returns the newest coherent current snapshot", async () => {
    const clubId = await createClub();
    const state = currentState();
    const session = await createSession(clubId, state, "Exact retry");

    await expect(store.save(session.input)).resolves.toMatchObject({
      gameId: session.gameId,
      revision: 1,
      duplicate: true,
      state,
    });
    await expect(
      store.save({
        ...session.input,
        state: currentState({ playlistId: "different" }),
      }),
    ).rejects.toMatchObject({ name: "GameSessionMutationMismatchError" });

    await saveCurrent(
      clubId,
      session.gameId,
      session.claim,
      currentState({ playlistId: "newest" }),
      1,
      "Exact retry",
    );
    await expect(store.save(session.input)).resolves.toMatchObject({
      revision: 2,
      duplicate: true,
      state: { playlistId: "newest" },
    });
  });

  it("rejects a stale clear without tombstoning the newer current snapshot", async () => {
    const clubId = await createClub();
    const session = await createSession(clubId, currentState(), "Stale clear");
    await saveCurrent(
      clubId,
      session.gameId,
      session.claim,
      currentState({ playlistId: "newer" }),
      1,
      "Stale clear",
    );

    await expect(
      store.clear({
        clubId,
        gameId: session.gameId,
        expectedRevision: 1,
        claim: session.claim,
      }),
    ).rejects.toMatchObject({ name: "GameSessionConflictError", currentRevision: 2 });
    await expect(store.get(session.gameId, clubId)).resolves.toMatchObject({
      revision: 2,
      state: { playlistId: "newer" },
    });
    await store.clear({
      clubId,
      gameId: session.gameId,
      expectedRevision: 2,
      claim: session.claim,
    });
    await expect(store.get(session.gameId, clubId)).resolves.toBeNull();
  });

  it("tombstones a client game ID before first save and rejects the late current snapshot", async () => {
    const clubId = await createClub();
    const gameId = randomUUID();
    const claim = { claimId: randomUUID(), claimGeneration: 0 } satisfies Claim;
    await store.clear({ clubId, gameId, claim });

    await expect(
      store.save({
        clubId,
        gameId,
        name: "Too late",
        mutationId: randomUUID(),
        baseRevision: 0,
        state: currentState(),
        results: null,
        claim,
        claimedByUserId: ownerId,
      }),
    ).rejects.toMatchObject({ code: "game_deleted" });
    await expect(
      pool.query<{ sessions: number; events: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM game_sessions WHERE club_id = $1 AND id = $2) AS sessions,
           (SELECT COUNT(*)::int FROM game_events WHERE club_id = $1 AND game_id = $2) AS events`,
        [clubId, gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ sessions: 0, events: 0 }] });
  });

  it("fences displaced claims while allowing an exact duplicate creation retry", async () => {
    const clubId = await createClub();
    const session = await createSession(clubId, currentState(), "Claim fence");
    const replacementClaimId = randomUUID();

    await expect(
      store.takeover({
        clubId,
        gameId: session.gameId,
        claim: { claimId: replacementClaimId, claimGeneration: 0 },
        claimedByUserId: ownerId,
      }),
    ).resolves.toMatchObject({ generation: 2, expiresAt: expect.any(Date) });
    await expect(
      store.claim({
        clubId,
        gameId: session.gameId,
        claim: session.claim,
        claimedByUserId: ownerId,
      }),
    ).rejects.toMatchObject({ code: "game_session_claim_conflict" });
    await expect(store.save(session.input)).resolves.toMatchObject({
      duplicate: true,
      revision: 1,
    });
    await store.release({
      clubId,
      gameId: session.gameId,
      claim: { claimId: replacementClaimId, claimGeneration: 2 },
    });
    await expect(
      store.claim({
        clubId,
        gameId: session.gameId,
        claim: { claimId: randomUUID(), claimGeneration: 0 },
        claimedByUserId: ownerId,
      }),
    ).resolves.toMatchObject({ generation: 3, expiresAt: expect.any(Date) });
  });

  it("rejects rows whose snapshot projections no longer match the current state", async () => {
    const clubId = await createClub();
    const fixture = await startDaySession(clubId);
    await pool.query(
      "UPDATE game_sessions SET head_event_id = NULL WHERE club_id = $1 AND id = $2",
      [clubId, fixture.gameId],
    );

    await expect(store.get(fixture.gameId, clubId)).rejects.toMatchObject({
      code: "game_session_replay_invalid",
    });
  });

  it("does not make the default club visible when an active current session belongs elsewhere", async () => {
    const clubId = await createClub();
    const session = await startDaySession(clubId);

    await expect(store.get(session.gameId, DEFAULT_CLUB_ID)).resolves.toBeNull();
    await expect(store.listActive(DEFAULT_CLUB_ID)).resolves.toEqual([]);
    await expect(store.listActive(clubId)).resolves.toEqual([
      expect.objectContaining({ gameId: session.gameId, hostName: "Invariant Host" }),
    ]);
  });
});
