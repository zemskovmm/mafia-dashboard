import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import type { AppUser } from "./google-auth.js";
import { initializeSchema } from "./initialize-schema.js";
import { PlayerStore } from "./player-store.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia@127.0.0.1:54329/mafia_test";
const schemaName = `game_records_api_${randomUUID().replaceAll("-", "")}`;
const schemaPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const owner = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@mafiamalaga.es",
  name: "Mafia Malaga owner",
  picture: null,
};

let app: Awaited<ReturnType<typeof buildApp>>;
let regularUserApp: Awaited<ReturnType<typeof buildApp>>;

const payload = (overrides: Record<string, unknown> = {}) => ({
  creationId: randomUUID(),
  name: "Snapshot record",
  // Deliberately not a game-domain-valid state: persistence accepts browser snapshots verbatim.
  state: { draft: { unexpectedPhase: true }, values: ["client", 1] },
  results: null,
  ...overrides,
});

const create = async (body = payload(), clubId = DEFAULT_CLUB_ID) =>
  app.inject({
    method: "POST",
    url: "/api/game-sessions",
    headers: { "x-club-id": clubId },
    payload: body,
  });

beforeAll(async () => {
  await schemaPool.query(`CREATE SCHEMA ${schemaName}`);
  await initializeSchema(pool);
  app = await buildApp({
    pool,
    defaultClubId: DEFAULT_CLUB_ID,
    authenticateRequest: async () => owner,
  });
  regularUserApp = await buildApp({
    pool,
    defaultClubId: DEFAULT_CLUB_ID,
    authenticateRequest: async () => ({
      id: randomUUID(),
      email: "regular@example.test",
      name: "Regular user",
      picture: null,
    }),
  });
  await app.ready();
  await regularUserApp.ready();
});

afterEach(async () => {
  await pool.query(
    `TRUNCATE game_player_results, game_results, game_session_players, game_session_mutations,
              game_sessions, game_session_creations, game_events, deleted_games CASCADE`,
  );
});

afterAll(async () => {
  await regularUserApp?.close();
  await app?.close();
  await pool.end();
  await schemaPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await schemaPool.end();
});

describe("server-backed game records", () => {
  it("creates a server-issued game GUID and deduplicates a lost creation response", async () => {
    const body = payload();

    const first = await create(body);
    expect(first.statusCode, first.body).toBe(201);
    const session = first.json();
    expect(session).toMatchObject({
      name: body.name,
      revision: 1,
      duplicate: false,
      status: "active",
      state: body.state,
      results: null,
    });
    expect(session.gameId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(session).not.toHaveProperty("claim");

    const retry = await create({ ...body, name: "ignored retry body" });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({
      gameId: session.gameId,
      name: body.name,
      duplicate: true,
    });

    await expect(
      pool.query(
        "SELECT game_id FROM game_session_creations WHERE club_id = $1 AND creation_id = $2",
        [DEFAULT_CLUB_ID, body.creationId],
      ),
    ).resolves.toMatchObject({ rows: [{ game_id: session.gameId }] });
  });

  it("updates only an existing record without a claim or revision precondition; the last commit wins", async () => {
    const created = await create();
    const gameId = created.json().gameId as string;
    const first = {
      operation: "snapshot",
      name: "Writer A",
      mutationId: randomUUID(),
      state: { writer: "A", invalidForTheOldGameRules: true },
      results: null,
    };
    const second = { ...first, name: "Writer B", mutationId: randomUUID(), state: { writer: "B" } };

    const savedA = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": DEFAULT_CLUB_ID },
      payload: first,
    });
    expect(savedA.statusCode, savedA.body).toBe(200);
    const savedB = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": DEFAULT_CLUB_ID },
      payload: second,
    });
    expect(savedB.statusCode, savedB.body).toBe(200);
    expect(savedB.json()).toMatchObject({ name: "Writer B", revision: 3, state: second.state });

    const item = await app.inject({
      method: "GET",
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": DEFAULT_CLUB_ID },
    });
    expect(item.statusCode).toBe(200);
    expect(item.json()).toMatchObject({
      session: { gameId, name: "Writer B", state: second.state },
    });
  });

  it("saves browser events and redacts private roles and check results in public log reads", async () => {
    const created = await create();
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    const events = [
      {
        id: randomUUID(),
        gameId,
        sequence: 1,
        type: "setup.role-assigned",
        payload: { seat: 1, role: "mafia", secret: true },
        phaseBefore: "setup-roles",
        phaseAfter: "setup-roles",
        dayBefore: 0,
        dayAfter: 0,
      },
      {
        id: randomUUID(),
        gameId,
        sequence: 2,
        type: "sheriff.checked",
        payload: { targetSeat: 1, match: true },
        phaseBefore: "night-sheriff-result",
        phaseAfter: "night-sheriff-result",
        dayBefore: 1,
        dayAfter: 1,
      },
      {
        id: randomUUID(),
        gameId,
        sequence: 3,
        type: "game.completed",
        payload: { winner: "red" },
        phaseBefore: "finished",
        phaseAfter: "finished",
        dayBefore: 1,
        dayAfter: 1,
      },
    ];
    const state = { game: { phase: "finished", day: 1 }, events, arbitraryBrowserField: true };
    const saved = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": DEFAULT_CLUB_ID },
      payload: {
        operation: "snapshot",
        mutationId: randomUUID(),
        name: "Eventful",
        state,
        results: null,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().state).toEqual(state);
    const persisted = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      "SELECT event_type, payload FROM game_events WHERE club_id = $1 AND game_id = $2 ORDER BY sequence",
      [DEFAULT_CLUB_ID, gameId],
    );
    expect(persisted.rows).toEqual(
      events.map(({ type, payload }) => ({ event_type: type, payload })),
    );
    const host = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    const publicLog = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/events?visibility=public`,
    });
    expect(host.statusCode).toBe(200);
    expect(publicLog.statusCode).toBe(200);
    expect(host.json().events.map(({ payload }: { payload: unknown }) => payload)).toEqual(
      events.map(({ payload }) => payload),
    );
    expect(publicLog.json().events.map(({ payload }: { payload: unknown }) => payload)).toEqual([
      { redacted: true },
      { redacted: true },
      { winner: "red" },
    ]);
    expect(publicLog.body).not.toContain("mafia");
    expect(publicLog.body).not.toContain("match");
  });

  it("lists all active records in the selected club and preserves a completed history projection", async () => {
    const activeOne = await create(payload({ name: "Active one" }));
    const activeTwo = await create(payload({ name: "Active two" }));
    const playerStore = new PlayerStore(pool);
    const host = await playerStore.create({
      nickname: `Host ${randomUUID().slice(0, 8)}`,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const participant = await playerStore.create({
      nickname: `Player ${randomUUID().slice(0, 8)}`,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const completed = await create(
      payload({
        name: "Completed",
        results: {
          hostPlayerId: host.id,
          outcome: "red",
          winner: "red",
          reason: null,
          playedAt: "2026-09-26T12:00:00.000Z",
          players: [
            {
              playerId: participant.id,
              seat: 1,
              role: "citizen",
              team: "red",
              status: "active",
              fouls: 0,
              bestMoveHits: null,
            },
          ],
        },
      }),
    );

    const active = await app.inject({
      method: "GET",
      url: "/api/game-sessions",
      headers: { "x-club-id": DEFAULT_CLUB_ID },
    });
    expect(active.statusCode).toBe(200);
    expect(
      active
        .json()
        .sessions.map(({ gameId }: { gameId: string }) => gameId)
        .sort(),
    ).toEqual([activeOne.json().gameId, activeTwo.json().gameId].sort());
    await expect(
      pool.query(
        "SELECT COUNT(*)::int AS count FROM game_results WHERE club_id = $1 AND game_id = $2",
        [DEFAULT_CLUB_ID, completed.json().gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    expect(completed.statusCode, completed.body).toBe(201);
    const history = await app.inject({
      method: "GET",
      url: `/api/game-sessions?status=completed&playerId=${participant.id}&outcome=red`,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().sessions).toMatchObject([
      { gameId: completed.json().gameId, outcome: "red", winner: "red", eventCount: 0 },
    ]);
    let profiles = await playerStore.list();
    expect(profiles.find(({ id }) => id === participant.id)).toMatchObject({
      statistics: { gamesPlayed: 1, wins: 1, losses: 0, citizenGames: 1 },
      lastPlayedAt: expect.any(Date),
    });
    expect(profiles.find(({ id }) => id === host.id)).toMatchObject({
      statistics: { hostedGames: 1, gamesPlayed: 0 },
      lastPlayedAt: expect.any(Date),
    });
    const gameId = completed.json().gameId as string;
    const correction = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: {
        operation: "snapshot",
        name: "Corrected result",
        mutationId: randomUUID(),
        state: { game: { phase: "finished" } },
        results: { ...completed.json().results, outcome: "black", winner: "black" },
      },
    });
    expect(correction.statusCode, correction.body).toBe(200);
    profiles = await playerStore.list();
    expect(profiles.find(({ id }) => id === participant.id)?.statistics).toMatchObject({
      gamesPlayed: 1,
      wins: 0,
      losses: 1,
    });
    expect(profiles.find(({ id }) => id === host.id)?.statistics.hostedGames).toBe(1);
  });

  it("deletes atomically and idempotently; a stale save and repeated creation cannot resurrect it", async () => {
    const body = payload();
    const created = await create(body);
    const gameId = created.json().gameId as string;
    await pool.query(
      `INSERT INTO game_session_mutations (club_id, game_id, mutation_id, revision, request)
       VALUES ($1, $2, $3, 1, '{}'::jsonb)`,
      [DEFAULT_CLUB_ID, gameId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO game_events (id, club_id, game_id, sequence, idempotency_key, event_type, phase)
       VALUES ($1, $2, $3, 1, $4, 'opaque', 'opaque')`,
      [randomUUID(), DEFAULT_CLUB_ID, gameId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO game_results (club_id, game_id, outcome, winner, reason, played_at)
       VALUES ($1, $2, 'red', 'red', NULL, NOW())`,
      [DEFAULT_CLUB_ID, gameId],
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": DEFAULT_CLUB_ID },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    const repeatedDelete = await app.inject({
      method: "DELETE",
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": DEFAULT_CLUB_ID },
    });
    expect(repeatedDelete.statusCode).toBe(204);

    const staleSave = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": DEFAULT_CLUB_ID },
      payload: {
        operation: "snapshot",
        name: "stale",
        mutationId: randomUUID(),
        state: { stale: true },
        results: null,
      },
    });
    expect(staleSave.statusCode).toBe(404);
    const retryCreate = await create(body);
    expect(retryCreate.statusCode).toBe(410);
    await expect(
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM game_sessions WHERE club_id = $1 AND id = $2) AS sessions,
           (SELECT COUNT(*)::int FROM game_session_mutations WHERE club_id = $1 AND game_id = $2) AS mutations,
           (SELECT COUNT(*)::int FROM game_events WHERE club_id = $1 AND game_id = $2) AS events,
           (SELECT COUNT(*)::int FROM game_results WHERE club_id = $1 AND game_id = $2) AS results`,
        [DEFAULT_CLUB_ID, gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ sessions: 0, mutations: 0, events: 0, results: 0 }] });
  });

  it("keeps active-player projections functional without validating the game snapshot", async () => {
    const players = new PlayerStore(pool);
    const host = await players.create({
      nickname: `Projection host ${randomUUID().slice(0, 8)}`,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const participant = await players.create({
      nickname: `Projection participant ${randomUUID().slice(0, 8)}`,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const created = await create(
      payload({
        state: {
          hostPlayerId: host.id,
          game: {
            phase: "not-validated",
            players: [{ id: participant.id, seat: 1, role: "citizen" }],
          },
        },
      }),
    );
    const gameId = created.json().gameId as string;

    const protectedDelete = await app.inject({
      method: "DELETE",
      url: `/api/players/${participant.id}`,
    });
    expect(protectedDelete.statusCode).toBe(409);
    expect(protectedDelete.json()).toEqual({ error: "active_game" });
    expect(
      await app.inject({ method: "DELETE", url: `/api/game-sessions/${gameId}` }),
    ).toHaveProperty("statusCode", 204);
    expect(
      await app.inject({ method: "DELETE", url: `/api/players/${participant.id}` }),
    ).toHaveProperty("statusCode", 204);
  });

  it("requires a manager for every game-record CRUD operation", async () => {
    const requests = [
      { method: "GET", url: "/api/game-sessions" },
      { method: "POST", url: "/api/game-sessions", payload: payload() },
      { method: "GET", url: `/api/game-sessions/${randomUUID()}` },
      {
        method: "PUT",
        url: `/api/game-sessions/${randomUUID()}`,
        payload: { name: "blocked", mutationId: randomUUID(), state: {}, results: null },
      },
      { method: "DELETE", url: `/api/game-sessions/${randomUUID()}` },
    ] as const;

    for (const request of requests) {
      const response = await regularUserApp.inject({
        ...request,
        headers: { "x-club-id": DEFAULT_CLUB_ID },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
      expect(response.json()).toMatchObject({ error: "club_access_denied" });
    }
  });

  it("does not grant a manager in another club access to this club's records", async () => {
    const foreignClubId = randomUUID();
    const foreignUser: AppUser = {
      id: randomUUID(),
      email: `foreign-manager-${randomUUID()}@example.test`,
      name: "Foreign manager",
      picture: null,
    };
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [
      foreignUser.id,
      foreignUser.email,
      foreignUser.name,
    ]);
    await pool.query(
      `INSERT INTO clubs (id, name, city, created_by)
       VALUES ($1, $2, 'Málaga', $3)`,
      [foreignClubId, `Foreign ${foreignClubId}`, owner.id],
    );
    await pool.query(
      "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'manager')",
      [foreignClubId, foreignUser.id],
    );
    const created = await create(payload());
    const gameId = created.json().gameId as string;
    const foreignApp = await buildApp({ pool, authenticateRequest: async () => foreignUser });
    await foreignApp.ready();
    try {
      for (const request of [
        { method: "GET", url: "/api/game-sessions" },
        { method: "GET", url: `/api/game-sessions/${gameId}` },
        {
          method: "PUT",
          url: `/api/game-sessions/${gameId}`,
          payload: {
            operation: "snapshot",
            name: "Not allowed",
            mutationId: randomUUID(),
            state: {},
            results: null,
          },
        },
        { method: "DELETE", url: `/api/game-sessions/${gameId}` },
      ] as const) {
        const response = await foreignApp.inject({
          ...request,
          headers: { "x-club-id": DEFAULT_CLUB_ID },
        });
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
        expect(response.json()).toMatchObject({ error: "club_access_denied" });
      }
    } finally {
      await foreignApp.close();
      await pool.query("DELETE FROM clubs WHERE id = $1", [foreignClubId]);
      await pool.query("DELETE FROM users WHERE id = $1", [foreignUser.id]);
    }
  });
});
