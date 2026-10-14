import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import {
  advanceSetupPhase,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  hashGameState,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameState,
} from "@mafia/game-domain";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { initializeSchema } from "./initialize-schema.js";
import { verifyAdjudicationHttp } from "./test-helpers/adjudication-http.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia@127.0.0.1:54329/mafia_test";
const schemaName = `whole_snapshot_save_${randomUUID().replaceAll("-", "")}`;
const schemaPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await schemaPool.query(`CREATE SCHEMA ${schemaName}`);
  await initializeSchema(pool);
  app = await buildApp({
    pool,
    defaultClubId: DEFAULT_CLUB_ID,
    authenticateRequest: async () => ({
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@mafiamalaga.es",
      name: "Owner",
      picture: null,
    }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await schemaPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await schemaPool.end();
});

describe("whole snapshot save", () => {
  it("creates once then persists opaque browser snapshots through PUT", async () => {
    const creation = await app.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers: { "x-club-id": DEFAULT_CLUB_ID },
      payload: {
        creationId: randomUUID(),
        name: "UI",
        state: { setup: { transient: true } },
        results: null,
      },
    });
    expect(creation.statusCode).toBe(201);
    const gameId = creation.json().gameId as string;
    const saved = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": DEFAULT_CLUB_ID },
      payload: {
        kind: "snapshot",
        name: "UI saved",
        mutationId: randomUUID(),
        state: { game: { phase: "client-only" }, replay: { notVerified: true } },
        results: null,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      name: "UI saved",
      state: { replay: { notVerified: true } },
    });
  });

  it("round-trips a rendered UI action and anonymous completed timeline through real API and database", async () => {
    // Keep Vitest's Node environment: jsdom's Vite import.meta.url rewrite breaks
    // initializeSchema's file URL. Install a DOM only around rendered UI work.
    const jsdomSource = pathToFileURL(
      resolve(process.cwd(), "../../node_modules/jsdom/lib/api.js"),
    ).href;
    // eslint-disable-next-line no-unsanitized/method -- Fixed installed test dependency path.
    const { JSDOM } = (await import(/* @vite-ignore */ jsdomSource)) as {
      JSDOM: new (
        html: string,
        options: { url: string },
      ) => { window: Window & { close: () => void } };
    };
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
    const browser = dom.window as unknown as Record<string, unknown>;
    for (const key of [
      "window",
      "document",
      "navigator",
      "HTMLElement",
      "Node",
      "MutationObserver",
    ] as const) {
      vi.stubGlobal(key, key === "window" ? dom.window : browser[key]);
    }
    try {
      // Fixed test source import keeps browser code outside the server TypeScript rootDir.
      const source = pathToFileURL(
        resolve(process.cwd(), "../web/src/test-game-event-contract.ts"),
      ).href;
      // eslint-disable-next-line no-unsanitized/method -- Fixed repository-local test module.
      const ui = (await import(/* @vite-ignore */ source)) as {
        captureUiEvent: (game: GameState, action: "foul", seat: number) => CanonicalGameEventDraft;
        observeSavedTimeline: (
          clubId: string,
          gameId: string,
          players: readonly { id: string; nickname: string }[],
          loaders: {
            listCompleted: (id: string, filters: Record<string, unknown>) => Promise<unknown>;
            getSession: (id: string, clubId: string) => Promise<unknown>;
          },
        ) => Promise<{ foulLabel: string; text: string }>;
      };
      const resultsSource = pathToFileURL(
        resolve(process.cwd(), "../web/src/features/players/game-results.ts"),
      ).href;
      // eslint-disable-next-line no-unsanitized/method -- Fixed repository-local test module.
      const { buildFinalGameResults } = (await import(/* @vite-ignore */ resultsSource)) as {
        buildFinalGameResults: (
          game: GameState,
          at: Date,
          hostId: string,
          reason: string,
        ) => unknown;
      };
      const profile = async (nickname: string) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/players",
          payload: {
            nickname,
            consent: false,
            firstName: null,
            lastName: null,
            email: null,
          },
        });
        expect(response.statusCode, response.body).toBe(201);
        return response.json().player as { id: string; nickname: string };
      };
      const host = await profile(`UI host ${randomUUID()}`);
      const seats = await Promise.all(
        Array.from({ length: 10 }, (_, index) => profile(`UI seat ${index + 1} ${randomUUID()}`)),
      );
      let setup = beginRoleDraw(
        createSetup(seats.map(({ id }, index) => ({ id, seat: index + 1 }))),
        createSeededRandom(41),
      );
      for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
      setup = completeRoleDraw(setup);
      const baseline = {
        replayVersion: 1 as const,
        game: advanceSetupPhase(advanceSetupPhase(createGame(setup))),
      };
      const created = await app.inject({
        method: "POST",
        url: "/api/game-sessions",
        payload: {
          creationId: randomUUID(),
          name: "UI history",
          state: {},
          results: null,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const gameId = created.json().gameId as string;
      const draft = ui.captureUiEvent(baseline.game, "foul", 1);
      expect(draft.type).toBe("foul.issued");
      const root = createGameLogEntry({
        gameId,
        id: randomUUID(),
        sequence: 1,
        parentEventId: null,
        createdAt: "2026-09-26T11:59:59.000Z",
        before: baseline.game,
        draft: { type: "game.checkpointed", payload: {} },
      });
      const foul = createGameLogEntry({
        gameId,
        id: randomUUID(),
        sequence: 2,
        parentEventId: root.entry.id,
        createdAt: "2026-09-26T12:00:00.000Z",
        before: baseline.game,
        draft,
      });
      const drawn = createGameLogEntry({
        gameId,
        id: randomUUID(),
        sequence: 3,
        parentEventId: foul.entry.id,
        createdAt: "2026-09-26T12:00:01.000Z",
        before: foul.after,
        draft: { type: "game.drawn", payload: { reason: "Moderator ruling" } },
      });
      const state = {
        hostPlayerId: host.id,
        setup: null,
        game: drawn.after,
        initialGame: baseline,
        events: [root.entry, foul.entry, drawn.entry],
        headEventId: drawn.entry.id,
        log: [],
      };
      const results = buildFinalGameResults(
        drawn.after,
        new Date("2026-09-26T12:00:01.000Z"),
        host.id,
        "Moderator ruling",
      );
      expect(results).not.toBeNull();
      const pending = await app.inject({
        method: "PUT",
        url: `/api/game-sessions/${gameId}`,
        payload: {
          name: "UI history",
          mutationId: randomUUID(),
          state,
          results: null,
        },
      });
      expect(pending.statusCode, pending.body).toBe(200);
      const pendingReadback = await app.inject({
        method: "GET",
        url: `/api/game-sessions/${gameId}`,
      });
      expect(pendingReadback.json().session).toMatchObject({
        gameId,
        status: "active",
        results: null,
        state: { game: { phase: "draw", winner: null }, headEventId: drawn.entry.id },
      });
      expect(pendingReadback.json().session.state.events.at(-1)).toMatchObject({
        type: "game.drawn",
        payload: { reason: "Moderator ruling" },
      });
      const activeListing = await app.inject({
        method: "GET",
        url: "/api/game-sessions?status=active",
      });
      expect(activeListing.json().sessions).toContainEqual(
        expect.objectContaining({ gameId, phase: "draw", hostPlayerId: host.id }),
      );
      const pendingCompleted = await app.inject({
        method: "GET",
        url: "/api/game-sessions?status=completed",
      });
      expect(pendingCompleted.json().sessions).toEqual([]);
      const pendingProjections = await pool.query(
        "SELECT player_id FROM game_player_results WHERE game_id = $1",
        [gameId],
      );
      expect(pendingProjections.rows).toEqual([]);
      const saved = await app.inject({
        method: "PUT",
        url: `/api/game-sessions/${gameId}`,
        payload: {
          name: "UI history",
          mutationId: randomUUID(),
          state,
          results,
        },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const completedActive = await app.inject({
        method: "GET",
        url: "/api/game-sessions?status=active",
      });
      expect(completedActive.json().sessions).not.toContainEqual(
        expect.objectContaining({ gameId }),
      );
      const before = (
        await pool.query<{ state: string; results: string }>(
          "SELECT state::text, results::text FROM game_sessions WHERE id = $1",
          [gameId],
        )
      ).rows[0]!;
      expect(before.state).not.toContain(seats[0]!.nickname);
      expect(before.state).not.toContain(host.nickname);
      const hash = hashGameState(drawn.after);
      const projections = (
        await pool.query<{ player_id: string; won: boolean | null }>(
          "SELECT player_id, won FROM game_player_results WHERE game_id = $1 ORDER BY seat",
          [gameId],
        )
      ).rows;
      expect(projections).toHaveLength(10);
      expect(projections[1]?.player_id).toBe(seats[1]!.id);
      const directory = async () => {
        const response = await app.inject({ method: "GET", url: "/api/players" });
        expect(response.statusCode, response.body).toBe(200);
        return response.json().players as { id: string; nickname: string }[];
      };
      const loaders = {
        listCompleted: async (id: string, filters: Record<string, unknown>) => {
          expect(id).toBe(DEFAULT_CLUB_ID);
          const params = new URLSearchParams({
            status: "completed",
            ...Object.fromEntries(
              Object.entries(filters).map(([key, value]) => [key, String(value)]),
            ),
          });
          const response = await app.inject({ method: "GET", url: `/api/game-sessions?${params}` });
          expect(response.statusCode, response.body).toBe(200);
          return response.json().sessions;
        },
        getSession: async (id: string, clubId: string) => {
          expect([id, clubId]).toEqual([gameId, DEFAULT_CLUB_ID]);
          const response = await app.inject({ method: "GET", url: `/api/game-sessions/${id}` });
          expect(response.statusCode, response.body).toBe(200);
          return response.json().session;
        },
      };
      const initialReadback = await loaders.getSession(gameId, DEFAULT_CLUB_ID);
      expect(initialReadback).toMatchObject({ gameId, status: "completed" });
      expect(
        replayGameLog(initialReadback.state.initialGame, initialReadback.state.events, gameId).game,
      ).toEqual(initialReadback.state.game);
      const named = await ui.observeSavedTimeline(
        DEFAULT_CLUB_ID,
        gameId,
        await directory(),
        loaders,
      );
      expect(named.foulLabel).toBe(`Foul 1: ${seats[0]!.nickname}`);
      expect(named.text).toContain(host.nickname);
      const listed = await loaders.listCompleted(DEFAULT_CLUB_ID, {});
      expect(listed).toEqual([expect.objectContaining({ gameId, hostPlayerId: host.id })]);
      expect(JSON.stringify(listed)).not.toContain(host.nickname);
      expect(JSON.stringify(listed)).not.toContain("hostName");
      const retire = async (id: string) => {
        const response = await app.inject({ method: "DELETE", url: `/api/players/${id}` });
        expect(response.statusCode, response.body).toBe(204);
      };
      await retire(seats[0]!.id);
      await retire(host.id);
      const remaining = await directory();
      expect(remaining.some(({ id }) => id === seats[0]!.id || id === host.id)).toBe(false);
      const anonymous = await ui.observeSavedTimeline(DEFAULT_CLUB_ID, gameId, remaining, loaders);
      expect(anonymous.foulLabel).toBe("Foul 1: Anonymous player");
      expect(anonymous.text).toContain("Anonymous player");
      expect(anonymous.text).not.toContain("Unknown host");
      expect(anonymous.text).not.toContain(seats[0]!.nickname);
      expect(anonymous.text).not.toContain(host.nickname);
      const loaded = await loaders.getSession(gameId, DEFAULT_CLUB_ID);
      expect(loaded.state).toEqual(JSON.parse(before.state));
      expect(loaded.results).toEqual(JSON.parse(before.results));
      expect(hashGameState(loaded.state.game)).toBe(hash);
      expect(replayGameLog(loaded.state.initialGame, loaded.state.events, gameId).game).toEqual(
        loaded.state.game,
      );
      expect(loaded.state.events[2].stateHashAfter).toBe(hash);
      expect(
        (
          await pool.query("SELECT state::text, results::text FROM game_sessions WHERE id = $1", [
            gameId,
          ])
        ).rows[0],
      ).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT player_id, won FROM game_player_results WHERE game_id = $1 ORDER BY seat",
            [gameId],
          )
        ).rows,
      ).toEqual(projections);
    } finally {
      vi.unstubAllGlobals();
      dom.window.close();
    }
  });

  it("preserves a pending and completed adjudication through PostgreSQL HTTP reads", async () => {
    await verifyAdjudicationHttp(app, DEFAULT_CLUB_ID);
  });
});
