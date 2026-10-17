import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ClubStatisticsResponse,
  PlayerStatisticsResponse,
  StatisticsGame,
} from "@mafia/game-domain";
import { UnsupportedGameFormatError } from "./game-session-identity.js";
import { buildClubRatingLedger } from "./club-rating.js";
import { statisticsGame } from "./test-helpers/club-statistics-fixtures.js";
import { createStatisticsApiFixture } from "./test-helpers/statistics-api-fixture.js";

describe("Azure statistics HTTP", () => {
  let fixture: Awaited<ReturnType<typeof createStatisticsApiFixture>>;
  beforeAll(async () => {
    fixture = await createStatisticsApiFixture();
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  });

  it.each([
    { mixedCase: false, independentRosterCase: false },
    { mixedCase: true, independentRosterCase: false },
    { mixedCase: true, independentRosterCase: true },
  ])(
    "reads complete history and event deltas with mixed-case UUIDs=$mixedCase, independent roster=$independentRosterCase without rewriting records",
    async ({ mixedCase, independentRosterCase }) => {
      const { app, stores } = fixture;
      const clubId = await fixture.createClub();
      const headers = { "x-club-id": clubId };
      const ids: string[] = [];
      for (let i = 0; i < 11; i++) {
        const response = await app.inject({
          method: "POST",
          url: "/api/players",
          headers,
          payload: { nickname: `Seat ${i}`, consent: false },
        });
        expect(response.statusCode, response.body).toBe(201);
        ids.push(response.json().player.id);
      }
      const events: string[] = [];
      for (const name of ["Event A", "Event B"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/tournaments",
          headers,
          payload: { name },
        });
        expect(response.statusCode, response.body).toBe(201);
        events.push(response.json().tournament.id);
      }
      const models: StatisticsGame[] = [];
      const payloads: {
        name: string;
        state: Record<string, unknown>;
        results: Record<string, unknown>;
      }[] = [];
      for (let i = 1; i <= 4; i++) {
        const template = statisticsGame(i, {
          outcome: i === 3 ? "black" : i === 4 ? "draw" : "red",
          tournamentId: i === 2 ? null : events[i === 3 ? 1 : 0]!,
        });
        const participants = template.participants!.map((player, index) => ({
          ...player,
          playerId: mixedCase && i % 2 === 1 ? ids[index]!.toUpperCase() : ids[index]!,
        }));
        const hostPlayerId = mixedCase ? ids[10]!.toUpperCase() : ids[10]!;
        const state = {
          hostPlayerId,
          game: {
            players: participants.map(({ playerId, ...player }) => ({
              ...player,
              id: independentRosterCase
                ? i % 2 === 1
                  ? playerId.toLowerCase()
                  : playerId.toUpperCase()
                : playerId,
            })),
          },
          events: [],
          opaque: "canonical fixture unchanged",
        };
        const results = {
          hostPlayerId,
          outcome: template.outcome,
          winner: template.outcome === "draw" ? null : template.outcome,
          reason: template.outcome === "draw" ? "agreement" : null,
          playedAt: template.playedAt,
          players: participants,
        };
        const payload = { name: template.name, state, results };
        const response = await app.inject({
          method: "POST",
          url: "/api/game-sessions",
          headers,
          payload: { ...payload, creationId: randomUUID(), tournamentId: template.tournamentId },
        });
        expect(response.statusCode, response.body).toBe(201);
        models.push({
          ...template,
          gameId: response.json().gameId,
          participants,
          hostPlayerId,
        });
        payloads.push(payload);
      }
      const stats = async (query = "") => {
        const response = await app.inject({ url: `/api/statistics${query}`, headers });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        return response.json<ClubStatisticsResponse>();
      };
      const player = (data: ClubStatisticsResponse, id = ids[0]!) =>
        data.players.find(({ playerId }) => playerId === id)!;
      const all = await stats();
      if (mixedCase) {
        expect(await stats(`?tournamentId=${events[0]!.toUpperCase()}`)).toEqual(
          await stats(`?tournamentId=${events[0]}`),
        );
        const upper = await app.inject({
          url: `/api/statistics/players/${ids[0]!.toUpperCase()}`,
          headers,
        });
        const lower = await app.inject({ url: `/api/statistics/players/${ids[0]}`, headers });
        expect(upper.statusCode, upper.body).toBe(200);
        expect(upper.json()).toEqual(lower.json());
        const scopedUpper = await app.inject({
          url: `/api/statistics/players/${ids[0]!.toUpperCase()}?tournamentId=${events[0]!.toUpperCase()}`,
          headers,
        });
        expect(scopedUpper.statusCode, scopedUpper.body).toBe(200);
        expect(scopedUpper.json().player.totals.games).toBe(2);
        for (const [index, model] of models.entries()) {
          const stored = await stores.games.get(model.gameId, clubId);
          expect(JSON.stringify(stored?.state)).toBe(JSON.stringify(payloads[index]!.state));
          expect(JSON.stringify(stored?.results)).toBe(JSON.stringify(payloads[index]!.results));
        }
      }
      expect(all.coverage).toEqual({
        completedGames: 4,
        partialGames: 0,
        unavailableGames: 0,
        pendingGames: 0,
      });
      expect(player(all)).toMatchObject({
        totals: { games: 4, wins: 2, draws: 1, losses: 1, winRate: 50 },
        rating: { ratedGames: 4, status: "provisional" },
      });
      const ledger = buildClubRatingLedger(models);
      const expectedA = [models[0]!, models[3]!].reduce(
        (sum, game) => sum + ledger.games.get(game.gameId)!.get(ids[0]!)!.change,
        0,
      );
      const eventA = await stats(`?tournamentId=${events[0]}`);
      expect(player(eventA)).toMatchObject({
        totals: { games: 2 },
        scopedRatedGames: 2,
        scopedRatingChange: Math.round(expectedA * 10) / 10,
        rating: player(all).rating,
      });
      expect(
        player(await stats(`?tournamentId=${events[0]}&role=sheriff`), ids[6]!).totals.games,
      ).toBe(2);
      const detail = await app.inject({
        url: `/api/statistics/players/${ids[0]}?limit=2`,
        headers,
      });
      expect(detail.statusCode, detail.body).toBe(200);
      const page = detail.json<PlayerStatisticsResponse>();
      expect(page.history).toHaveLength(2);
      expect(page.total).toBe(4);
      expect(page.player!.totals.games).toBe(4);
      const next = await app.inject({
        url: `/api/statistics/players/${ids[0]}?limit=2&cursor=${page.nextCursor}`,
        headers,
      });
      expect(next.statusCode, next.body).toBe(200);
      expect(next.json().nextCursor).toBeNull();
      expect(
        new Set([...page.history, ...next.json().history].map(({ gameId }) => gameId)).size,
      ).toBe(4);

      await fixture.removeProjection(clubId, models[0]!.gameId);
      expect(await stats()).toEqual(all);
      // Saving the same accepted snapshot only advances revision, not counts.
      const repeated = await app.inject({
        method: "PUT",
        url: `/api/game-sessions/${models[0]!.gameId}`,
        headers,
        payload: { ...payloads[0], mutationId: randomUUID() },
      });
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(await stats()).toEqual(all);
      const original = await stores.games.get(models[0]!.gameId, clubId);
      const assignment = await app.inject({
        method: "PUT",
        url: `/api/game-sessions/${models[0]!.gameId}/tournament`,
        headers,
        payload: { tournamentId: events[1] },
      });
      expect(assignment.statusCode, assignment.body).toBe(200);
      expect((await stores.games.get(models[0]!.gameId, clubId))?.state).toEqual(original?.state);
      expect((await stores.games.get(models[0]!.gameId, clubId))?.results).toEqual(
        original?.results,
      );
      expect(player(await stats()).rating).toEqual(player(all).rating);
      expect(player(await stats(`?tournamentId=${events[0]}`)).scopedRatedGames).toBe(1);
      const correctedPayload = {
        ...payloads[1]!,
        results: { ...payloads[1]!.results, outcome: "black", winner: "black" },
      };
      const corrected = await app.inject({
        method: "PUT",
        url: `/api/game-sessions/${models[1]!.gameId}`,
        headers,
        payload: { ...correctedPayload, mutationId: randomUUID() },
      });
      expect(corrected.statusCode, corrected.body).toBe(200);
      expect(player(await stats()).rating).not.toEqual(player(all).rating);
      const peerBeforeRetirement = player(await stats(), ids[1]!).rating;
      const retirement = await app.inject({
        method: "DELETE",
        url: `/api/players/${ids[0]}`,
        headers,
      });
      expect(retirement.statusCode, retirement.body).toBe(204);
      expect((await stats()).players.some(({ playerId }) => playerId === ids[0])).toBe(false);
      expect(player(await stats(), ids[1]!).rating).toEqual(peerBeforeRetirement);
      const retained = await app.inject({ url: `/api/statistics/players/${ids[0]}`, headers });
      expect(retained.statusCode, retained.body).toBe(200);
      expect(retained.json().player).toMatchObject({ nickname: "", totals: { games: 4 } });
      const deletion = await app.inject({
        method: "DELETE",
        url: `/api/game-sessions/${models[1]!.gameId}`,
        headers,
      });
      expect(deletion.statusCode, deletion.body).toBe(204);
      expect(player(await stats(), ids[1]!).totals.games).toBe(3);
      expect(player(await stats(), ids[1]!).rating).not.toEqual(peerBeforeRetirement);
    },
    30_000,
  );

  it.each([
    "truncated",
    "unknown-fields",
    "without-roster",
    "mismatched-roster",
    "casper",
    "host-only",
    "empty",
    "unknown-time",
    "active",
  ] as const)(
    "retains independent observations and truthful coverage for %s records",
    async (kind) => {
      const { app, stores } = fixture;
      const clubId = await fixture.createClub();
      const headers = { "x-club-id": clubId };
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const response = await app.inject({
          method: "POST",
          url: "/api/players",
          headers,
          payload: { nickname: `Observation ${i}`, consent: false },
        });
        expect(response.statusCode, response.body).toBe(201);
        ids.push(response.json().player.id);
      }
      const template = statisticsGame(1);
      const participants = template.participants!.map((p, i) => ({
        ...p,
        playerId: kind === "casper" && i === 9 ? "casper" : ids[i]!,
        ...(kind === "casper" && i === 9 ? { role: "citizen" as const, team: "red" as const } : {}),
      }));
      const roster = participants.map(({ playerId, ...p }) => ({ ...p, id: playerId }));
      if (kind === "mismatched-roster") roster[9] = { ...roster[9]!, id: ids[11]! };
      const unknown = kind === "unknown-fields";
      const finalPlayers =
        kind === "truncated"
          ? participants.slice(0, 9)
          : participants.map((p, i) =>
              unknown && i === 0
                ? { ...p, role: null, fouls: null, status: null, bestMoveHits: null }
                : p,
            );
      const state =
        kind === "without-roster" || kind === "empty" || kind === "host-only"
          ? {}
          : {
              hostPlayerId: ids[10],
              game: { players: roster },
              opaque: { stateHash: "retained marker" },
            };
      const results =
        kind === "active"
          ? null
          : kind === "empty"
            ? {}
            : {
                hostPlayerId: ids[10],
                outcome: "red",
                winner: "red",
                reason: null,
                playedAt: kind === "unknown-time" ? undefined : template.playedAt,
                ...(kind === "host-only" ? {} : { players: finalPlayers }),
              };
      const created = await app.inject({
        method: "POST",
        url: "/api/game-sessions",
        headers,
        payload: { creationId: randomUUID(), name: kind, state, results },
      });
      expect(created.statusCode, created.body).toBe(201);
      const gameId = created.json().gameId as string;
      const before = await stores.games.get(gameId, clubId);
      expect(before?.state).toEqual(state);
      expect(before?.results).toEqual(JSON.parse(JSON.stringify(results)));
      const response = await app.inject({ url: "/api/statistics", headers });
      expect(response.statusCode, response.body).toBe(200);
      const data = response.json<ClubStatisticsResponse>();
      const unavailable = kind === "empty" || kind === "host-only";
      const partial = ["truncated", "unknown-fields", "mismatched-roster", "unknown-time"].includes(
        kind,
      );
      expect(data.coverage).toEqual({
        completedGames: kind === "active" ? 0 : 1,
        pendingGames: kind === "active" ? 1 : 0,
        partialGames: partial ? 1 : 0,
        unavailableGames: unavailable ? 1 : 0,
      });
      const source = (await stores.games.readStatisticsInputs(clubId)).games[0]!;
      expect(source).not.toHaveProperty("rulesEdition");
      expect(source).toMatchObject({
        gameId,
        timelineAvailable: false,
        participants:
          kind === "active" || unavailable
            ? null
            : finalPlayers.filter((p) => p.playerId !== "casper"),
      });
      expect(data.players.find((p) => p.playerId === ids[0])?.totals.games).toBe(
        kind === "active" || unavailable ? 0 : 1,
      );
      if (kind === "active") expect(JSON.stringify(source)).not.toMatch(/"role"|stateHash|"fouls"/);
      const detail = await app.inject({ url: `/api/statistics/players/${ids[0]}`, headers });
      expect(detail.statusCode, detail.body).toBe(200);
      const history = detail.json<PlayerStatisticsResponse>().history;
      expect(history).toHaveLength(kind === "active" || unavailable ? 0 : 1);
      if (history[0])
        expect(history[0]).toMatchObject({
          timelineAvailable: false,
          statisticsAvailable: true,
          playedAt: kind === "unknown-time" ? null : template.playedAt,
        });
      const host = await app.inject({ url: `/api/statistics/players/${ids[10]}`, headers });
      expect(host.statusCode, host.body).toBe(200);
      expect(host.json().player.hostedGames).toBe(kind === "active" || kind === "empty" ? 0 : 1);
      expect(await stores.games.get(gameId, clubId)).toEqual(before);
    },
    30_000,
  );

  it("authenticates all reads, keeps member access, rejects malformed/foreign inputs and never hides failed reads", async () => {
    const { app, stores, owner, member } = fixture;
    const clubId = await fixture.createClub();
    const headers = { "x-club-id": clubId };
    const profile = await app.inject({
      method: "POST",
      url: "/api/players",
      headers,
      payload: {
        nickname: "Visible member",
        consent: true,
        clubAccess: "user",
        firstName: "Private",
        lastName: "Family",
        email: member.email,
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    await stores.clubs.claimClubAccess(member.id, member.email);
    fixture.setActor(member);
    const regular = await app.inject({ url: "/api/statistics", headers });
    expect(regular.statusCode, regular.body).toBe(200);
    expect(regular.body).not.toContain(member.email);
    expect(regular.body).not.toContain("Private");
    fixture.setActor(null);
    for (const url of [
      "/api/statistics",
      `/api/statistics/players/${profile.json().player.id}`,
      "/api/tournaments",
    ]) {
      expect((await app.inject({ url, headers })).statusCode).toBe(401);
    }
    fixture.setActor({ ...member, id: randomUUID() });
    expect((await app.inject({ url: "/api/statistics", headers })).statusCode).toBe(403);
    fixture.setActor(owner);
    expect((await app.inject({ url: "/api/statistics" })).statusCode).toBe(400);
    const otherClub = await fixture.createClub();
    const foreign = await app.inject({
      method: "POST",
      url: "/api/tournaments",
      headers: { "x-club-id": otherClub },
      payload: { name: "Foreign" },
    });
    expect(foreign.statusCode, foreign.body).toBe(201);
    const foreignPlayer = await app.inject({
      method: "POST",
      url: "/api/players",
      headers: { "x-club-id": otherClub },
      payload: { nickname: "Foreign profile", consent: false },
    });
    expect(foreignPlayer.statusCode, foreignPlayer.body).toBe(201);
    expect(
      (
        await app.inject({
          url: `/api/statistics/players/${foreignPlayer.json().player.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/api/statistics?tournamentId=${foreign.json().tournament.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/api/statistics/players/${randomUUID()}`, headers })).statusCode,
    ).toBe(404);
    for (const query of [
      "from=2026-02-30",
      "from=2026-02-02&to=2026-02-01",
      "to=not-date",
      "edition=unknown",
      "team=green",
      "role=host",
      "tournamentId=bad",
      "from=2026-01-01&from=2026-02-01",
      "unexpected=1",
    ]) {
      expect(
        (await app.inject({ url: `/api/statistics?${query}`, headers })).statusCode,
        query,
      ).toBe(400);
    }
    for (const query of [
      "limit=101",
      "limit=0",
      "limit=1.2",
      "cursor=garbage",
      "cursor=%%%",
      "limit=abc",
    ]) {
      expect(
        (
          await app.inject({
            url: `/api/statistics/players/${profile.json().player.id}?${query}`,
            headers,
          })
        ).statusCode,
        query,
      ).toBe(400);
    }
    expect((await app.inject({ url: "/api/statistics/players/bad", headers })).statusCode).toBe(
      400,
    );
    const failure = vi
      .spyOn(stores.games, "readStatisticsInputs")
      .mockRejectedValueOnce(new Error("private fixture storage error"));
    const failed = await app.inject({ url: "/api/statistics", headers });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "internal_server_error" });
    failure.mockRejectedValueOnce(new UnsupportedGameFormatError());
    const unsupported = await app.inject({ url: "/api/statistics", headers });
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json()).toEqual({ error: "unsupported_game_format" });
    failure.mockRestore();
  }, 30_000);
});
