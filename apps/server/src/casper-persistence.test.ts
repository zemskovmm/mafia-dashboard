import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  beginRoleDraw,
  createGame,
  createGameLogEntry,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  completeRoleDraw,
  replayGameLog,
  CASPER_PLAYER_ID,
  CASPER_SEAT,
  CASPER_NAME,
  advanceSetupPhase,
  beginNight,
  completeMafiaShots,
  resolveMafiaShots,
  skipDonCheck,
  skipSheriffCheck,
  toggleAllMafiaShotsForTarget,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { initializeSchema } from "./initialize-schema.js";
import { PlayerStore } from "./player-store.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia@127.0.0.1:54329/mafia_test";
const schemaName = `casper_persistence_${randomUUID().replaceAll("-", "")}`;
const schemaPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const owner = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@mafiamalaga.es",
  name: "Owner",
  picture: null,
};
let app: Awaited<ReturnType<typeof buildApp>>;
const playerStore = new PlayerStore(pool);

const headers = (clubId = DEFAULT_CLUB_ID) => ({ "x-club-id": clubId });
const read = async (gameId: string, clubId = DEFAULT_CLUB_ID) =>
  app.inject({ method: "GET", url: `/api/game-sessions/${gameId}`, headers: headers(clubId) });
const save = async (
  gameId: string,
  state: Record<string, unknown>,
  results: Record<string, unknown> | null = null,
  clubId = DEFAULT_CLUB_ID,
  mutationId = randomUUID(),
) =>
  app.inject({
    method: "PUT",
    url: `/api/game-sessions/${gameId}`,
    headers: headers(clubId),
    payload: { kind: "snapshot", name: "Casper game", mutationId, state, results },
  });
const rows = async (table: "game_session_players" | "game_player_results", gameId: string) =>
  (
    await pool.query<{ player_id: string; seat: number | null; is_host?: boolean }>(
      `SELECT player_id, seat${table === "game_session_players" ? ", is_host" : ""} FROM ${table} WHERE club_id = $1 AND game_id = $2 ORDER BY seat NULLS FIRST`,
      [DEFAULT_CLUB_ID, gameId],
    )
  ).rows;

const createRoster = async (firstHumanName?: string) => {
  const host = await playerStore.create({
    nickname: `Host ${randomUUID()}`,
    consent: false,
    firstName: null,
    lastName: null,
    email: null,
  });
  const humans = await Promise.all(
    Array.from({ length: 9 }, (_, index) =>
      playerStore.create({
        nickname:
          index === 0 && firstHumanName ? firstHumanName : `Human ${index + 1} ${randomUUID()}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      }),
    ),
  );
  const inputs: PlayerInput[] = [
    ...humans.map(({ id, nickname }, index) => ({ id, name: nickname, seat: index + 1 })),
    { id: CASPER_PLAYER_ID, name: CASPER_NAME, seat: CASPER_SEAT },
  ];
  let setup = beginRoleDraw(createSetup(inputs), createSeededRandom(13));
  for (let seat = 1; seat <= 9; seat += 1) setup = drawRoleForSeat(setup, seat);
  const baseline = createGame(completeRoleDraw(setup));
  return { host, humans, baseline };
};

beforeAll(async () => {
  await schemaPool.query(`CREATE SCHEMA ${schemaName}`);
  await initializeSchema(pool);
  app = await buildApp({
    pool,
    defaultClubId: DEFAULT_CLUB_ID,
    authenticateRequest: async () => owner,
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await schemaPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await schemaPool.end();
});

// Fixed dynamic import avoids pulling a web source file into the server TypeScript rootDir.
const getResultsBuilder = async (): Promise<
  (game: GameState, playedAt: Date, hostId: string) => Record<string, unknown> | null
> => {
  const source = pathToFileURL(
    resolve(process.cwd(), "../web/src/features/players/game-results.ts"),
  ).href;
  // Fixed test-repository path, never a request-controlled URL.
  // eslint-disable-next-line no-unsanitized/method
  const module = (await import(/* @vite-ignore */ source)) as {
    buildFinalGameResults: (
      game: GameState,
      playedAt: Date,
      hostId: string,
    ) => Record<string, unknown> | null;
  };
  return module.buildFinalGameResults;
};

describe("Casper browser snapshot persistence", () => {
  it("persists and replays a new Casper kill without Best Move across an isolated club", async () => {
    const { host, baseline } = await createRoster();
    const created = await app.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers: headers(),
      payload: { creationId: randomUUID(), name: "Casper kill", state: {}, results: null },
    });
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    expect(baseline.skipCasperBestMove).toBe(true);
    let game = beginNight(advanceSetupPhase(advanceSetupPhase(baseline)));
    game = toggleAllMafiaShotsForTarget(game, CASPER_SEAT);
    game = skipSheriffCheck(skipDonCheck(completeMafiaShots(resolveMafiaShots(game).game)));
    const initialGame = { replayVersion: 1 as const, game };
    const root = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-09-26T12:00:00.000Z",
      before: game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    const speech = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: root.entry.id,
      createdAt: "2026-09-26T12:00:01.000Z",
      before: root.after,
      draft: { type: "phase.changed", payload: { to: "goodbye-speech" } },
    });
    expect(speech.after).toMatchObject({
      phase: "goodbye-speech",
      goodbyeSeats: [CASPER_SEAT],
      skipCasperBestMove: true,
    });
    expect(speech.after.bestMove).toBeUndefined();
    const state = {
      hostPlayerId: host.id,
      game: speech.after,
      initialGame,
      events: [root.entry, speech.entry],
      headEventId: speech.entry.id,
    };
    const saved = await save(gameId, state);
    expect(saved.statusCode, saved.body).toBe(200);
    const loaded = (await read(gameId)).json().session.state;
    expect(loaded).toEqual(JSON.parse(JSON.stringify(state)));
    expect(replayGameLog(loaded.initialGame, loaded.events, gameId).game).toEqual(loaded.game);
    expect((await read(gameId, randomUUID())).statusCode).toBe(403);
  });

  it("round-trips the complete ten-seat replay and projects the real host and nine humans on completion", async () => {
    const { host, humans, baseline } = await createRoster("Casper");
    const created = await app.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers: headers(),
      payload: {
        creationId: randomUUID(),
        name: "Casper game",
        state: { setup: { step: "music" } },
        results: null,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    const { entry } = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-09-26T12:00:00.000Z",
      before: baseline,
      draft: { type: "game.started", payload: {} },
    });
    const state = {
      hostPlayerId: host.id,
      hostName: host.nickname,
      setup: { players: baseline.players.map(({ id, name, seat }) => ({ id, name, seat })) },
      game: baseline,
      initialGame: { replayVersion: 1, game: baseline },
      events: [entry],
    };
    const active = await save(gameId, state);
    expect(active.statusCode, active.body).toBe(200);
    expect((await read(gameId)).json().session.state).toEqual(state);
    expect(
      replayGameLog(state.initialGame as { replayVersion: 1; game: GameState }, [entry], gameId)
        .game,
    ).toEqual(baseline);
    expect(await rows("game_session_players", gameId)).toEqual([
      { player_id: host.id, seat: null, is_host: true },
      ...humans.map(({ id }, index) => ({ player_id: id, seat: index + 1, is_host: false })),
    ]);
    const finished: GameState = { ...baseline, day: 1, phase: "finished", winner: "red" };
    const results = (await getResultsBuilder())(
      finished,
      new Date("2026-09-26T12:00:00.000Z"),
      host.id,
    );
    expect(results).not.toBeNull();
    const { entry: checkpoint } = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-09-26T12:00:01.000Z",
      before: finished,
      draft: { type: "game.checkpointed", payload: {} },
    });
    const { entry: completion } = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: checkpoint.id,
      createdAt: "2026-09-26T12:00:02.000Z",
      before: finished,
      draft: { type: "game.completed", payload: { winner: "red" } },
    });
    const completedState = {
      ...state,
      game: finished,
      initialGame: { replayVersion: 1 as const, game: finished },
      events: [checkpoint, completion],
      headEventId: completion.id,
    };
    const completionMutationId = randomUUID();
    const completed = await save(
      gameId,
      completedState,
      results,
      DEFAULT_CLUB_ID,
      completionMutationId,
    );
    expect(completed.statusCode, completed.body).toBe(200);
    const persisted = (await read(gameId)).json().session;
    expect(persisted).toMatchObject({ status: "completed", state: completedState, results });
    expect(replayGameLog(persisted.state.initialGame, persisted.state.events, gameId).game).toEqual(
      finished,
    );
    expect(
      (
        await pool.query(
          "SELECT event_type, payload FROM game_events WHERE game_id = $1 ORDER BY sequence",
          [gameId],
        )
      ).rows,
    ).toEqual([
      { event_type: "game.checkpointed", payload: {} },
      { event_type: "game.completed", payload: { winner: "red" } },
    ]);
    expect(persisted.results.players).toHaveLength(10);
    const projected = await rows("game_player_results", gameId);
    expect(projected).toEqual(humans.map(({ id }, index) => ({ player_id: id, seat: index + 1 })));
    expect((await playerStore.get(humans[0]!.id))?.nickname).toBe(CASPER_NAME);
    expect(
      (await pool.query("SELECT host_player_id FROM game_results WHERE game_id = $1", [gameId]))
        .rows,
    ).toEqual([{ host_player_id: host.id }]);
    const history = await app.inject({
      method: "GET",
      url: `/api/game-sessions?status=completed&playerId=${humans[0]!.id}&outcome=red`,
      headers: headers(),
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().sessions).toMatchObject([{ gameId, eventCount: 2 }]);
    expect((await playerStore.get(host.id))?.statistics).toMatchObject({
      hostedGames: 1,
      gamesPlayed: 0,
    });
    for (const human of humans) {
      expect((await playerStore.get(human.id))?.statistics).toMatchObject({ gamesPlayed: 1 });
    }
    const retry = await save(
      gameId,
      completedState,
      results,
      DEFAULT_CLUB_ID,
      completionMutationId,
    );
    expect(retry.statusCode, retry.body).toBe(200);
    // Snapshot PUTs are update-only, even with the same mutation ID; aggregate statistics remain stable.
    expect(retry.json()).toMatchObject({
      duplicate: false,
      revision: completed.json().revision + 1,
    });
    expect(await rows("game_player_results", gameId)).toEqual(projected);
    expect((await playerStore.get(host.id))?.statistics.hostedGames).toBe(1);
    expect((await playerStore.get(humans[0]!.id))?.statistics.gamesPlayed).toBe(1);
    expect((await read(gameId)).json().session.results).toEqual(results);
    // The aggregate retains authoritative results/replay even if a historical
    // derived result row is missing. Empty filters must not hide that game.
    await pool.query("DELETE FROM game_results WHERE club_id = $1 AND game_id = $2", [
      DEFAULT_CLUB_ID,
      gameId,
    ]);
    const afterProjectionLoss = (await read(gameId)).json().session;
    expect(afterProjectionLoss.status).toBe("completed");
    expect(afterProjectionLoss.results).toEqual(results);
    expect(
      replayGameLog(afterProjectionLoss.state.initialGame, afterProjectionLoss.state.events, gameId)
        .game,
    ).toEqual(finished);
    const unfiltered = await app.inject({
      method: "GET",
      url: "/api/game-sessions?status=completed",
      headers: headers(),
    });
    expect(unfiltered.statusCode, unfiltered.body).toBe(200);
    expect(unfiltered.json().sessions).toMatchObject([
      { gameId, outcome: "red", winner: "red", eventCount: 2 },
    ]);
    const filtered = await app.inject({
      method: "GET",
      url: `/api/game-sessions?status=completed&playerId=${humans[0]!.id}&outcome=red`,
      headers: headers(),
    });
    expect(filtered.json().sessions).toMatchObject([{ gameId }]);
    for (const query of [
      "from=2026-09-26",
      "to=2026-09-26",
      `playerId=${humans[0]!.id}`,
      "outcome=red",
      `from=2026-09-26&to=2026-09-26&playerId=${humans[0]!.id}&outcome=red`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/game-sessions?status=completed&${query}`,
        headers: headers(),
      });
      expect(response.json().sessions, query).toMatchObject([{ gameId }]);
    }
    for (const query of [
      "from=2026-09-27",
      "to=2026-09-25",
      `playerId=${humans[1]!.id}&outcome=black`,
      `playerId=${randomUUID()}`,
      "outcome=draw",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/game-sessions?status=completed&${query}`,
        headers: headers(),
      });
      expect(response.json().sessions, query).toEqual([]);
    }
  });

  it.each([
    [
      "wrong seat",
      (players: Record<string, unknown>[]) =>
        players.map((p) => (p.playerId === CASPER_PLAYER_ID ? { ...p, seat: 9 } : p)),
    ],
    [
      "wrong role",
      (players: Record<string, unknown>[]) =>
        players.map((p) => (p.playerId === CASPER_PLAYER_ID ? { ...p, role: "mafia" } : p)),
    ],
    [
      "wrong team",
      (players: Record<string, unknown>[]) =>
        players.map((p) => (p.playerId === CASPER_PLAYER_ID ? { ...p, team: "black" } : p)),
    ],
    [
      "duplicate synthetic ID",
      (players: Record<string, unknown>[]) =>
        players.map((p) => (p.seat === 1 ? { ...p, playerId: CASPER_PLAYER_ID } : p)),
    ],
    ["incomplete roster", (players: Record<string, unknown>[]) => players.slice(1)],
  ])("does not project results for Casper with %s", async (_label, alter) => {
    const { host, baseline } = await createRoster();
    const created = await app.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers: headers(),
      payload: { creationId: randomUUID(), name: "Invalid results", state: {}, results: null },
    });
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    const finished: GameState = { ...baseline, day: 1, phase: "finished", winner: "red" };
    const valid = (await getResultsBuilder())(
      finished,
      new Date("2026-09-26T12:00:00.000Z"),
      host.id,
    )!;
    const results = { ...valid, players: alter(valid.players as Record<string, unknown>[]) };
    const saved = await save(gameId, { hostPlayerId: host.id, game: finished }, results);
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await read(gameId)).json().session.results).toEqual(results);
    expect(await rows("game_player_results", gameId)).toEqual([]);
    expect(
      (await pool.query("SELECT * FROM game_results WHERE game_id = $1", [gameId])).rows,
    ).toEqual([]);
    expect((await playerStore.get(host.id))?.statistics.hostedGames).toBe(0);
  });

  it.each([
    [
      "wrong seat",
      (players: GameState["players"]) =>
        players.map((p) => (p.id === CASPER_PLAYER_ID ? { ...p, seat: 9 } : p)),
    ],
    [
      "wrong role",
      (players: GameState["players"]) =>
        players.map((p) => (p.id === CASPER_PLAYER_ID ? { ...p, role: "mafia" as const } : p)),
    ],
    [
      "wrong team",
      (players: GameState["players"]) =>
        players.map((p) => (p.id === CASPER_PLAYER_ID ? { ...p, team: "black" as const } : p)),
    ],
    [
      "duplicate synthetic ID",
      (players: GameState["players"]) =>
        players.map((p) => (p.seat === 1 ? { ...p, id: CASPER_PLAYER_ID } : p)),
    ],
    ["incomplete roster", (players: GameState["players"]) => players.slice(1)],
  ])("does not project active seats for Casper with %s", async (_label, alter) => {
    const { host, baseline } = await createRoster();
    const created = await app.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers: headers(),
      payload: { creationId: randomUUID(), name: "Invalid state", state: {}, results: null },
    });
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    const state = {
      hostPlayerId: host.id,
      game: { ...baseline, players: alter(baseline.players) },
    };
    const saved = await save(gameId, state);
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await read(gameId)).json().session.state).toEqual(state);
    expect(await rows("game_session_players", gameId)).toEqual([]);
  });

  it("does not let a synthetic host, unknown human or foreign-club human enter either projection", async () => {
    const { host, baseline } = await createRoster();
    const foreignClub = randomUUID();
    await pool.query(
      "INSERT INTO clubs (id, name, city, created_by) VALUES ($1, 'Other', 'Málaga', $2)",
      [foreignClub, owner.id],
    );
    const foreign = await playerStore.create(
      {
        nickname: `Foreign ${randomUUID()}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
      foreignClub,
    );
    const finished: GameState = { ...baseline, day: 1, phase: "finished", winner: "red" };
    const valid = (await getResultsBuilder())(
      finished,
      new Date("2026-09-26T12:00:00.000Z"),
      host.id,
    )!;
    for (const invalidId of [CASPER_PLAYER_ID, randomUUID(), foreign.id]) {
      const gameId = (
        await app.inject({
          method: "POST",
          url: "/api/game-sessions",
          headers: headers(),
          payload: { creationId: randomUUID(), name: "Invalid identity", state: {}, results: null },
        })
      ).json().gameId as string;
      const invalidHost = invalidId === CASPER_PLAYER_ID;
      const game: GameState = invalidHost
        ? finished
        : {
            ...finished,
            players: finished.players.map((p) => (p.seat === 1 ? { ...p, id: invalidId } : p)),
          };
      const state = { hostPlayerId: invalidHost ? CASPER_PLAYER_ID : host.id, game };
      const results = invalidHost
        ? { ...valid, hostPlayerId: CASPER_PLAYER_ID }
        : {
            ...valid,
            players: (valid.players as Record<string, unknown>[]).map((p) =>
              p.seat === 1 ? { ...p, playerId: invalidId } : p,
            ),
          };
      expect((await save(gameId, state, results)).statusCode).toBe(200);
      expect(await rows("game_session_players", gameId)).toEqual([]);
      expect(await rows("game_player_results", gameId)).toEqual([]);
      expect(
        (await pool.query("SELECT * FROM game_results WHERE game_id = $1", [gameId])).rows,
      ).toEqual([]);
      expect((await read(gameId, foreignClub)).statusCode).toBe(403);
    }
  });
});
