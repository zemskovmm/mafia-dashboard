import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import type { AppUser } from "./google-auth.js";
import { initializeSchema } from "./initialize-schema.js";
import { PlayerStore } from "./player-store.js";
import {
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  hashGameState,
  replayGameLog,
} from "@mafia/game-domain";
import type { GameLogEntry, InitialGameBaseline } from "@mafia/game-domain";

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
const regularUser: AppUser = {
  id: randomUUID(),
  email: `regular-${randomUUID()}@example.test`,
  name: "Regular user",
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
  await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [
    regularUser.id,
    regularUser.email,
    regularUser.name,
  ]);
  await pool.query(
    "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'user')",
    [DEFAULT_CLUB_ID, regularUser.id],
  );
  app = await buildApp({
    pool,
    defaultClubId: DEFAULT_CLUB_ID,
    authenticateRequest: async () => owner,
  });
  regularUserApp = await buildApp({
    pool,
    defaultClubId: DEFAULT_CLUB_ID,
    authenticateRequest: async () => regularUser,
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
  it("round-trips partial player setup, then role progress and settings on one unfinished game ID", async () => {
    const players = new PlayerStore(pool);
    const roster = await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        players.create({
          nickname: `Setup ${index} ${randomUUID()}`,
          consent: false,
          firstName: null,
          lastName: null,
          email: null,
        }),
      ),
    );
    const hostId = roster[0]!.id;
    const seatIds = roster.slice(1).map(({ id }) => id);
    const selectedPlayerIds = Array.from({ length: 10 }, () => "");
    selectedPlayerIds[0] = seatIds[0]!;
    selectedPlayerIds[4] = seatIds[4]!;
    const state = {
      setup: {
        step: "players",
        hostPlayerId: "",
        selectedPlayerIds,
        setup: null,
        bestMoveEnabled: false,
      },
      game: null,
      hostPlayerId: null,
      playlistId: "PL-setup-table",
      log: [],
      undoHistory: [],
      undoBudget: 0,
      initialGame: null,
      events: [],
      headEventId: null,
      resetReturnEventId: null,
      legacyLog: [],
    };
    const body = payload({ name: "Unfinished setup", state, results: null });
    const created = await create(body);
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    expect(created.json()).toMatchObject({
      gameId,
      revision: 1,
      status: "active",
      state,
      results: null,
    });

    const active = await app.inject({ method: "GET", url: "/api/game-sessions?status=active" });
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json().sessions).toMatchObject([
      { gameId, name: "Unfinished setup", revision: 1, hostPlayerId: null, phase: "players" },
    ]);
    const detail = await app.inject({ method: "GET", url: `/api/game-sessions/${gameId}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().session).toMatchObject({ gameId, state, status: "active", results: null });
    expect(detail.json().session.state.setup.selectedPlayerIds).toEqual(selectedPlayerIds);

    // Clearing an assigned seat is an update, not a fresh game or a completed result.
    const changedSeats = [...selectedPlayerIds];
    changedSeats[0] = "";
    changedSeats[1] = seatIds[1]!;
    const editedState = { ...state, setup: { ...state.setup, selectedPlayerIds: changedSeats } };
    const edited = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: { name: body.name, mutationId: randomUUID(), state: editedState, results: null },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({
      gameId,
      revision: 2,
      status: "active",
      state: editedState,
      results: null,
    });
    const editedDetail = await app.inject({ method: "GET", url: `/api/game-sessions/${gameId}` });
    expect(editedDetail.statusCode, editedDetail.body).toBe(200);
    expect(editedDetail.json().session.state).toEqual(editedState);

    const setup = drawRoleForSeat(
      beginRoleDraw(
        createSetup(seatIds.map((id, index) => ({ id, seat: index + 1 }))),
        createSeededRandom(41),
      ),
      1,
    );
    expect(setup.assignments[1]).toBeDefined();
    expect(setup.remainingRoles).toHaveLength(9);
    const roleState = {
      ...editedState,
      hostPlayerId: hostId,
      setup: {
        step: "roles",
        hostPlayerId: hostId,
        selectedPlayerIds: seatIds,
        setup,
        bestMoveEnabled: false,
      },
    };
    const roleSave = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: { name: body.name, mutationId: randomUUID(), state: roleState, results: null },
    });
    expect(roleSave.statusCode, roleSave.body).toBe(200);
    expect(roleSave.json()).toMatchObject({
      gameId,
      revision: 3,
      status: "active",
      state: roleState,
      results: null,
    });
    const resumed = await app.inject({ method: "GET", url: `/api/game-sessions/${gameId}` });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json().session).toMatchObject({
      gameId,
      revision: 3,
      state: roleState,
      status: "active",
      results: null,
    });
    expect(resumed.json().session.state.setup.setup).toEqual(setup);
    const listed = await app.inject({ method: "GET", url: "/api/game-sessions" });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().sessions).toMatchObject([
      { gameId, revision: 3, hostPlayerId: hostId, phase: "roles" },
    ]);
    const history = await app.inject({ method: "GET", url: "/api/game-sessions?status=completed" });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().sessions).toEqual([]);
    const retry = await create(body);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ gameId, revision: 3, duplicate: true, state: roleState });
    const persisted = await pool.query(
      `SELECT id, revision, status, state, results FROM game_sessions WHERE club_id = $1 AND id = $2`,
      [DEFAULT_CLUB_ID, gameId],
    );
    expect(persisted.rows).toEqual([
      { id: gameId, revision: 3, status: "active", state: roleState, results: null },
    ]);
    const projections = await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM game_session_creations WHERE club_id = $1 AND creation_id = $2) AS creations,
        (SELECT COUNT(*)::int FROM game_sessions WHERE club_id = $1) AS sessions,
        (SELECT COUNT(*)::int FROM game_results WHERE club_id = $1 AND game_id = $3) AS results,
        (SELECT COUNT(*)::int FROM game_player_results WHERE club_id = $1 AND game_id = $3) AS player_results,
        (SELECT COUNT(*)::int FROM game_events WHERE club_id = $1 AND game_id = $3) AS events`,
      [DEFAULT_CLUB_ID, body.creationId, gameId],
    );
    expect(projections.rows).toEqual([
      { creations: 1, sessions: 1, results: 0, player_results: 0, events: 0 },
    ]);
  });

  it("rejects structured copied identities on create and save without changing accepted bytes", async () => {
    const accepted = await create(payload({ state: { arbitrary: "allowed" } }));
    expect(accepted.statusCode).toBe(201);
    const gameId = accepted.json().gameId as string;
    const original = await pool.query<{ state: unknown; results: unknown; revision: number }>(
      "SELECT state, results, revision FROM game_sessions WHERE id = $1",
      [gameId],
    );
    const named = [
      { state: { hostName: "private host" } },
      {
        state: {
          setup: { setup: { players: [{ id: randomUUID(), seat: 1, name: "private setup" }] } },
        },
      },
      { state: { game: { players: [{ id: randomUUID(), seat: 1, name: "private game" }] } } },
      {
        state: {
          initialGame: {
            state: { players: [{ id: randomUUID(), seat: 1, nickname: "private baseline" }] },
          },
        },
      },
      {
        state: {
          events: [{ payload: { playerId: randomUUID(), seat: 1, name: "private event" } }],
        },
      },
      {
        state: {
          log: [{ payload: { playerId: randomUUID(), seat: 1, email: "private@example.test" } }],
        },
      },
      { results: { players: [{ playerId: randomUUID(), seat: 1, name: "private result" }] } },
    ];
    for (const candidate of named) {
      const request = payload(candidate);
      const rejectedCreate = await create(request);
      expect(rejectedCreate.statusCode, rejectedCreate.body).toBe(400);
      expect(rejectedCreate.body).not.toContain("private");
      const rejectedSave = await app.inject({
        method: "PUT",
        url: `/api/game-sessions/${gameId}`,
        payload: {
          name: "Safe title",
          mutationId: randomUUID(),
          state: { arbitrary: true },
          results: null,
          ...candidate,
        },
      });
      expect(rejectedSave.statusCode, rejectedSave.body).toBe(400);
      expect(rejectedSave.body).not.toContain("private");
      expect(
        (
          await pool.query("SELECT state, results, revision FROM game_sessions WHERE id = $1", [
            gameId,
          ])
        ).rows,
      ).toEqual(original.rows);
      expect(
        (
          await pool.query(
            "SELECT COUNT(*)::int AS count FROM game_session_creations WHERE creation_id = $1",
            [request.creationId],
          )
        ).rows[0]?.count,
      ).toBe(0);
    }
    const freeText = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: {
        name: "Named tournament",
        mutationId: randomUUID(),
        state: { reason: "Named referee", custom: { name: "free text label" } },
        results: null,
      },
    });
    expect(freeText.statusCode, freeText.body).toBe(200);
  });

  it("refuses an old stored name-bearing game in list, detail, events and retry without exposing it or editing it", async () => {
    const request = payload();
    const created = await create(request);
    const gameId = created.json().gameId as string;
    await pool.query(
      "UPDATE game_sessions SET state = $2::jsonb, results = $3::jsonb WHERE id = $1",
      [
        gameId,
        JSON.stringify({
          hostName: "private host",
          game: { players: [{ id: randomUUID(), seat: 1, name: "private player" }] },
        }),
        JSON.stringify({
          hostPlayerId: randomUUID(),
          players: [{ playerId: randomUUID(), seat: 1, name: "private result" }],
        }),
      ],
    );
    await pool.query(
      "INSERT INTO game_events (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload) VALUES ($1,$2,$3,1,$4,'opaque','opaque',$5::jsonb)",
      [
        randomUUID(),
        DEFAULT_CLUB_ID,
        gameId,
        randomUUID(),
        JSON.stringify({ name: "private event" }),
      ],
    );
    const before = (
      await pool.query(
        "SELECT state::text, results::text, revision FROM game_sessions WHERE id = $1",
        [gameId],
      )
    ).rows;
    for (const url of [
      "/api/game-sessions",
      `/api/game-sessions/${gameId}`,
      `/api/games/${gameId}/events`,
      `/api/games/${gameId}/events?visibility=public`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url + response.body).toBe(409);
      expect(response.json()).toEqual({ error: "unsupported_game_format" });
      expect(response.body).not.toContain("private");
    }
    const unrelatedHistory = await app.inject({
      method: "GET",
      url: "/api/game-sessions?status=completed",
    });
    expect(unrelatedHistory.json().sessions).toEqual([]);
    const retry = await create(request);
    expect(retry.statusCode, retry.body).toBe(409);
    expect(
      (
        await pool.query(
          "SELECT state::text, results::text, revision FROM game_sessions WHERE id = $1",
          [gameId],
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await pool.query("SELECT payload FROM game_events WHERE game_id = $1", [gameId])).rows,
    ).toEqual([{ payload: { name: "private event" } }]);
    await pool.query("UPDATE game_sessions SET status = 'completed' WHERE id = $1", [gameId]);
    const completedList = await app.inject({
      method: "GET",
      url: "/api/game-sessions?status=completed",
    });
    expect(completedList.json()).toEqual({ error: "unsupported_game_format" });
    expect(completedList.statusCode).toBe(409);
    expect(completedList.body).not.toContain("private");
  });
  it("rejects foreign and retired new identities but allows an existing completed history correction", async () => {
    const players = new PlayerStore(pool);
    const profile = (nickname: string) => ({
      nickname,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const host = await players.create(profile(`Host ${randomUUID()}`));
    const participant = await players.create(profile(`Seat ${randomUUID()}`));
    const otherClub = randomUUID();
    await pool.query("INSERT INTO clubs (id, name, city, created_by) VALUES ($1,$2,'Málaga',$3)", [
      otherClub,
      "Another",
      owner.id,
    ]);
    try {
      const outsider = await players.create(profile(`Foreign ${randomUUID()}`), otherClub);
      const liveState = (id: string) => ({
        hostPlayerId: host.id,
        setup: { selectedPlayerIds: [id] },
        game: { phase: "opaque", players: [{ id, seat: 1, role: "citizen" }] },
      });
      const overlap = await create(
        payload({ state: { ...liveState(participant.id), hostPlayerId: participant.id } }),
      );
      expect(overlap.statusCode, overlap.body).toBe(400);
      expect(overlap.json().error).toBe("validation_failed");
      for (const id of [outsider.id, randomUUID()]) {
        const rejected = await create(payload({ state: liveState(id) }));
        expect(rejected.statusCode, rejected.body).toBe(409);
        expect(rejected.json()).toEqual({ error: "invalid_game_identity" });
      }
      const completed = await create(
        payload({
          state: liveState(participant.id),
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
      expect(completed.statusCode, completed.body).toBe(201);
      expect(await players.delete(participant.id)).toBe("deleted");
      const newSelection = await create(payload({ state: liveState(participant.id) }));
      expect(newSelection.statusCode, newSelection.body).toBe(409);
      const correction = await app.inject({
        method: "PUT",
        url: `/api/game-sessions/${completed.json().gameId}`,
        payload: {
          name: "After retirement",
          mutationId: randomUUID(),
          state: completed.json().state,
          results: { ...completed.json().results, outcome: "black", winner: "black" },
        },
      });
      expect(correction.statusCode, correction.body).toBe(200);
      expect(
        (
          await pool.query("SELECT player_id, won FROM game_player_results WHERE game_id = $1", [
            completed.json().gameId,
          ])
        ).rows,
      ).toEqual([{ player_id: participant.id, won: false }]);
    } finally {
      await pool.query("DELETE FROM players WHERE club_id = $1", [otherClub]);
      await pool.query("DELETE FROM clubs WHERE id = $1", [otherClub]);
    }
  });

  it("keeps active host and participant profiles when their projection rows are missing", async () => {
    const players = new PlayerStore(pool);
    const profile = (nickname: string) => ({
      nickname,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const host = await players.create(profile(`Host ${randomUUID()}`));
    const participant = await players.create(profile(`Seat ${randomUUID()}`));
    const state = {
      hostPlayerId: host.id,
      game: { phase: "opaque", players: [{ id: participant.id, seat: 1, role: "citizen" }] },
    };
    const created = await create(payload({ state }));
    expect(created.statusCode, created.body).toBe(201);
    await pool.query("DELETE FROM game_session_players WHERE game_id = $1", [
      created.json().gameId,
    ]);
    for (const id of [host.id, participant.id]) {
      const result = await app.inject({ method: "DELETE", url: `/api/players/${id}` });
      expect(result.statusCode, result.body).toBe(409);
      expect(result.json()).toEqual({ error: "active_game" });
      expect(await players.get(id)).not.toBeNull();
    }
  });
  it("blocks old stored event-only copied identities on every record view while preserving the event", async () => {
    const created = await create();
    const gameId = created.json().gameId as string;
    const event = { name: "private projected event", playerId: randomUUID() };
    await pool.query(
      "INSERT INTO game_events (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload) VALUES ($1,$2,$3,1,$4,'opaque','opaque',$5::jsonb)",
      [randomUUID(), DEFAULT_CLUB_ID, gameId, randomUUID(), JSON.stringify(event)],
    );
    for (const url of [
      "/api/game-sessions",
      `/api/game-sessions/${gameId}`,
      `/api/games/${gameId}/events`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url + response.body).toBe(409);
      expect(response.json()).toEqual({ error: "unsupported_game_format" });
      expect(response.body).not.toContain("private");
    }
    expect(
      (await pool.query("SELECT payload FROM game_events WHERE game_id = $1", [gameId])).rows,
    ).toEqual([{ payload: event }]);
  });
  it("reloads an ID-only real replay and peer results unchanged after profile rename and retirement", async () => {
    const players = new PlayerStore(pool);
    const profile = (nickname: string) => ({
      nickname,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const host = await players.create(profile(`Host ${randomUUID()}`));
    const roster = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        players.create(profile(`Seat-${index}-${randomUUID()}`)),
      ),
    );
    const rosterIds = roster.map(({ id }, index) => ({ id, seat: index + 1 }));
    let setup = beginRoleDraw(createSetup(rosterIds), createSeededRandom(41));
    for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
    setup = completeRoleDraw(setup);
    const baseline: InitialGameBaseline = { replayVersion: 1, game: createGame(setup) };
    const created = await create(
      payload({
        state: {
          hostPlayerId: host.id,
          setup: { hostPlayerId: host.id, selectedPlayerIds: rosterIds.map(({ id }) => id), setup },
          game: baseline.game,
          initialGame: baseline,
          events: [],
          log: [],
        },
      }),
    );
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    const activeSummaries = (await app.inject({ method: "GET", url: "/api/game-sessions" })).json()
      .sessions;
    expect(activeSummaries).toEqual([expect.objectContaining({ gameId, hostPlayerId: host.id })]);
    expect(JSON.stringify(activeSummaries)).not.toContain(host.nickname);
    expect(JSON.stringify(activeSummaries)).not.toContain("hostName");
    const { entry, after } = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-09-26T12:00:00.000Z",
      before: baseline.game,
      draft: { type: "game.started", payload: {} },
    });
    const results = {
      hostPlayerId: host.id,
      outcome: "red",
      winner: "red",
      reason: null,
      playedAt: "2026-09-26T12:00:00.000Z",
      players: after.players.map(({ id, seat, role, team, status, fouls }) => ({
        playerId: id,
        seat,
        role,
        team,
        status,
        fouls,
        bestMoveHits: null,
      })),
    };
    const state = { ...created.json().state, game: after, events: [entry], headEventId: entry.id };
    const saved = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: {
        name: "Named championship",
        mutationId: randomUUID(),
        state,
        results,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const completedSummaries = (
      await app.inject({ method: "GET", url: "/api/game-sessions?status=completed" })
    ).json().sessions;
    expect(completedSummaries).toEqual([
      expect.objectContaining({ gameId, hostPlayerId: host.id }),
    ]);
    expect(JSON.stringify(completedSummaries)).not.toContain(host.nickname);
    expect(JSON.stringify(completedSummaries)).not.toContain("hostName");
    const hash = hashGameState(after);
    const bytes = (
      await pool.query<{ state: string; results: string }>(
        "SELECT state::text, results::text FROM game_sessions WHERE id = $1",
        [gameId],
      )
    ).rows[0]!;
    await players.update(
      roster[0]!.id,
      profile(`Renamed ${randomUUID()}`),
      DEFAULT_CLUB_ID,
      owner.id,
    );
    expect(await players.delete(roster[0]!.id)).toBe("deleted");
    expect(await players.get(roster[0]!.id)).toBeNull();
    expect(await players.delete(host.id)).toBe("deleted");
    expect(await players.get(host.id)).toBeNull();
    const loaded = await app.inject({ method: "GET", url: `/api/game-sessions/${gameId}` });
    expect(loaded.statusCode, loaded.body).toBe(200);
    const restored = loaded.json().session;
    expect(
      replayGameLog(
        restored.state.initialGame as InitialGameBaseline,
        restored.state.events as GameLogEntry[],
        gameId,
      ).game,
    ).toEqual(after);
    expect(hashGameState(restored.state.game)).toBe(hash);
    expect(restored.state.events[0].stateHashAfter).toBe(hash);
    expect(restored.results.players[0].playerId).toBe(roster[0]!.id);
    expect(restored.results.hostPlayerId).toBe(host.id);
    expect(
      (
        await pool.query("SELECT state::text, results::text FROM game_sessions WHERE id = $1", [
          gameId,
        ])
      ).rows[0],
    ).toEqual(bytes);
    expect(
      (
        await pool.query<{ player_id: string; won: boolean }>(
          "SELECT player_id, won FROM game_player_results WHERE game_id = $1 ORDER BY seat",
          [gameId],
        )
      ).rows,
    ).toEqual(
      results.players.map(({ playerId, team }) => ({ player_id: playerId, won: team === "red" })),
    );
    expect(
      (await app.inject({ method: "GET", url: "/api/game-sessions?status=completed" })).json()
        .sessions,
    ).toEqual([
      expect.objectContaining({ gameId, name: "Named championship", hostPlayerId: host.id }),
    ]);
  });
  it("serializes both queued save/retire orders without active reidentification or partial writes", async () => {
    const players = new PlayerStore(pool);
    for (const first of ["save", "retire"] as const) {
      const participant = await players.create({
        nickname: `Race-${first}-${randomUUID()}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      });
      const created = await create();
      expect(created.statusCode, created.body).toBe(201);
      const gameId = created.json().gameId as string;
      const state = { game: { players: [{ id: participant.id, seat: 1 }] } };
      const retire = () => app.inject({ method: "DELETE", url: `/api/players/${participant.id}` });
      const save = () =>
        app.inject({
          method: "PUT",
          url: `/api/game-sessions/${gameId}`,
          payload: { name: "race", mutationId: randomUUID(), state, results: null },
        });
      // Both production writers take game_results before player rows. Hold that
      // first lock, observe each real request queued in pg_locks, then release.
      // PostgreSQL's lock queue (not scheduling delays) fixes the serialization.
      const gate = await pool.connect();
      await gate.query("BEGIN");
      await gate.query("LOCK TABLE game_results IN ACCESS EXCLUSIVE MODE");
      const waitForQueue = async (mode: "RowExclusiveLock" | "ShareRowExclusiveLock") => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = await pool.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM pg_locks
             WHERE relation = 'game_results'::regclass AND mode = $1 AND NOT granted`,
            [mode],
          );
          if (waiting.rows[0]?.count === 1) return;
        }
        throw new Error(`The ${mode} API request never reached the database lock queue`);
      };
      let firstResponse: Awaited<ReturnType<typeof save>>;
      let secondResponse: Awaited<ReturnType<typeof save>>;
      try {
        const pendingFirst = first === "save" ? save() : retire();
        await waitForQueue(first === "save" ? "RowExclusiveLock" : "ShareRowExclusiveLock");
        const pendingSecond = first === "save" ? retire() : save();
        await waitForQueue(first === "save" ? "ShareRowExclusiveLock" : "RowExclusiveLock");
        await gate.query("COMMIT");
        [firstResponse, secondResponse] = await Promise.all([pendingFirst, pendingSecond]);
      } finally {
        await gate.query("ROLLBACK");
        gate.release();
      }
      const retirement = first === "save" ? secondResponse : firstResponse;
      const saved = first === "save" ? firstResponse : secondResponse;
      expect([retirement.statusCode, saved.statusCode]).toEqual(
        first === "save" ? [409, 200] : [204, 409],
      );
      const persisted = (
        await pool.query<{ state: unknown; revision: number; status: string }>(
          "SELECT state, revision, status FROM game_sessions WHERE id = $1",
          [gameId],
        )
      ).rows[0]!;
      const identity = (
        await pool.query<{ retired_at: Date | null; nickname: string | null }>(
          "SELECT retired_at, nickname FROM players WHERE id = $1",
          [participant.id],
        )
      ).rows[0]!;
      const projected = (
        await pool.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM game_session_players WHERE game_id = $1 AND player_id = $2",
          [gameId, participant.id],
        )
      ).rows[0]!.count;
      const readback = await app.inject({ method: "GET", url: `/api/game-sessions/${gameId}` });
      expect(readback.statusCode, readback.body).toBe(200);
      expect(readback.json().session.state).toEqual(persisted.state);
      expect(persisted.status).toBe("active");
      if (first === "retire") {
        expect(await players.get(participant.id)).toBeNull();
        expect(identity).toMatchObject({ nickname: null });
        expect(identity.retired_at).not.toBeNull();
        expect(persisted).toMatchObject({ state: created.json().state, revision: 1 });
        expect(projected).toBe(0);
      } else {
        expect(await players.get(participant.id)).not.toBeNull();
        expect(identity.retired_at).toBeNull();
        expect(persisted).toMatchObject({ state, revision: 2 });
        // Sparse browser snapshots do not qualify for a relational projection;
        // deletion must still find the authoritative active JSON reference.
        expect(projected).toBe(0);
      }
    }
  });
  it("purges permanent identities, authoritative games, events and result projections on club deletion", async () => {
    const clubResponse = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `Purge ${randomUUID()}`,
        city: "Málaga",
        headerLogo: null,
        cardLogo: null,
        language: "en",
        ownerConsent: true,
      },
    });
    expect(clubResponse.statusCode, clubResponse.body).toBe(201);
    const clubId = clubResponse.json().club.id as string;
    const players = new PlayerStore(pool);
    const participant = await players.create(
      {
        nickname: `Purge-${randomUUID()}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
      clubId,
    );
    const host = (await players.list(clubId)).find(({ managerLocked }) => managerLocked)!;
    const session = await create(
      payload({
        state: {
          hostPlayerId: host.id,
          game: { players: [{ id: participant.id, seat: 1, role: "citizen" }] },
        },
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
      clubId,
    );
    expect(session.statusCode, session.body).toBe(201);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS count FROM game_player_results WHERE club_id = $1",
          [clubId],
        )
      ).rows[0]?.count,
    ).toBe(1);
    const removed = await app.inject({ method: "DELETE", url: `/api/clubs/${clubId}` });
    expect(removed.statusCode, removed.body).toBe(204);
    for (const table of [
      "players",
      "game_sessions",
      "game_session_players",
      "game_results",
      "game_player_results",
      "game_events",
      "game_session_creations",
    ]) {
      expect(
        (
          await pool.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE club_id = $1`, [
            clubId,
          ])
        ).rows[0]?.count,
        table,
      ).toBe(0);
    }
    expect(
      (
        await pool.query("SELECT COUNT(*)::int AS count FROM deleted_clubs WHERE club_id = $1", [
          clubId,
        ])
      ).rows[0]?.count,
    ).toBe(1);
  });
  it("skips malformed completion metadata without breaking the rest of the history", async () => {
    const malformed = await create(
      payload({
        results: {
          outcome: { toString: "red" },
          winner: "red",
          reason: null,
          playedAt: "2026-09-26T12:00:00.000Z",
        },
      }),
    );
    expect(malformed.statusCode, malformed.body).toBe(201);
    const valid = await create(
      payload({
        results: {
          outcome: "red",
          winner: "red",
          reason: null,
          playedAt: "2026-09-26T12:00:00.000Z",
          players: [],
        },
      }),
    );
    expect(valid.statusCode, valid.body).toBe(201);
    const history = await app.inject({
      method: "GET",
      url: "/api/game-sessions?status=completed",
      headers: { "x-club-id": DEFAULT_CLUB_ID },
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().sessions).toMatchObject([{ gameId: valid.json().gameId }]);
    expect(history.json().sessions).toHaveLength(1);
  });

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

  it("lets a member manage their club's active and completed records without resurrecting deletion", async () => {
    const headers = { "x-club-id": DEFAULT_CLUB_ID };
    const body = payload({ name: "Member table" });
    const created = await regularUserApp.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers,
      payload: body,
    });
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    const retry = await regularUserApp.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers,
      payload: body,
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ gameId, duplicate: true });
    const active = await regularUserApp.inject({
      method: "GET",
      url: "/api/game-sessions",
      headers,
    });
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json().sessions).toMatchObject([{ gameId }]);

    const host = await new PlayerStore(pool).create({
      nickname: `Member host ${randomUUID().slice(0, 8)}`,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const completedResults = {
      hostPlayerId: host.id,
      outcome: "red",
      winner: "red",
      reason: null,
      playedAt: "2026-09-26T12:00:00.000Z",
      players: [],
    };
    const saved = await regularUserApp.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      headers,
      payload: {
        operation: "snapshot",
        mutationId: randomUUID(),
        name: "Member completed",
        state: { browserOwned: true },
        results: completedResults,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ gameId, revision: 2, status: "completed" });
    const detail = await regularUserApp.inject({
      method: "GET",
      url: `/api/game-sessions/${gameId}`,
      headers,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().session).toMatchObject({
      gameId,
      name: "Member completed",
      state: { browserOwned: true },
      results: completedResults,
    });
    const history = await regularUserApp.inject({
      method: "GET",
      url: "/api/game-sessions?status=completed&from=2026-09-26&to=2026-09-26&outcome=red",
      headers,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().sessions).toMatchObject([{ gameId, outcome: "red" }]);
    const excludedHistory = await regularUserApp.inject({
      method: "GET",
      url: "/api/game-sessions?status=completed&from=2026-09-27&to=2026-09-27&outcome=black",
      headers,
    });
    expect(excludedHistory.statusCode, excludedHistory.body).toBe(200);
    expect(excludedHistory.json().sessions).toEqual([]);
    await expect(
      pool.query("SELECT status, state FROM game_sessions WHERE club_id = $1 AND id = $2", [
        DEFAULT_CLUB_ID,
        gameId,
      ]),
    ).resolves.toMatchObject({ rows: [{ status: "completed", state: { browserOwned: true } }] });
    await expect(
      pool.query(
        "SELECT COUNT(*)::int AS count FROM game_results WHERE club_id = $1 AND game_id = $2",
        [DEFAULT_CLUB_ID, gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const deleted = await regularUserApp.inject({
      method: "DELETE",
      url: `/api/game-sessions/${gameId}`,
      headers,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    const staleSave = await regularUserApp.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      headers,
      payload: {
        operation: "snapshot",
        mutationId: randomUUID(),
        name: "stale",
        state: { stale: true },
        results: null,
      },
    });
    expect(staleSave.statusCode, staleSave.body).toBe(404);
    const retryDeleted = await regularUserApp.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers,
      payload: body,
    });
    expect(retryDeleted.statusCode, retryDeleted.body).toBe(410);
    const afterDelete = await regularUserApp.inject({
      method: "GET",
      url: `/api/game-sessions/${gameId}`,
      headers,
    });
    expect(afterDelete.statusCode).toBe(404);
    await expect(
      pool.query(
        `SELECT (SELECT COUNT(*)::int FROM game_sessions WHERE club_id = $1 AND id = $2) AS sessions,
              (SELECT COUNT(*)::int FROM game_results WHERE club_id = $1 AND game_id = $2) AS results`,
        [DEFAULT_CLUB_ID, gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ sessions: 0, results: 0 }] });
  });

  const verifyForeignClubIsolation = async (role: "user" | "manager") => {
    const foreignClubId = randomUUID();
    const foreignUser: AppUser = {
      id: randomUUID(),
      email: `foreign-${role}-${randomUUID()}@example.test`,
      name: `Foreign ${role}`,
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
    await pool.query("INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, $3)", [
      foreignClubId,
      foreignUser.id,
      role,
    ]);
    const created = await create(
      payload({
        results: {
          outcome: "red",
          winner: "red",
          reason: null,
          playedAt: "2026-09-26T12:00:00.000Z",
          players: [],
        },
      }),
    );
    const gameId = created.json().gameId as string;
    const foreignApp = await buildApp({ pool, authenticateRequest: async () => foreignUser });
    await foreignApp.ready();
    try {
      const foreignCreated = await foreignApp.inject({
        method: "POST",
        url: "/api/game-sessions",
        headers: { "x-club-id": foreignClubId },
        payload: payload({ name: "Foreign club game" }),
      });
      expect(foreignCreated.statusCode, foreignCreated.body).toBe(201);
      const foreignActive = await foreignApp.inject({
        method: "GET",
        url: "/api/game-sessions",
        headers: { "x-club-id": foreignClubId },
      });
      expect(foreignActive.statusCode).toBe(200);
      expect(foreignActive.json().sessions).toMatchObject([
        { gameId: foreignCreated.json().gameId, name: "Foreign club game" },
      ]);
      const foreignHistory = await foreignApp.inject({
        method: "GET",
        url: "/api/game-sessions?status=completed",
        headers: { "x-club-id": foreignClubId },
      });
      expect(foreignHistory.statusCode, foreignHistory.body).toBe(200);
      expect(foreignHistory.json().sessions).toEqual([]);
      const guessed = await foreignApp.inject({
        method: "GET",
        url: `/api/game-sessions/${gameId}`,
        headers: { "x-club-id": foreignClubId },
      });
      expect(guessed.statusCode).toBe(404);
      const guessedSave = await foreignApp.inject({
        method: "PUT",
        url: `/api/game-sessions/${gameId}`,
        headers: { "x-club-id": foreignClubId },
        payload: {
          operation: "snapshot",
          name: "cross-club",
          mutationId: randomUUID(),
          state: { forbidden: true },
          results: null,
        },
      });
      expect(guessedSave.statusCode).toBe(404);
      const guessedDelete = await foreignApp.inject({
        method: "DELETE",
        url: `/api/game-sessions/${gameId}`,
        headers: { "x-club-id": foreignClubId },
      });
      expect(guessedDelete.statusCode).toBe(204);
      const stillOwned = await app.inject({ method: "GET", url: `/api/game-sessions/${gameId}` });
      expect(stillOwned.statusCode).toBe(200);
      expect(stillOwned.json().session.name).toBe(created.json().name);
      for (const request of [
        { method: "GET", url: "/api/game-sessions" },
        { method: "GET", url: "/api/game-sessions?status=completed" },
        { method: "POST", url: "/api/game-sessions", payload: payload() },
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
      await pool.query("DELETE FROM game_sessions WHERE club_id = $1", [foreignClubId]);
      await pool.query("DELETE FROM deleted_games WHERE club_id = $1", [foreignClubId]);
      await pool.query("DELETE FROM clubs WHERE id = $1", [foreignClubId]);
      await pool.query("DELETE FROM users WHERE id = $1", [foreignUser.id]);
    }
  };
  it.each(["user", "manager"] as const)(
    "isolates another club %s's records even with a guessed game ID or forged club selection",
    verifyForeignClubIsolation,
  );
});
