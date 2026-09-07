// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import {
  createGameLogEntry,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type GameState,
} from "@mafia/game-domain";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { GameSessionStore } from "./game-session-store.js";
import { PlayerStore } from "./player-store.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia@127.0.0.1:54329/mafia_test";
const schemaName = `ui_save_contract_${randomUUID().replaceAll("-", "")}`;
const schemaPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });

let app: Awaited<ReturnType<typeof buildApp>>;
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
type Results = Parameters<GameSessionStore["save"]>[0]["results"];

const uiPath = resolve("../web/src/test-game-event-contract.ts");
// eslint-disable-next-line no-unsanitized/method -- Fixed repository-local UI fixture, no untrusted path.
const { captureUiEvent } = (await import(uiPath)) as {
  captureUiEvent: (
    game: GameState,
    action: "foul" | "red-card" | "ballot",
    seat?: number,
  ) => CanonicalGameEventDraft;
};
const resultsPath = resolve("../web/src/features/players/game-results.ts");
// eslint-disable-next-line no-unsanitized/method -- Fixed repository-local production result builder.
const { buildFinalGameResults } = (await import(resultsPath)) as {
  buildFinalGameResults: (game: GameState, playedAt: Date, hostPlayerId: string) => Results;
};

beforeAll(async () => {
  await schemaPool.query(`CREATE SCHEMA ${schemaName}`);
  // Fresh disposable schema; use a filesystem path because this test also renders browser UI.
  await pool.query(await readFile(resolve("src/schema.sql"), "utf8"));
  app = await buildApp({
    pool,
    defaultClubId: DEFAULT_CLUB_ID,
    authenticateRequest: async () => ({
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@mafiamalaga.es",
      name: "Contract owner",
      picture: null,
    }),
  });
});
afterAll(async () => {
  await app?.close();
  await pool.end();
  await schemaPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await schemaPool.end();
});

describe("real UI to whole-snapshot save contract", () => {
  it.each(["discipline", "ballot"] as const)(
    "persists %s events and retries unchanged requests",
    async (scenario) => {
      const club = await app.inject({
        method: "POST",
        url: "/api/clubs",
        payload: {
          name: `Contract ${scenario}`,
          city: "Málaga",
          headerLogo: null,
          cardLogo: null,
          language: "en",
          ownerConsent: true,
        },
      });
      expect(club.statusCode, club.body).toBe(201);
      const clubId = club.json().club.id as string;
      const clubHeaders = { "x-club-id": clubId };
      const profiles = await Promise.all(
        Array.from({ length: 11 }, (_, index) =>
          new PlayerStore(pool).create(
            {
              nickname: `Contract ${scenario} ${index}`,
              consent: false,
              firstName: null,
              lastName: null,
              email: null,
            },
            clubId,
          ),
        ),
      );
      const host = profiles[10]!;
      let game: GameState = {
        phase: "day",
        day: 1,
        players: profiles.slice(0, 10).map((profile, index) => ({
          id: profile.id,
          name: profile.nickname,
          seat: index + 1,
          role: roles[index]!,
          team: index >= 7 ? "black" : "red",
          status: "active",
          fouls: 0,
          mutePending: false,
        })),
        turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
        currentTurnIndex: 0,
        nominations: [],
        voteAssignments: {},
        shotAssignments: {},
        winner: null,
      };
      if (scenario === "ballot")
        game = {
          ...game,
          phase: "car-crash-decision",
          turnOrder: [4, 6],
          currentTurnIndex: 1,
          nominations: [
            { nominatorSeat: 1, candidateSeat: 4, order: 1 },
            { nominatorSeat: 2, candidateSeat: 6, order: 2 },
          ],
          votingRound: "repeat",
          carCrashSeats: [4, 6],
          carCrashVotes: {},
        };
      const gameId = randomUUID();
      const claimId = randomUUID();
      const initialGame = { replayVersion: 1 as const, game };
      const events: GameLogEntry[] = [];
      const append = (draft: CanonicalGameEventDraft) => {
        const created = createGameLogEntry({
          gameId,
          id: randomUUID(),
          sequence: events.length + 1,
          parentEventId: events.at(-1)?.id ?? null,
          createdAt: "2026-09-07T20:00:00.000Z",
          before: game,
          draft,
        });
        events.push(created.entry);
        game = created.after;
      };
      append({ type: "game.checkpointed", payload: {} });
      const snapshot = () => ({
        setup: null,
        game,
        hostPlayerId: host.id,
        hostName: host.nickname,
        playlistId: "",
        log: [],
        undoHistory: [],
        undoBudget: 0,
        initialGame,
        events: [...events],
        headEventId: events.at(-1)!.id,
        resetReturnEventId: null,
        legacyLog: [],
      });
      const url = `/api/game-sessions/${gameId}`;
      const created = await app.inject({
        method: "PUT",
        url,
        headers: { ...clubHeaders, "x-game-claim-id": claimId, "x-game-claim-generation": "0" },
        payload: {
          name: "UI save contract",
          mutationId: randomUUID(),
          baseRevision: 0,
          state: snapshot(),
          results: null,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const headers = {
        ...clubHeaders,
        "x-game-claim-id": claimId,
        "x-game-claim-generation": String(created.json().claim.generation),
      };
      let revision = created.json().revision as number;
      append(
        captureUiEvent(
          scenario === "discipline" ? { ...game, currentTurnIndex: 2 } : game,
          scenario === "discipline" ? "foul" : "ballot",
        ),
      );
      const mutation = {
        name: "UI save contract",
        mutationId: randomUUID(),
        baseRevision: revision,
        state: snapshot(),
        results: null,
      };
      const unchangedBytes = JSON.stringify(mutation);
      const beforeRejected = await app.inject({ method: "GET", url, headers: clubHeaders });
      const saveSpy = vi.spyOn(GameSessionStore.prototype, "save");
      try {
        const invalid = JSON.parse(unchangedBytes);
        invalid.state.events[1].payload.injected = true;
        const rejected = await app.inject({ method: "PUT", url, headers, payload: invalid });
        expect(rejected.statusCode).toBe(400);
        expect(saveSpy).not.toHaveBeenCalled();
        expect((await app.inject({ method: "GET", url, headers: clubHeaders })).body).toBe(
          beforeRejected.body,
        );
      } finally {
        saveSpy.mockRestore();
      }
      for (const duplicate of [false, true]) {
        const response = await app.inject({
          method: "PUT",
          url,
          headers: { ...headers, "content-type": "application/json" },
          payload: unchangedBytes,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({
          duplicate,
          revision: revision + 1,
          status: "active",
        });
        expect(response.json().state.events).toEqual(events);
      }
      revision += 1;
      if (scenario === "discipline") {
        for (const seat of [8, 9, 10]) append(captureUiEvent(game, "red-card", seat));
        expect(game.winner).toBe("red");
        append({ type: "game.completed", payload: { winner: "red" } });
        const results = buildFinalGameResults(game, new Date("2026-09-07T20:00:00.000Z"), host.id);
        expect(results).not.toBeNull();
        const completion = JSON.stringify({
          name: "UI save contract",
          mutationId: randomUUID(),
          baseRevision: revision,
          state: snapshot(),
          results,
        });
        for (const duplicate of [false, true]) {
          const response = await app.inject({
            method: "PUT",
            url,
            headers: { ...headers, "content-type": "application/json" },
            payload: completion,
          });
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json()).toMatchObject({
            duplicate,
            revision: revision + 1,
            status: "completed",
          });
          expect(response.json().results).toEqual(results);
          expect(response.json().state.events).toEqual(events);
        }
        const rows = await pool.query(
          "SELECT * FROM game_player_results WHERE club_id = $1 AND game_id = $2",
          [clubId, gameId],
        );
        expect(rows.rowCount).toBe(10);
      }
      const persisted = await app.inject({ method: "GET", url, headers: clubHeaders });
      expect(persisted.json().session.state.events).toEqual(events);
      expect(persisted.json().session.state.game).toEqual(JSON.parse(JSON.stringify(game)));
      const canonical = await pool.query(
        "SELECT id, payload, state_hash_after FROM game_events WHERE club_id = $1 AND game_id = $2 AND replay_sequence IS NOT NULL ORDER BY replay_sequence",
        [clubId, gameId],
      );
      expect(canonical.rows).toEqual(
        events.map(({ id, payload, stateHashAfter }) => ({
          id,
          payload,
          state_hash_after: stateHashAfter,
        })),
      );
    },
  );
});
