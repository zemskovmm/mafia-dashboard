import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { blobReference } from "./azure-storage.js";
import { createApplicationStorageFixture } from "./test-helpers/storage-fixture.js";

const owner = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@mafiamalaga.es",
  name: "Owner",
  picture: null,
};
const fixture = await createApplicationStorageFixture(owner);
const { stores, storage } = fixture;
const app = await buildApp({
  stores,
  defaultClubId: DEFAULT_CLUB_ID,
  authenticateRequest: async () => owner,
});
await app.ready();
afterAll(async () => {
  await app.close();
  await fixture.close();
});
const profile = async () =>
  (
    await stores.players.create({
      nickname: `Fact ${randomUUID()}`,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    })
  ).id;

const cases = [
  "absent-roster",
  "same-identities",
  "replacement-one",
  "explicit-null",
  "explicit-invalid",
  "explicit-correction",
  "empty-roster",
  "null-roster",
  "active",
  "nonterminal-completed",
] as const;
describe("completed participant observation precedence through Azure", () => {
  it.each([
    { field: "rosterComplete", value: null, expected: null, reason: "incomplete-results" },
    { field: "rosterComplete", value: "true", expected: null, reason: "incomplete-results" },
    { field: "rosterComplete", value: false, expected: false, reason: "ineligible-roster" },
    { field: "rosterComplete", value: true, expected: true, reason: null },
    { field: "hasCasper", value: null, expected: null, reason: "incomplete-results" },
    { field: "hasCasper", value: "false", expected: null, reason: "incomplete-results" },
    { field: "hasCasper", value: true, expected: true, reason: "casper" },
    { field: "hasCasper", value: false, expected: false, reason: null },
    { field: "omitted", value: null, expected: null, reason: null },
    { field: "hasCasper-omitted", value: null, expected: null, reason: null },
  ])(
    "preserves explicit rating observation $field=$value independently of fallback",
    async ({ field, value, expected, reason }) => {
      const host = await profile();
      const players = [];
      for (let index = 0; index < 10; index++) {
        players.push({
          playerId: await profile(),
          seat: index + 1,
          role: index === 0 ? "don" : index < 3 ? "mafia" : index === 3 ? "sheriff" : "citizen",
          team: index < 3 ? "black" : "red",
        });
      }
      const state = {
        hostPlayerId: host,
        // Opposite stale setup evidence must never override an explicit boolean.
        setup: { casperEnabled: field === "hasCasper" && value === false },
        game: {
          phase: "finished",
          players: players.map(({ playerId, ...facts }) => ({ id: playerId, ...facts })),
        },
      };
      const results = {
        hostPlayerId: host,
        outcome: "red",
        playedAt: "2026-10-15T18:00:00Z",
        players,
        ...(field.startsWith("hasCasper") ? { rosterComplete: true } : { hasCasper: false }),
        ...(field.includes("omitted") ? {} : { [field]: value }),
      };
      const response = await app.inject({
        method: "POST",
        url: "/api/game-sessions",
        payload: { creationId: randomUUID(), name: `Rating ${field} ${value}`, state, results },
      });
      expect(response.statusCode, response.body).toBe(201);
      const gameId = response.json().gameId as string;
      const row = (await storage.getEntity(`club:${DEFAULT_CLUB_ID}:game:${gameId}`))!;
      const blob = storage.blobs.getBlockBlobClient(blobReference(row).name);
      const before = await blob.downloadToBuffer();
      const source = (await stores.games.readStatisticsInputs()).games.find(
        (game) => game.gameId === gameId,
      )!;
      expect(source).toMatchObject({
        rosterComplete: field === "rosterComplete" ? expected : true,
        hasCasper: field === "hasCasper" ? expected : false,
      });
      const history = await app.inject({ url: `/api/statistics/players/${players[0]!.playerId}` });
      expect(history.statusCode, history.body).toBe(200);
      expect(
        history.json().history.find((game: { gameId: string }) => game.gameId === gameId),
      ).toMatchObject({
        unratedReason: reason,
        ratingChange: reason === null ? expect.any(Object) : null,
      });
      const detail = await app.inject({ url: `/api/game-sessions/${gameId}` });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().session).toMatchObject({ state, results });
      expect(await blob.downloadToBuffer()).toEqual(before);
    },
  );
  it.each([
    "finished",
    "draw",
    "cancelled",
    "result-seat-correction",
    "different-result-player",
    "replacement-player",
    "ambiguous-owner-seat",
    "unknown-snapshot-seat",
    "invalid-snapshot-seat",
    "different-owner-seat",
    "invalid-owner-seat",
    "invalid-aggregate-hits",
    "zero-aggregate-hits",
    "result-null",
    "result-invalid",
    "result-zero",
    "snapshot-null",
    "snapshot-invalid",
    "snapshot-zero",
    "empty-roster",
    "null-roster",
    "nonterminal",
    "unknown-phase",
    "active",
  ] as const)(
    "projects only the uniquely owned stored aggregate Best Move observation: %s",
    async (kind) => {
      const a = await profile();
      const b = await profile();
      const replacement = await profile();
      const snapshotOverride = kind.startsWith("snapshot-");
      const resultOverride = kind.startsWith("result-") && kind !== "result-seat-correction";
      const override = kind.endsWith("null") ? null : kind.endsWith("zero") ? 0 : -1;
      const state = {
        game: {
          phase:
            kind === "unknown-phase"
              ? null
              : kind === "nonterminal"
                ? "day"
                : kind === "draw" || kind === "cancelled"
                  ? kind
                  : "finished",
          players: [
            {
              id: a.toUpperCase(),
              seat:
                kind === "unknown-snapshot-seat"
                  ? null
                  : kind === "invalid-snapshot-seat"
                    ? "1"
                    : 1,
              ...(snapshotOverride ? { bestMoveHits: override } : {}),
            },
            { id: b, seat: kind === "ambiguous-owner-seat" ? 1 : 2 },
          ],
          bestMove: {
            playerSeat:
              kind === "different-owner-seat" ? 2 : kind === "invalid-owner-seat" ? "1" : 1,
            mafiaHits:
              kind === "invalid-aggregate-hits" ? -1 : kind === "zero-aggregate-hits" ? 0 : 2,
          },
        },
      };
      const selected =
        kind === "different-result-player" ? b : kind === "replacement-player" ? replacement : a;
      const results =
        kind === "active"
          ? null
          : {
              outcome: "red",
              players:
                kind === "empty-roster"
                  ? []
                  : kind === "null-roster"
                    ? null
                    : [
                        {
                          playerId: selected,
                          ...(kind === "result-seat-correction"
                            ? { seat: 2 }
                            : kind === "different-result-player" || kind === "replacement-player"
                              ? { seat: 1 }
                              : {}),
                          ...(resultOverride ? { bestMoveHits: override } : {}),
                        },
                      ],
            };
      const response = await app.inject({
        method: "POST",
        url: "/api/game-sessions",
        payload: { creationId: randomUUID(), name: `Best Move ${kind}`, state, results },
      });
      expect(response.statusCode, response.body).toBe(201);
      const gameId = response.json().gameId as string;
      const row = (await storage.getEntity(`club:${DEFAULT_CLUB_ID}:game:${gameId}`))!;
      const blob = storage.blobs.getBlockBlobClient(blobReference(row).name);
      const before = await blob.downloadToBuffer();
      const source = (await stores.games.readStatisticsInputs()).games.find(
        (game) => game.gameId === gameId,
      )!;
      const expectedHits = ["finished", "draw", "cancelled", "result-seat-correction"].includes(
        kind,
      )
        ? 2
        : ["result-zero", "snapshot-zero", "zero-aggregate-hits"].includes(kind)
          ? 0
          : null;
      const appearance = !["active", "empty-roster", "null-roster"].includes(kind);
      if (appearance)
        expect(source.participants).toEqual([
          expect.objectContaining({ playerId: selected, bestMoveHits: expectedHits }),
        ]);
      else expect(source.participants).toEqual(kind === "empty-roster" ? [] : null);
      const projected = await storage.read((tx) =>
        tx.list<Record<string, unknown>>(`club:${DEFAULT_CLUB_ID}:result:${gameId}:`),
      );
      expect(projected).toHaveLength(appearance ? 1 : 0);
      if (appearance) {
        if (expectedHits === null) expect(projected[0]).not.toHaveProperty("bestMoveHits");
        else expect(projected[0]).toHaveProperty("bestMoveHits", expectedHits);
      }
      const detail = await app.inject({ url: `/api/statistics/players/${selected}` });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().player).toMatchObject({
        bestMoveResults: appearance && expectedHits !== null ? 1 : 0,
        bestMoveHits: expectedHits ?? 0,
      });
      const saved = await app.inject({ url: `/api/game-sessions/${gameId}` });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().session).toMatchObject({ state, results });
      expect(await blob.downloadToBuffer()).toEqual(before);
    },
  );
  it.each(["omitted", "null", "empty", "replacement"] as const)(
    "honors an explicitly cleared or corrected completed host: %s",
    async (kind) => {
      const participant = await profile();
      const oldHost = await profile();
      const replacement = await profile();
      const state = {
        hostPlayerId: oldHost,
        game: {
          phase: "finished",
          winner: "red",
          players: [
            { id: participant, seat: 1, role: "citizen", team: "red", status: "active", fouls: 1 },
          ],
        },
      };
      const results = {
        outcome: "red",
        winner: null,
        players: [{ playerId: participant }],
        ...(kind === "omitted"
          ? {}
          : { hostPlayerId: kind === "null" ? null : kind === "empty" ? "" : replacement }),
      };
      const response = await app.inject({
        method: "POST",
        url: "/api/game-sessions",
        payload: { creationId: randomUUID(), name: `Host ${kind}`, state, results },
      });
      expect(response.statusCode, response.body).toBe(201);
      const gameId = response.json().gameId as string;
      const expectedHost =
        kind === "omitted" ? oldHost : kind === "replacement" ? replacement : null;
      const source = (await stores.games.readStatisticsInputs()).games.find(
        (game) => game.gameId === gameId,
      )!;
      expect(source.hostPlayerId).toBe(expectedHost);
      const listed = (await stores.games.listCompleted()).find((game) => game.gameId === gameId)!;
      expect(listed).toMatchObject({ hostPlayerId: expectedHost, winner: null });
      for (const host of [oldHost, replacement]) {
        const response = await app.inject({ url: `/api/statistics/players/${host}` });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().player.hostedGames).toBe(host === expectedHost ? 1 : 0);
      }
      const rows = await storage.read((tx) =>
        tx.list<Record<string, unknown>>(`club:${DEFAULT_CLUB_ID}:result:${gameId}:`),
      );
      expect(rows.filter((row) => row.isHost).map((row) => row.playerId)).toEqual(
        expectedHost === null ? [] : [expectedHost],
      );
      const detail = await app.inject({ url: `/api/game-sessions/${gameId}` });
      expect(detail.json().session).toMatchObject({ state, results });
    },
  );
  it.each(cases)(
    "preserves independently stored facts without replay or roster union: %s",
    async (kind) => {
      const a = await profile();
      const b = await profile();
      const host = await profile();
      const snapshotFacts = {
        seat: 1,
        role: "sheriff",
        team: "red",
        status: "eliminated",
        fouls: 2,
        bestMoveHits: 2,
      };
      const secondFacts = {
        seat: 2,
        role: "mafia",
        team: "black",
        status: "active",
        fouls: 0,
        bestMoveHits: 0,
      };
      const unknown = {
        seat: null,
        role: null,
        team: null,
        status: null,
        fouls: null,
        bestMoveHits: null,
      };
      const correction = {
        seat: 5,
        role: "don",
        team: "black",
        status: "active",
        fouls: 0,
        bestMoveHits: 0,
      };
      const state = {
        hostPlayerId: host,
        game: {
          phase: kind === "active" || kind === "nonterminal-completed" ? "day" : "finished",
          day: 3,
          players: [
            { id: a, ...snapshotFacts },
            { id: b, ...secondFacts },
          ],
        },
      };
      const rawPlayers =
        kind === "empty-roster"
          ? []
          : kind === "null-roster"
            ? null
            : kind === "same-identities"
              ? [{ playerId: a.toUpperCase() }, { playerId: b }]
              : [
                  {
                    playerId: a.toUpperCase(),
                    ...(kind === "explicit-null"
                      ? unknown
                      : kind === "explicit-invalid"
                        ? {
                            seat: "1",
                            role: false,
                            team: "invalid",
                            status: 0,
                            fouls: false,
                            bestMoveHits: -1,
                          }
                        : kind === "explicit-correction"
                          ? correction
                          : {}),
                  },
                ];
      const results =
        kind === "active"
          ? null
          : {
              hostPlayerId: host,
              outcome: "red",
              playedAt: "2026-10-15T18:00:00Z",
              ...(kind === "absent-roster" ? {} : { players: rawPlayers }),
            };
      const response = await app.inject({
        method: "POST",
        url: "/api/game-sessions",
        payload: { creationId: randomUUID(), name: kind, state, results },
      });
      expect(response.statusCode, response.body).toBe(201);
      const gameId = response.json().gameId as string;
      const row = (await storage.getEntity(`club:${DEFAULT_CLUB_ID}:game:${gameId}`))!;
      const blob = storage.blobs.getBlockBlobClient(blobReference(row).name);
      const before = await blob.downloadToBuffer();
      const source = (await stores.games.readStatisticsInputs()).games.find(
        (game) => game.gameId === gameId,
      )!;
      const facts =
        kind === "explicit-null" || kind === "explicit-invalid" || kind === "nonterminal-completed"
          ? unknown
          : kind === "explicit-correction"
            ? correction
            : snapshotFacts;
      const expected =
        kind === "active" || kind === "null-roster"
          ? null
          : kind === "empty-roster"
            ? []
            : [
                { playerId: kind === "absent-roster" ? a : a.toUpperCase(), ...facts },
                ...(kind === "absent-roster" || kind === "same-identities"
                  ? [{ playerId: b, ...secondFacts }]
                  : []),
              ];
      expect(source.participants).toEqual(expected);
      const summary = await app.inject({ url: "/api/statistics" });
      expect(summary.statusCode, summary.body).toBe(200);
      const own = summary.json().players.find((p: { playerId: string }) => p.playerId === a);
      const appearance = expected !== null && expected.length > 0;
      const knownFouls = appearance && facts.fouls !== null;
      expect(own).toMatchObject({
        totals: {
          games: appearance ? 1 : 0,
          outcomeGames: appearance && facts.team !== null ? 1 : 0,
          wins: appearance && facts.team === "red" ? 1 : 0,
          losses: appearance && facts.team === "black" ? 1 : 0,
        },
        foulGames: knownFouls ? 1 : 0,
        fouls: knownFouls ? facts.fouls : 0,
        statusGames: appearance && facts.status !== null ? 1 : 0,
      });
      for (const [id, count] of [
        [a, appearance ? 1 : 0],
        [b, kind === "absent-roster" || kind === "same-identities" ? 1 : 0],
      ] as const) {
        const history = await app.inject({ url: `/api/statistics/players/${id}` });
        expect(history.statusCode, history.body).toBe(200);
        expect(history.json().history).toHaveLength(count);
        const completed = await app.inject({
          url: `/api/game-sessions?status=completed&playerId=${id}`,
        });
        expect(completed.statusCode, completed.body).toBe(200);
        expect(completed.json().sessions).toHaveLength(count);
      }
      const projected = await storage.read((tx) =>
        tx.list<Record<string, unknown>>(`club:${DEFAULT_CLUB_ID}:result:${gameId}:`),
      );
      const projectedA = projected.find((p) => String(p.playerId).toLowerCase() === a);
      expect(Boolean(projectedA)).toBe(appearance);
      if (projectedA)
        for (const [key, value] of Object.entries(facts)) {
          if (value === null) expect(projectedA).not.toHaveProperty(key);
          else expect(projectedA[key]).toEqual(value);
        }
      const detail = await app.inject({ url: `/api/game-sessions/${gameId}` });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().session).toMatchObject({ state, results });
      expect(await blob.downloadToBuffer()).toEqual(before);
    },
  );
});
