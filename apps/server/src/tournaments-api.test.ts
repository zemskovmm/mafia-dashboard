import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStatisticsApiFixture } from "./test-helpers/statistics-api-fixture.js";

for (const provider of ["postgres", "azure"] as const)
  describe(`${provider} tournament HTTP`, () => {
    let fixture: Awaited<ReturnType<typeof createStatisticsApiFixture>>;
    beforeAll(async () => {
      fixture = await createStatisticsApiFixture(provider);
    }, 30_000);
    afterAll(async () => {
      await fixture?.close();
    });
    it("creates club-local events idempotently and confirms attach/move/detach without rewriting game state", async () => {
      const { app, stores, member, owner } = fixture;
      const clubId = await fixture.createClub();
      const headers = { "x-club-id": clubId };
      const profile = await app.inject({
        method: "POST",
        url: "/api/players",
        headers,
        payload: {
          nickname: "Member",
          consent: true,
          clubAccess: "user",
          firstName: "Test",
          lastName: "Member",
          email: member.email,
        },
      });
      expect(profile.statusCode, profile.body).toBe(201);
      await stores.clubs.claimClubAccess(member.id, member.email);
      fixture.setActor(member);
      const created = await app.inject({
        method: "POST",
        url: "/api/tournaments",
        headers,
        payload: { name: "  Spring Open  " },
      });
      expect(created.statusCode, created.body).toBe(201);
      const tournament = created.json().tournament as { id: string; name: string };
      expect(tournament.name).toBe("Spring Open");
      const duplicate = await app.inject({
        method: "POST",
        url: "/api/tournaments",
        headers,
        payload: { name: "spring open" },
      });
      expect(duplicate.statusCode, duplicate.body).toBe(201);
      expect(duplicate.json().tournament).toEqual(tournament);
      const listed = await app.inject({ url: "/api/tournaments", headers });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().tournaments).toEqual([tournament]);
      const initial = {
        creationId: randomUUID(),
        name: "Unfinished",
        state: { setup: { selectedPlayerIds: [] }, marker: "same bytes" },
        results: null,
        tournamentId: tournament.id,
      };
      const game = await app.inject({
        method: "POST",
        url: "/api/game-sessions",
        headers,
        payload: initial,
      });
      expect(game.statusCode, game.body).toBe(201);
      const gameId = game.json().gameId as string;
      expect(game.json().tournamentId).toBe(tournament.id);
      for (const target of [null, tournament.id, tournament.id, null]) {
        const response = await app.inject({
          method: "PUT",
          url: `/api/game-sessions/${gameId}/tournament`,
          headers,
          payload: { tournamentId: target },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ tournamentId: target });
        const detail = await app.inject({ url: `/api/game-sessions/${gameId}`, headers });
        expect(detail.statusCode, detail.body).toBe(200);
        expect(detail.json().session).toMatchObject({
          tournamentId: target,
          revision: 1,
          state: initial.state,
          results: null,
        });
      }
      const retry = await app.inject({
        method: "POST",
        url: "/api/game-sessions",
        headers,
        payload: initial,
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({ gameId, tournamentId: null });
      const snapshot = await app.inject({
        method: "PUT",
        url: `/api/game-sessions/${gameId}`,
        headers,
        payload: {
          name: initial.name,
          mutationId: randomUUID(),
          state: initial.state,
          results: null,
        },
      });
      expect(snapshot.statusCode, snapshot.body).toBe(200);
      expect(snapshot.json().tournamentId).toBeNull();
      const noEvent = await app.inject({ url: "/api/statistics?tournamentId=none", headers });
      expect(noEvent.statusCode, noEvent.body).toBe(200);
      expect(noEvent.json().coverage).toMatchObject({ completedGames: 0, pendingGames: 1 });
      expect(noEvent.json().players).toEqual([]);
      expect(
        (await app.inject({ method: "DELETE", url: `/api/game-sessions/${gameId}`, headers }))
          .statusCode,
      ).toBe(204);
      const stale = await app.inject({
        method: "PUT",
        url: `/api/game-sessions/${gameId}/tournament`,
        headers,
        payload: { tournamentId: tournament.id },
      });
      expect(stale.statusCode, stale.body).toBe(404);
      expect((await app.inject({ url: "/api/tournaments", headers })).json().tournaments).toEqual([
        tournament,
      ]);
      fixture.setActor(owner);
    }, 30_000);

    it("denies unauthenticated/foreign writes and validates explicit nullable assignments and bounded names", async () => {
      const { app } = fixture;
      const clubId = await fixture.createClub();
      const other = await fixture.createClub();
      const headers = { "x-club-id": clubId };
      const otherHeaders = { "x-club-id": other };
      const foreign = await app.inject({
        method: "POST",
        url: "/api/tournaments",
        headers: otherHeaders,
        payload: { name: "Same club only" },
      });
      expect(foreign.statusCode, foreign.body).toBe(201);
      const game = await app.inject({
        method: "POST",
        url: "/api/game-sessions",
        headers,
        payload: { creationId: randomUUID(), name: "Setup", state: {}, results: null },
      });
      expect(game.statusCode, game.body).toBe(201);
      const url = `/api/game-sessions/${game.json().gameId}/tournament`;
      for (const name of ["", "   ", "a".repeat(101), null, 1])
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/tournaments",
              headers,
              payload: { name },
            })
          ).statusCode,
        ).toBe(400);
      for (const payload of [{}, { tournamentId: "bad" }, { tournamentId: null, other: true }])
        expect((await app.inject({ method: "PUT", url, headers, payload })).statusCode).toBe(400);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/game-sessions/bad/tournament",
            headers,
            payload: { tournamentId: null },
          })
        ).statusCode,
      ).toBe(400);
      const wrongTournament = await app.inject({
        method: "PUT",
        url,
        headers,
        payload: { tournamentId: foreign.json().tournament.id },
      });
      expect(wrongTournament.statusCode, wrongTournament.body).toBe(404);
      expect(
        (
          await app.inject({
            method: "PUT",
            url,
            headers: otherHeaders,
            payload: { tournamentId: foreign.json().tournament.id },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/game-sessions",
            headers,
            payload: {
              creationId: randomUUID(),
              name: "Foreign event",
              state: {},
              results: null,
              tournamentId: foreign.json().tournament.id,
            },
          })
        ).statusCode,
      ).toBe(404);
      const unchanged = await app.inject({
        url: `/api/game-sessions/${game.json().gameId}`,
        headers,
      });
      expect(unchanged.statusCode, unchanged.body).toBe(200);
      expect(unchanged.json().session.tournamentId).toBeNull();
      fixture.setActor(null);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/tournaments",
            headers,
            payload: { name: "Unauthorized" },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ method: "PUT", url, headers, payload: { tournamentId: null } }))
          .statusCode,
      ).toBe(401);
      fixture.setActor({ ...fixture.owner, id: randomUUID() });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/tournaments",
            headers,
            payload: { name: "Unauthorized" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: "PUT", url, headers, payload: { tournamentId: null } }))
          .statusCode,
      ).toBe(403);
      fixture.setActor(fixture.owner);
    }, 30_000);
  });
