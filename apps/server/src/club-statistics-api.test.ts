import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FEDERATION_RULES_EDITION } from "@mafia/game-domain";
import type {
  ClubStatisticsResponse,
  PlayerStatisticsResponse,
  StatisticsGame,
} from "@mafia/game-domain";
import { UnsupportedGameFormatError } from "./game-session-identity.js";
import { buildClubRatingLedger } from "./club-rating.js";
import { statisticsGame } from "./test-helpers/club-statistics-fixtures.js";
import { createStatisticsApiFixture } from "./test-helpers/statistics-api-fixture.js";

for (const provider of ["postgres", "azure"] as const)
  describe(`${provider} statistics HTTP`, () => {
    let fixture: Awaited<ReturnType<typeof createStatisticsApiFixture>>;
    beforeAll(async () => {
      fixture = await createStatisticsApiFixture(provider);
    }, 30_000);
    afterAll(async () => {
      await fixture?.close();
    });

    it("reads complete authoritative history, interleaved event deltas, corrections, deletion and retirement", async () => {
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
          playerId: ids[index]!,
        }));
        const state = {
          hostPlayerId: ids[10],
          game: {
            rulesEdition: FEDERATION_RULES_EDITION,
            players: participants.map(({ playerId, ...player }) => ({ ...player, id: playerId })),
          },
          events: [],
          opaque: "canonical fixture unchanged",
        };
        const results = {
          hostPlayerId: ids[10],
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
          hostPlayerId: ids[10]!,
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
      expect(all.coverage).toEqual({ completedGames: 4, unavailableGames: 0, pendingGames: 0 });
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
    }, 30_000);

    it("keeps legacy/Casper facts but excludes them from Elo, exposes incomplete coverage and hides active roles", async () => {
      const { app } = fixture;
      const clubId = await fixture.createClub();
      const headers = { "x-club-id": clubId };
      const ids: string[] = [];
      for (let i = 0; i < 11; i++) {
        const response = await app.inject({
          method: "POST",
          url: "/api/players",
          headers,
          payload: { nickname: `Format ${i}`, consent: false },
        });
        expect(response.statusCode, response.body).toBe(201);
        ids.push(response.json().player.id);
      }
      for (const kind of [
        "federation",
        "legacy",
        "casper",
        "cancelled",
        "incomplete",
        "active",
      ] as const) {
        const template = statisticsGame(1);
        const participants = template.participants!.map((player, i) => ({
          ...player,
          playerId: kind === "casper" && i === 9 ? "casper" : ids[i]!,
          ...(kind === "casper" && i === 9
            ? { role: "citizen", team: "red" }
            : kind === "casper" && i === 0
              ? { role: "don", team: "black" }
              : {}),
        }));
        const state = {
          hostPlayerId: ids[10],
          game: {
            ...(kind === "legacy" ? {} : { rulesEdition: FEDERATION_RULES_EDITION }),
            players: participants.map(({ playerId, ...player }) => ({ ...player, id: playerId })),
          },
        };
        const results =
          kind === "active"
            ? null
            : {
                hostPlayerId: ids[10],
                outcome: kind === "cancelled" ? "cancelled" : "red",
                winner: kind === "cancelled" ? null : "red",
                reason: kind === "cancelled" ? "Host cancelled" : null,
                playedAt: template.playedAt,
                ...(kind === "incomplete" ? {} : { players: participants }),
              };
        const response = await app.inject({
          method: "POST",
          url: "/api/game-sessions",
          headers,
          payload: { creationId: randomUUID(), name: kind, state, results },
        });
        expect(response.statusCode, response.body).toBe(201);
      }
      const response = await app.inject({ url: "/api/statistics", headers });
      expect(response.statusCode, response.body).toBe(200);
      const data = response.json<ClubStatisticsResponse>();
      expect(data.coverage).toEqual({ completedGames: 5, unavailableGames: 1, pendingGames: 1 });
      expect(data.players.find(({ playerId }) => playerId === ids[0])).toMatchObject({
        totals: { games: 3 },
        rating: { ratedGames: 1, value: 1516 },
      });
      expect(response.body).not.toContain('"role":');
      expect(response.body).not.toContain('"participant":');
      const detail = await app.inject({ url: `/api/statistics/players/${ids[0]}`, headers });
      expect(detail.statusCode, detail.body).toBe(200);
      const history = detail.json<PlayerStatisticsResponse>().history;
      expect(history).toHaveLength(4);
      expect(history.map(({ unratedReason }) => unratedReason)).toEqual(
        expect.arrayContaining([null, "legacy-edition", "casper", "cancelled"]),
      );
      expect(history.some(({ name }) => name === "active")).toBe(false);
    }, 30_000);

    it.each([
      { kind: "truncated", incomplete: true },
      { kind: "legacy-truncated", incomplete: true },
      { kind: "duplicate-result-identity", incomplete: true },
      { kind: "duplicate-result-seat", incomplete: true },
      { kind: "different-result-identity", incomplete: true },
      { kind: "swapped-result-seats", incomplete: true },
      { kind: "duplicate-state-identity", incomplete: true },
      { kind: "casper", incomplete: false },
      { kind: "casper-human-results", incomplete: false },
      { kind: "legacy-without-roster", incomplete: false },
      { kind: "without-roster", incomplete: false },
    ] as const)(
      "discloses $kind final-roster coverage without changing accepted canonical data",
      async ({ kind, incomplete }) => {
        const { app, stores } = fixture;
        const clubId = await fixture.createClub();
        const headers = { "x-club-id": clubId };
        const ids: string[] = [];
        for (let i = 0; i < 12; i++) {
          const response = await app.inject({
            method: "POST",
            url: "/api/players",
            headers,
            payload: { nickname: `Coverage ${i}`, consent: false },
          });
          expect(response.statusCode, response.body).toBe(201);
          ids.push(response.json().player.id);
        }
        const casper = kind === "casper" || kind === "casper-human-results";
        const legacy = kind.startsWith("legacy-");
        const withoutRoster = kind.endsWith("without-roster");
        const template = statisticsGame(1);
        const participants = template.participants!.map((player, i) => ({
          ...player,
          playerId: casper && i === 9 ? "casper" : ids[i]!,
          ...(casper && i === 9 ? { role: "citizen", team: "red" } : {}),
        }));
        const roster = participants.map(({ playerId, ...player }) => ({ ...player, id: playerId }));
        if (kind === "duplicate-state-identity") roster[9] = { ...roster[9]!, id: ids[0]! };
        const finalPlayers =
          kind === "truncated" || kind === "legacy-truncated" || withoutRoster
            ? participants.slice(0, 9)
            : kind === "casper-human-results"
              ? participants.filter(({ playerId }) => playerId !== "casper")
              : participants.map((player, i) => ({
                  ...player,
                  ...(i === 9 && kind === "duplicate-result-identity"
                    ? { playerId: ids[0]! }
                    : i === 9 && kind === "duplicate-result-seat"
                      ? { seat: 1 }
                      : i === 9 && kind === "different-result-identity"
                        ? { playerId: ids[11]! }
                        : kind === "swapped-result-seats" && (i === 0 || i === 9)
                          ? { seat: i === 0 ? 10 : 1 }
                          : {}),
                }));
        const payload = {
          creationId: randomUUID(),
          name: kind,
          state: {
            hostPlayerId: ids[10],
            game: {
              ...(legacy ? {} : { rulesEdition: FEDERATION_RULES_EDITION }),
              ...(withoutRoster ? {} : { players: roster }),
            },
            opaque: { stateHash: "retained opaque canonical marker", events: [] },
          },
          results: {
            hostPlayerId: ids[10],
            outcome: "red",
            winner: "red",
            reason: null,
            playedAt: template.playedAt,
            players: finalPlayers,
          },
        };
        const created = await app.inject({
          method: "POST",
          url: "/api/game-sessions",
          headers,
          payload,
        });
        expect(created.statusCode, created.body).toBe(201);
        const gameId = created.json().gameId as string;
        const before = await stores.games.get(gameId, clubId);
        expect(before?.state).toEqual(payload.state);
        expect(before?.results).toEqual(payload.results);
        const response = await app.inject({ url: "/api/statistics", headers });
        expect(response.statusCode, response.body).toBe(200);
        const data = response.json<ClubStatisticsResponse>();
        expect(data.coverage).toEqual({
          completedGames: 1,
          unavailableGames: incomplete ? 1 : 0,
          pendingGames: 0,
        });
        const source = await stores.games.readStatisticsInputs(clubId);
        expect(source.games).toHaveLength(1);
        expect(source.games[0]).toMatchObject({
          gameId,
          hostPlayerId: ids[10],
          outcome: "red",
          hasCasper: casper,
          rulesEdition: legacy ? null : FEDERATION_RULES_EDITION,
          participants: incomplete
            ? null
            : finalPlayers.filter(({ playerId }) => playerId !== "casper"),
        });
        expect(data.players.find(({ playerId }) => playerId === ids[0])).toMatchObject({
          totals: { games: incomplete ? 0 : 1, winRate: incomplete ? null : 100 },
          rating: { ratedGames: 0, value: null },
        });
        expect(data.players.find(({ playerId }) => playerId === ids[9])).toMatchObject({
          totals: { games: 0, winRate: null },
        });
        const detail = await app.inject({ url: `/api/statistics/players/${ids[0]}`, headers });
        expect(detail.statusCode, detail.body).toBe(200);
        const playerData = detail.json<PlayerStatisticsResponse>();
        expect(playerData.total).toBe(incomplete ? 0 : 1);
        expect(playerData.history).toHaveLength(incomplete ? 0 : 1);
        const host = await app.inject({ url: `/api/statistics/players/${ids[10]}`, headers });
        expect(host.statusCode, host.body).toBe(200);
        const hostData = host.json<PlayerStatisticsResponse>();
        expect(hostData.player).toMatchObject({ totals: { games: 0 }, hostedGames: 1 });
        expect(hostData.history).toHaveLength(1);
        expect(hostData.history[0]).toMatchObject({
          gameId,
          isHost: true,
          participant: null,
          statisticsAvailable: !incomplete,
        });
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
