import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";

import type { AppUser, GoogleAuthService } from "./google-auth.js";
import { initializeSchema } from "./initialize-schema.js";
import type { YouTubeOAuthService } from "./youtube-oauth.js";

const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test",
});
const authenticatedUser: AppUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@mafiamalaga.es",
  name: "Mafia Malaga owner",
  picture: null,
};
await initializeSchema(pool);
const app = await buildApp({
  pool,
  authenticateRequest: async () => authenticatedUser,
  defaultClubId: DEFAULT_CLUB_ID,
});

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("server API", () => {
  it.each([
    ["missing", {}],
    ["false", { ownerConsent: false }],
  ])("rejects club creation with %s Owner consent", async (_label, consent) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `No consent ${randomUUID().slice(0, 8)}`,
        city: "Nowhere",
        headerLogo: null,
        cardLogo: null,
        language: "en",
        ...consent,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_failed" });
  });

  it.each([undefined, "es"])("rejects unsupported club language %s", async (language) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `Invalid language ${randomUUID().slice(0, 8)}`,
        city: "Nowhere",
        headerLogo: null,
        cardLogo: null,
        ownerConsent: true,
        ...(language === undefined ? {} : { language }),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_failed" });
  });

  it("authenticates the owner, creates a club, and isolates its players", async () => {
    const auth = await app.inject({ method: "GET", url: "/api/auth/session" });
    expect(auth.json().user).toMatchObject(authenticatedUser);
    const authHeaders = {};

    const anonymousApp = await buildApp({
      pool,
      authenticateRequest: async () => null,
      defaultClubId: DEFAULT_CLUB_ID,
    });

    expect(
      await anonymousApp.inject({
        method: "POST",
        url: "/api/clubs",
        payload: {
          name: "Unauthorized",
          city: "Nowhere",
          headerLogo: null,
          cardLogo: null,
          language: "en",
          ownerConsent: true,
        },
      }),
    ).toHaveProperty("statusCode", 401);
    await anonymousApp.close();

    const initial = await app.inject({ method: "GET", url: "/api/clubs", headers: authHeaders });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().clubs).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Mafia Malaga", city: "Málaga" })]),
    );
    const defaultClubId = initial.json().clubs[0].id as string;

    const createdClub = await app.inject({
      method: "POST",
      url: "/api/clubs",
      headers: authHeaders,
      payload: {
        name: `Sevilla ${randomUUID().slice(0, 8)}`,
        city: "Sevilla",
        headerLogo: null,
        cardLogo: null,
        language: "ru",
        bestMoveEnabled: false,
        ownerConsent: true,
      },
    });
    expect(createdClub.statusCode).toBe(201);
    expect(createdClub.json().club.language).toBe("ru");
    expect(createdClub.json().club.bestMoveEnabled).toBe(false);
    const secondClubId = createdClub.json().club.id as string;

    const preservedSetting = await app.inject({
      method: "PUT",
      url: `/api/clubs/${secondClubId}`,
      headers: authHeaders,
      payload: {
        name: createdClub.json().club.name,
        city: "Sevilla",
        headerLogo: null,
        cardLogo: null,
        language: "ru",
      },
    });
    expect(preservedSetting.statusCode).toBe(200);
    expect(preservedSetting.json().club.bestMoveEnabled).toBe(false);

    const nickname = `Tenant-${randomUUID().slice(0, 8)}`;
    const createdPlayer = await app.inject({
      method: "POST",
      url: "/api/players",
      headers: { ...authHeaders, "x-club-id": secondClubId },
      payload: { nickname, consent: false, firstName: null, lastName: null, email: null },
    });
    expect(createdPlayer.statusCode).toBe(201);
    expect(
      await app.inject({
        method: "POST",
        url: "/api/players",
        headers: { ...authHeaders, "x-club-id": defaultClubId },
        payload: { nickname, consent: false, firstName: null, lastName: null, email: null },
      }),
    ).toHaveProperty("statusCode", 201);

    const secondPlayers = await app.inject({
      method: "GET",
      url: "/api/players",
      headers: { ...authHeaders, "x-club-id": secondClubId },
    });
    const firstPlayers = await app.inject({
      method: "GET",
      url: "/api/players",
      headers: { ...authHeaders, "x-club-id": defaultClubId },
    });
    expect(secondPlayers.json().players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nickname: "Owner",
          consent: true,
          email: authenticatedUser.email,
          clubAccess: "manager",
          managerLocked: true,
        }),
      ]),
    );
    expect(secondPlayers.json().players).toEqual(
      expect.arrayContaining([expect.objectContaining({ nickname })]),
    );
    expect(secondPlayers.json().players.map((player: { id: string }) => player.id)).toContain(
      createdPlayer.json().player.id,
    );
    expect(firstPlayers.json().players).toEqual(
      expect.arrayContaining([expect.objectContaining({ nickname })]),
    );
    expect(
      firstPlayers
        .json()
        .players.find((player: { nickname: string }) => player.nickname === nickname).id,
    ).not.toBe(createdPlayer.json().player.id);
    expect(firstPlayers.json().players.map((player: { id: string }) => player.id)).not.toContain(
      createdPlayer.json().player.id,
    );

    const gameId = randomUUID();
    const savedGame = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      headers: { ...authHeaders, "x-club-id": secondClubId },
      payload: {
        name: "Tenant table",
        mutationId: randomUUID(),
        baseRevision: 0,
        state: {
          setup: null,
          game: null,
          hostPlayerId: null,
          hostName: null,
          playlistId: "",
          log: [],
          undoHistory: [],
        },
        results: null,
      },
    });
    expect(savedGame.statusCode).toBe(201);
    expect(
      await app.inject({
        method: "GET",
        url: `/api/game-sessions/${gameId}`,
        headers: { ...authHeaders, "x-club-id": defaultClubId },
      }),
    ).toHaveProperty("statusCode", 404);
    expect(
      await app.inject({
        method: "GET",
        url: `/api/game-sessions/${gameId}`,
        headers: { ...authHeaders, "x-club-id": secondClubId },
      }),
    ).toHaveProperty("statusCode", 200);

    const deletedClub = await app.inject({
      method: "DELETE",
      url: `/api/clubs/${secondClubId}`,
      headers: authHeaders,
    });
    expect(deletedClub.statusCode).toBe(204);
    const afterDelete = await app.inject({
      method: "GET",
      url: "/api/clubs",
      headers: authHeaders,
    });
    expect(afterDelete.json().clubs.map((club: { id: string }) => club.id)).not.toContain(
      secondClubId,
    );
    expect(
      await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM players WHERE club_id = $1)::int AS players,
           (SELECT COUNT(*) FROM game_sessions WHERE club_id = $1)::int AS sessions,
           (SELECT COUNT(*) FROM game_events WHERE club_id = $1)::int AS events`,
        [secondClubId],
      ),
    ).toMatchObject({ rows: [{ players: 0, sessions: 0, events: 0 }] });
  });

  it("lets regular users run games while server-blocking manager-only mutations", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `User authorization ${randomUUID().slice(0, 8)}`,
        city: "Málaga",
        headerLogo: null,
        cardLogo: null,
        language: "en",
        ownerConsent: true,
      },
    });
    const club = created.json().club as { id: string; name: string; city: string };
    const regularUser: AppUser = {
      id: randomUUID(),
      email: `regular-user-${randomUUID()}@example.test`,
      name: "Regular User",
      picture: null,
    };
    await pool.query(
      "INSERT INTO users (id, email, display_name, picture) VALUES ($1, $2, $3, $4)",
      [regularUser.id, regularUser.email, regularUser.name, regularUser.picture],
    );
    await pool.query(
      "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'user')",
      [club.id, regularUser.id],
    );
    const userApp = await buildApp({
      pool,
      authenticateRequest: async () => regularUser,
      defaultClubId: DEFAULT_CLUB_ID,
    });
    const outsiderApp = await buildApp({
      pool,
      authenticateRequest: async () => ({
        id: randomUUID(),
        email: "outsider@example.test",
        name: "Outsider",
        picture: null,
      }),
      defaultClubId: DEFAULT_CLUB_ID,
    });
    await userApp.ready();
    await outsiderApp.ready();
    const payload = {
      name: club.name,
      city: club.city,
      headerLogo: null,
      cardLogo: null,
      language: "ru",
    };

    const headers = { "x-club-id": club.id };
    const updated = await userApp.inject({
      method: "PUT",
      url: `/api/clubs/${club.id}`,
      payload,
    });
    expect(updated.statusCode).toBe(403);
    expect(updated.json()).toEqual({ error: "club_manager_required" });
    await expect(
      userApp.inject({ method: "GET", url: "/api/players", headers }),
    ).resolves.toHaveProperty("statusCode", 200);
    await expect(
      userApp.inject({
        method: "POST",
        url: "/api/players",
        headers,
        payload: {
          nickname: `Denied ${randomUUID().slice(0, 8)}`,
          consent: false,
          clubAccess: "none",
          firstName: null,
          lastName: null,
          email: null,
        },
      }),
    ).resolves.toHaveProperty("statusCode", 403);
    const createdGame = await userApp.inject({
      method: "POST",
      url: "/api/games",
      headers,
      payload: { name: "Regular user game" },
    });
    expect(createdGame.statusCode).toBe(201);
    const gameId = createdGame.json().gameId as string;
    const userEvents = await userApp.inject({
      method: "GET",
      url: `/api/games/${gameId}/events?visibility=host`,
      headers,
    });
    const managerEvents = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/events?visibility=host`,
      headers,
    });
    expect(userEvents.statusCode).toBe(200);
    expect(userEvents.json()).toEqual(managerEvents.json());
    const sessionGameId = randomUUID();
    await expect(
      userApp.inject({
        method: "PUT",
        url: `/api/game-sessions/${sessionGameId}`,
        headers,
        payload: {
          name: "Regular user session",
          mutationId: randomUUID(),
          baseRevision: 0,
          state: {
            setup: null,
            game: null,
            hostPlayerId: null,
            hostName: null,
            playlistId: "",
            log: [],
            undoHistory: [],
          },
          results: null,
        },
      }),
    ).resolves.toHaveProperty("statusCode", 201);
    const userSession = await userApp.inject({
      method: "GET",
      url: `/api/game-sessions/${sessionGameId}`,
      headers,
    });
    const managerSession = await app.inject({
      method: "GET",
      url: `/api/game-sessions/${sessionGameId}`,
      headers,
    });
    expect(userSession.statusCode).toBe(200);
    expect(userSession.json()).toEqual(managerSession.json());
    await expect(
      outsiderApp.inject({
        method: "GET",
        url: `/api/game-sessions/${sessionGameId}`,
        headers,
      }),
    ).resolves.toHaveProperty("statusCode", 403);
    await expect(
      userApp.inject({ method: "DELETE", url: `/api/clubs/${club.id}` }),
    ).resolves.toHaveProperty("statusCode", 403);
    await expect(
      outsiderApp.inject({ method: "PUT", url: `/api/clubs/${club.id}`, payload }),
    ).resolves.toHaveProperty("statusCode", 403);

    await userApp.close();
    await outsiderApp.close();
    await expect(
      app.inject({ method: "DELETE", url: `/api/clubs/${club.id}` }),
    ).resolves.toHaveProperty("statusCode", 204);
  });

  it("redirects browser pages from a direct host to the configured secure app origin", async () => {
    const secureApp = await buildApp({
      pool,
      publicAppUrl: "https://mbp16.tail102fab.ts.net",
    });
    await secureApp.ready();

    const response = await secureApp.inject({
      method: "GET",
      url: "/?music=connected",
      headers: {
        accept: "text/html",
        host: "100.95.109.89:8080",
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://mbp16.tail102fab.ts.net/?music=connected");
    await secureApp.close();
  });

  it("reports liveness and database readiness separately", async () => {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "live" });
    expect(live.headers["permissions-policy"]).toBe("picture-in-picture=()");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
  });

  it("creates a game with the first append-only event", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/games",
      payload: { name: "Friday table" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.gameId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.event).toMatchObject({
      gameId: body.gameId,
      sequence: 1,
      type: "game.created",
      phase: "setup-players",
      payload: { name: "Friday table" },
    });
  });

  it("appends validated events and returns the ordered host log", async () => {
    const gameId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events`,
      payload: {
        idempotencyKey: "turn-1",
        type: "turn.started",
        phase: "day",
        seat: 3,
        payload: { seat: 3, seconds: 60 },
      },
    });
    expect(response.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events`,
      payload: {
        idempotencyKey: "turn-1",
        type: "turn.started",
        phase: "day",
        seat: 3,
        payload: { seat: 3, seconds: 60 },
      },
    });
    expect(duplicate.statusCode).toBe(200);

    const log = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    expect(log.statusCode).toBe(200);
    expect(log.json().events).toHaveLength(1);
    expect(log.json().events[0]).toMatchObject({ sequence: 1, type: "turn.started" });
  });

  it("truncates an undone event tail without deleting game.created", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/games",
      payload: { name: "Undo table" },
    });
    const gameId = created.json().gameId as string;
    await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events`,
      payload: {
        idempotencyKey: "undo-target",
        type: "turn.completed",
        phase: "day",
        payload: { day: 2 },
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events`,
      payload: {
        idempotencyKey: "later-event",
        type: "foul.issued",
        phase: "day",
        payload: { seat: 1 },
      },
    });

    const truncated = await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events/truncate`,
      payload: { fromIdempotencyKey: "undo-target" },
    });

    expect(truncated.statusCode).toBe(204);
    const log = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    expect(log.json().events).toMatchObject([
      { sequence: 1, idempotencyKey: "game-created", type: "game.created" },
    ]);
  });

  it("rejects invalid events without appending anything", async () => {
    const gameId = randomUUID();
    const invalid = await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events`,
      payload: {
        idempotencyKey: "invalid-seat",
        type: "foul.issued",
        phase: "day",
        seat: 11,
        payload: {},
      },
    });

    expect(invalid.statusCode).toBe(400);
    const log = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    expect(log.json().events).toEqual([]);
  });

  it("redacts private event payloads and integrity hashes from public log requests", async () => {
    const gameId = randomUUID();
    await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events`,
      payload: {
        idempotencyKey: "check-1",
        type: "sheriff.checked",
        phase: "night-sheriff",
        seat: 5,
        payload: { targetSeat: 8, match: true },
      },
    });
    const stateHashAfter = `sha256:${"a".repeat(64)}`;
    await pool.query("UPDATE game_events SET state_hash_after = $2 WHERE game_id = $1", [
      gameId,
      stateHashAfter,
    ]);

    const host = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    const publicLog = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/events?visibility=public`,
    });

    expect(host.json().events[0]).toMatchObject({
      payload: { targetSeat: 8, match: true },
      stateHashAfter,
    });
    expect(publicLog.json().events[0]).toMatchObject({
      payload: { redacted: true },
      stateHashAfter: null,
    });
  });

  it("creates consent-safe player profiles and rejects duplicate nicknames", async () => {
    const nickname = `Profile-${randomUUID().slice(0, 8)}`;
    const invalidManagerWithoutConsent = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: `Manager-${randomUUID().slice(0, 8)}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
        clubAccess: "manager",
      },
    });
    expect(invalidManagerWithoutConsent.statusCode).toBe(400);
    expect(invalidManagerWithoutConsent.json()).toMatchObject({ error: "validation_failed" });

    const invalidWithoutConsent = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname,
        consent: false,
        firstName: "Must not be stored",
        lastName: null,
        email: null,
      },
    });
    expect(invalidWithoutConsent.statusCode).toBe(400);

    const created = await app.inject({
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
    expect(created.statusCode).toBe(201);
    expect(created.json().player).toMatchObject({
      nickname,
      consent: false,
      clubAccess: "none",
      managerLocked: false,
      firstName: null,
      lastName: null,
      email: null,
      statistics: { gamesPlayed: 0, wins: 0, losses: 0 },
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: nickname.toUpperCase(),
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "nickname_conflict" });

    const listed = await app.inject({ method: "GET", url: "/api/players" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().players).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.json().player.id, nickname })]),
    );
  });

  it("creates and updates a manager while returning manager fields", async () => {
    const manager = {
      id: randomUUID(),
      email: `api-manager-${randomUUID()}@example.test`,
      name: "API Manager",
    };
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [
      manager.id,
      manager.email,
      manager.name,
    ]);
    const created = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: `API manager ${randomUUID().slice(0, 8)}`,
        consent: true,
        firstName: "API",
        lastName: "Manager",
        email: manager.email.toUpperCase(),
        clubAccess: "manager",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().player).toMatchObject({ clubAccess: "manager", managerLocked: false });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/players/${created.json().player.id}`,
      payload: {
        nickname: `${created.json().player.nickname}-updated`,
        consent: true,
        firstName: "API",
        lastName: "Manager",
        email: manager.email,
        clubAccess: "manager",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().player).toMatchObject({ clubAccess: "manager", managerLocked: false });
  });

  it("returns club_access_consent_required when an unlinked player is promoted without consent", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: `Unlinked manager ${randomUUID().slice(0, 8)}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({
      method: "PUT",
      url: `/api/players/${created.json().player.id}`,
      payload: {
        nickname: created.json().player.nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
        clubAccess: "manager",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "club_access_consent_required" });
  });

  it("returns club_access_email_conflict separately from nickname conflicts", async () => {
    const email = `pending-conflict-${randomUUID()}@example.test`;
    const profile = {
      consent: true,
      firstName: "Pending",
      lastName: "Manager",
      email,
      clubAccess: "manager",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: { ...profile, nickname: `Pending manager ${randomUUID().slice(0, 8)}` },
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: { ...profile, nickname: `Other manager ${randomUUID().slice(0, 8)}` },
    });

    expect(first.statusCode).toBe(201);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "club_access_email_conflict" });

    const updateTarget = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        ...profile,
        email: `other-pending-${randomUUID()}@example.test`,
        nickname: `Update target ${randomUUID().slice(0, 8)}`,
      },
    });
    const updateConflict = await app.inject({
      method: "PUT",
      url: `/api/players/${updateTarget.json().player.id}`,
      payload: { ...profile, nickname: updateTarget.json().player.nickname },
    });
    expect(updateConflict.statusCode).toBe(409);
    expect(updateConflict.json()).toEqual({ error: "club_access_email_conflict" });

    const linkedUserId = randomUUID();
    const previousEmail = `linked-manager-${randomUUID()}@example.test`;
    const currentEmail = `renamed-manager-${randomUUID()}@example.test`;
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Renamed Manager')",
      [linkedUserId, previousEmail],
    );
    const linkedManager = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        ...profile,
        nickname: `Linked manager ${randomUUID().slice(0, 8)}`,
        email: previousEmail,
      },
    });
    expect(linkedManager.statusCode).toBe(201);
    await pool.query("UPDATE users SET email = $1 WHERE id = $2", [currentEmail, linkedUserId]);

    const linkedUserConflict = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        ...profile,
        nickname: `Relinked manager ${randomUUID().slice(0, 8)}`,
        email: currentEmail,
      },
    });
    expect(linkedUserConflict.statusCode).toBe(409);
    expect(linkedUserConflict.json()).toEqual({ error: "club_access_email_conflict" });
  });

  it("allows the linked creator to withdraw Owner profile consent", async () => {
    const createdClub = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `Withdraw consent ${randomUUID().slice(0, 8)}`,
        city: "Granada",
        headerLogo: null,
        cardLogo: null,
        language: "en",
        ownerConsent: true,
      },
    });
    expect(createdClub.statusCode).toBe(201);
    const clubId = createdClub.json().club.id as string;
    const listed = await app.inject({
      method: "GET",
      url: "/api/players",
      headers: { "x-club-id": clubId },
    });
    const owner = listed
      .json()
      .players.find((player: { managerLocked: boolean }) => player.managerLocked);
    expect(owner).toBeDefined();

    const response = await app.inject({
      method: "PUT",
      url: `/api/players/${owner.id}`,
      headers: { "x-club-id": clubId },
      payload: {
        nickname: owner.nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
        clubAccess: "manager",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().player).toMatchObject({
      consent: false,
      consentAt: null,
      firstName: null,
      lastName: null,
      email: null,
      clubAccess: "manager",
      managerLocked: true,
    });
    await expect(
      app.inject({ method: "DELETE", url: `/api/clubs/${clubId}` }),
    ).resolves.toHaveProperty("statusCode", 204);
  });

  it("returns 403 when an editor tries to restore locked Owner consent and PII", async () => {
    const createdClub = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `Owner authorization ${randomUUID().slice(0, 8)}`,
        city: "Granada",
        headerLogo: null,
        cardLogo: null,
        language: "en",
        ownerConsent: true,
      },
    });
    const clubId = createdClub.json().club.id as string;
    const owner = (
      await app.inject({
        method: "GET",
        url: "/api/players",
        headers: { "x-club-id": clubId },
      })
    )
      .json()
      .players.find((player: { managerLocked: boolean }) => player.managerLocked);
    await pool.query(
      `UPDATE players
          SET first_name = NULL,
              last_name = NULL,
              email = NULL,
              data_processing_consent = FALSE,
              consent_at = NULL
        WHERE id = $1 AND club_id = $2`,
      [owner.id, clubId],
    );
    const withdrawn = (
      await app.inject({
        method: "GET",
        url: "/api/players",
        headers: { "x-club-id": clubId },
      })
    )
      .json()
      .players.find((player: { id: string }) => player.id === owner.id);

    const editor: AppUser = {
      id: randomUUID(),
      email: `owner-editor-${randomUUID()}@example.test`,
      name: "Owner Editor",
      picture: null,
    };
    await pool.query(
      "INSERT INTO users (id, email, display_name, picture) VALUES ($1, $2, $3, $4)",
      [editor.id, editor.email, editor.name, editor.picture],
    );
    await pool.query(
      "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'manager')",
      [clubId, editor.id],
    );
    const editorApp = await buildApp({
      pool,
      authenticateRequest: async () => editor,
      defaultClubId: DEFAULT_CLUB_ID,
    });

    try {
      const response = await editorApp.inject({
        method: "PUT",
        url: `/api/players/${owner.id}`,
        headers: { "x-club-id": clubId },
        payload: {
          nickname: `Editor rewrite ${randomUUID().slice(0, 8)}`,
          consent: true,
          firstName: "Editor",
          lastName: "Rewrite",
          email: editor.email,
          clubAccess: "manager",
        },
      });
      const afterAttempt = (
        await editorApp.inject({
          method: "GET",
          url: "/api/players",
          headers: { "x-club-id": clubId },
        })
      )
        .json()
        .players.find((player: { id: string }) => player.id === owner.id);
      const normalPlayer = await editorApp.inject({
        method: "POST",
        url: "/api/players",
        headers: { "x-club-id": clubId },
        payload: {
          nickname: `Editor normal ${randomUUID().slice(0, 8)}`,
          consent: false,
          firstName: null,
          lastName: null,
          email: null,
          clubAccess: "none",
        },
      });
      const normalNickname = `${normalPlayer.json().player.nickname}-updated`;
      const normalUpdate = await editorApp.inject({
        method: "PUT",
        url: `/api/players/${normalPlayer.json().player.id}`,
        headers: { "x-club-id": clubId },
        payload: {
          nickname: normalNickname,
          consent: false,
          firstName: null,
          lastName: null,
          email: null,
          clubAccess: "none",
        },
      });

      expect([
        response.statusCode,
        response.json(),
        afterAttempt,
        normalUpdate.statusCode,
        normalUpdate.json().player.nickname,
      ]).toEqual([403, { error: "owner_profile_forbidden" }, withdrawn, 200, normalNickname]);
    } finally {
      await editorApp.close();
      await app.inject({ method: "DELETE", url: `/api/clubs/${clubId}` });
    }
  });

  it("returns manager_locked for creator demotion and deletion", async () => {
    const listed = await app.inject({ method: "GET", url: "/api/players" });
    const owner = listed
      .json()
      .players.find((player: { managerLocked: boolean }) => player.managerLocked);
    expect(owner).toBeDefined();

    const demotion = await app.inject({
      method: "PUT",
      url: `/api/players/${owner.id}`,
      payload: {
        nickname: owner.nickname,
        consent: owner.consent,
        firstName: owner.firstName,
        lastName: owner.lastName,
        email: owner.email,
        clubAccess: "none",
      },
    });
    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/players/${owner.id}`,
    });

    expect(demotion.statusCode).toBe(409);
    expect(demotion.json()).toEqual({ error: "manager_locked" });
    expect(deletion.statusCode).toBe(409);
    expect(deletion.json()).toEqual({ error: "manager_locked" });
    await expect(
      app.inject({ method: "DELETE", url: "/api/players/not-a-uuid" }),
    ).resolves.toHaveProperty("statusCode", 400);
  });

  it("requires all personal fields with consent and updates a player", async () => {
    const nickname = `Consented-${randomUUID().slice(0, 8)}`;
    const missingEmail = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname,
        consent: true,
        firstName: "Ada",
        lastName: "Player",
        email: null,
      },
    });
    expect(missingEmail.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname,
        consent: true,
        firstName: "Ada",
        lastName: "Player",
        email: "ada@example.test",
      },
    });
    expect(created.statusCode).toBe(201);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/players/${created.json().player.id}`,
      payload: {
        nickname: `${nickname}-updated`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().player).toMatchObject({
      nickname: `${nickname}-updated`,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
  });

  it("deletes an unused player and reports a missing player", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: `Delete-${randomUUID().slice(0, 8)}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    const playerId = created.json().player.id as string;

    const deleted = await app.inject({ method: "DELETE", url: `/api/players/${playerId}` });
    const missing = await app.inject({ method: "DELETE", url: `/api/players/${playerId}` });

    expect(deleted.statusCode).toBe(204);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "player_not_found" });
  });

  it("returns active_game and preserves unfinalized persisted players on direct player deletion", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: `Active-${randomUUID().slice(0, 8)}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    const playerId = created.json().player.id as string;
    const host = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: `Active-host-${randomUUID().slice(0, 8)}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    const hostPlayerId = host.json().player.id as string;
    const gameId = randomUUID();
    const setup = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: {
        name: "Protected active table",
        mutationId: randomUUID(),
        baseRevision: 0,
        state: {
          setup: {
            step: "players",
            hostPlayerId,
            selectedPlayerIds: [playerId, ...Array.from({ length: 9 }, () => "")],
            setup: null,
          },
          game: null,
          hostPlayerId,
          hostName: host.json().player.nickname,
          playlistId: "",
          log: [],
          undoHistory: [],
        },
        results: null,
      },
    });
    expect(setup.statusCode).toBe(201);

    const deletion = await app.inject({ method: "DELETE", url: `/api/players/${playerId}` });

    expect(deletion.statusCode).toBe(409);
    expect(deletion.json()).toEqual({ error: "active_game" });
    const players = await app.inject({ method: "GET", url: "/api/players" });
    expect(players.json().players).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: playerId })]),
    );
    const events = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    expect(events.json().events).toHaveLength(1);

    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/game-sessions/${gameId}?expectedRevision=1`,
    });
    expect(cleared.statusCode).toBe(204);
    const deletedAfterClear = await app.inject({
      method: "DELETE",
      url: `/api/players/${playerId}`,
    });
    expect(deletedAfterClear.statusCode).toBe(204);
    const clearedEvents = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    expect(clearedEvents.json().events).toEqual([]);
  });

  it("saves one host and ten finalized player results with aggregate statistics", async () => {
    const players: Array<{ id: string; nickname: string }> = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/players",
        payload: {
          nickname: `Result-${index}-${randomUUID().slice(0, 8)}`,
          consent: false,
          firstName: null,
          lastName: null,
          email: null,
        },
      });
      expect(response.statusCode).toBe(201);
      players.push(response.json().player as { id: string; nickname: string });
    }
    const host = players[10]!;
    const participants = players.slice(0, 10);

    const gameId = randomUUID();
    const payload = {
      hostPlayerId: host.id,
      winner: "red",
      playedAt: "2026-08-17T22:00:00.000Z",
      players: participants.map((player, index) => ({
        playerId: player.id,
        seat: index + 1,
        role: index === 0 ? "sheriff" : index < 7 ? "citizen" : index === 9 ? "don" : "mafia",
        team: index < 7 ? "red" : "black",
        status: index === 7 ? "eliminated" : "active",
        fouls: index === 0 ? 2 : 0,
      })),
    };
    const missingHost = await app.inject({
      method: "PUT",
      url: `/api/games/${randomUUID()}/results`,
      payload: { ...payload, hostPlayerId: null },
    });
    expect(missingHost.statusCode).toBe(400);
    const invalidHost = await app.inject({
      method: "PUT",
      url: `/api/games/${gameId}/results`,
      payload: { ...payload, hostPlayerId: participants[0]!.id },
    });
    expect(invalidHost.statusCode).toBe(400);
    const saved = await app.inject({
      method: "PUT",
      url: `/api/games/${gameId}/results`,
      payload,
    });
    const duplicate = await app.inject({
      method: "PUT",
      url: `/api/games/${gameId}/results`,
      payload,
    });
    expect(saved.statusCode).toBe(204);
    expect(duplicate.statusCode).toBe(204);

    const listed = await app.inject({ method: "GET", url: "/api/players" });
    const sheriff = listed
      .json()
      .players.find((player: { id: string }) => player.id === participants[0]!.id);
    expect(sheriff.statistics).toMatchObject({
      gamesPlayed: 1,
      wins: 1,
      losses: 0,
      sheriffGames: 1,
      totalFouls: 2,
    });
    const savedHost = listed.json().players.find((player: { id: string }) => player.id === host.id);
    expect(savedHost.statistics).toMatchObject({ hostedGames: 1, gamesPlayed: 0 });

    const deletedWithHistory = await app.inject({
      method: "DELETE",
      url: `/api/players/${participants[1]!.id}`,
    });
    expect(deletedWithHistory.statusCode).toBe(204);

    const retracted = await app.inject({
      method: "DELETE",
      url: `/api/games/${gameId}/results`,
    });
    const duplicateRetraction = await app.inject({
      method: "DELETE",
      url: `/api/games/${gameId}/results`,
    });
    expect(retracted.statusCode).toBe(410);
    expect(retracted.json()).toEqual({ error: "game_deleted" });
    expect(duplicateRetraction.statusCode).toBe(410);
    expect(duplicateRetraction.json()).toEqual({ error: "game_deleted" });

    const afterRetraction = await app.inject({ method: "GET", url: "/api/players" });
    const retractedHost = afterRetraction
      .json()
      .players.find((player: { id: string }) => player.id === host.id);
    const retractedSheriff = afterRetraction
      .json()
      .players.find((player: { id: string }) => player.id === participants[0]!.id);
    const deletedParticipant = afterRetraction
      .json()
      .players.find((player: { id: string }) => player.id === participants[1]!.id);
    expect(retractedHost).toMatchObject({
      lastPlayedAt: null,
      statistics: { hostedGames: 0, gamesPlayed: 0 },
    });
    expect(retractedSheriff).toMatchObject({
      lastPlayedAt: null,
      statistics: { gamesPlayed: 0, wins: 0, sheriffGames: 0 },
    });
    expect(deletedParticipant).toBeUndefined();
  });

  it("validates OAuth state before exchanging the Google authorization code", async () => {
    const oauth = {
      createAuthorizationUrl: vi.fn(
        (state: string) => `https://accounts.google.test/authorize?state=${state}`,
      ),
      exchangeCode: vi.fn().mockResolvedValue(undefined),
    } as unknown as YouTubeOAuthService;
    let oauthUser = authenticatedUser;
    const oauthApp = await buildApp({
      pool,
      youtubeOAuth: oauth,
      authenticateRequest: async () => oauthUser,
    });
    await oauthApp.ready();

    const started = await oauthApp.inject({ method: "GET", url: "/api/music/oauth/start" });
    expect(started.statusCode).toBe(302);
    const location = new URL(started.headers.location!);
    const cookie = String(started.headers["set-cookie"]).split(";", 1)[0]!;
    expect(location.searchParams.get("state")).toHaveLength(43);
    expect(started.headers["set-cookie"]).toContain("HttpOnly");
    expect(started.headers["set-cookie"]).toContain("Secure");
    expect(started.headers["set-cookie"]).toContain("SameSite=Lax");

    const invalid = await oauthApp.inject({
      method: "GET",
      url: "/api/music/oauth/callback?code=authorization-code&state=wrong-state",
      headers: { cookie },
    });
    expect(invalid.statusCode).toBe(400);
    expect(oauth.exchangeCode).not.toHaveBeenCalled();

    oauthUser = { ...authenticatedUser, id: randomUUID() };
    const changedUser = await oauthApp.inject({
      method: "GET",
      url: `/api/music/oauth/callback?code=authorization-code&state=${location.searchParams.get("state")}`,
      headers: { cookie },
    });
    expect(changedUser.statusCode).toBe(400);
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
    oauthUser = authenticatedUser;

    const callback = await oauthApp.inject({
      method: "GET",
      url: `/api/music/oauth/callback?code=authorization-code&state=${location.searchParams.get("state")}`,
      headers: { cookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/?music=connected");
    expect(callback.headers["set-cookie"]).toContain("Max-Age=0");
    expect(oauth.exchangeCode).toHaveBeenCalledWith(authenticatedUser.id, "authorization-code");

    await oauthApp.close();
  });

  it("claims approved regular-user access before completing Google sign-in", async () => {
    const invitee: AppUser = {
      id: randomUUID(),
      email: `google-invitee-${randomUUID()}@example.test`,
      name: "Google Invitee",
      picture: null,
    };
    const createdClub = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `Google invite ${randomUUID().slice(0, 8)}`,
        city: "Granada",
        headerLogo: null,
        cardLogo: null,
        language: "en",
        ownerConsent: true,
      },
    });
    const invitedClubId = createdClub.json().club.id as string;
    const invitation = await app.inject({
      method: "POST",
      url: "/api/players",
      headers: { "x-club-id": invitedClubId },
      payload: {
        nickname: `Invitee ${randomUUID().slice(0, 8)}`,
        consent: true,
        firstName: "Google",
        lastName: "Invitee",
        email: invitee.email.toUpperCase(),
        clubAccess: "user",
      },
    });
    expect(invitation.statusCode).toBe(201);
    await pool.query(
      "INSERT INTO users (id, email, display_name, picture) VALUES ($1, $2, $3, $4)",
      [invitee.id, invitee.email, invitee.name, invitee.picture],
    );

    const googleAuth = {
      createAuthorizationUrl: vi.fn(
        (state: string) => `https://accounts.google.test/authorize?state=${state}`,
      ),
      completeAuthorization: vi.fn(async () => ({
        user: invitee,
        sessionToken: "application-session-token",
        expiresAt: new Date(Date.now() + 60_000),
      })),
      getUserForSession: vi.fn(async (token: string | null) =>
        token === "application-session-token" ? invitee : null,
      ),
      endSession: vi.fn(async () => undefined),
    } as unknown as GoogleAuthService;
    const authApp = await buildApp({
      pool,
      googleAuth,
      publicAppUrl: "https://mafia.example.test",
      authRateLimit: { limit: 2, windowMs: 10_000 },
    });
    await authApp.ready();

    const started = await authApp.inject({ method: "GET", url: "/api/auth/google/start" });
    const location = new URL(started.headers.location!);
    const state = location.searchParams.get("state")!;
    const stateCookie = String(started.headers["set-cookie"]).split(";", 1)[0]!;
    expect(started.statusCode).toBe(302);
    expect(state).toHaveLength(43);
    expect(started.headers["set-cookie"]).toContain("HttpOnly");
    expect(started.headers["set-cookie"]).toContain("Secure");

    const callback = await authApp.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=google-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: stateCookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/");
    expect(String(callback.headers["set-cookie"])).toContain(
      "mafia_session=application-session-token",
    );
    expect(googleAuth.completeAuthorization).toHaveBeenCalledWith("google-code");
    const throttled = await authApp.inject({ method: "GET", url: "/api/auth/google/start" });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toEqual({ error: "auth_rate_limited" });

    const session = await authApp.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: "mafia_session=application-session-token" },
    });
    expect(session.json()).toEqual({ configured: true, user: invitee });

    const clubs = await authApp.inject({
      method: "GET",
      url: "/api/clubs",
      headers: { cookie: "mafia_session=application-session-token" },
    });
    expect(clubs.statusCode).toBe(200);
    expect(clubs.json().clubs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: invitedClubId, role: "user" })]),
    );

    const signedOut = await authApp.inject({
      method: "DELETE",
      url: "/api/auth/session",
      headers: {
        cookie: "mafia_session=application-session-token",
        origin: "https://mafia.example.test",
      },
    });
    expect(signedOut.statusCode).toBe(204);
    expect(googleAuth.endSession).toHaveBeenCalledWith("application-session-token");
    await authApp.close();
  });

  it("reports that account playlists are unavailable when OAuth is not configured", async () => {
    const status = await app.inject({ method: "GET", url: "/api/music/oauth/status" });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      configured: false,
      connected: false,
      accountLabel: null,
    });
  });

  it("returns connected account playlists and disconnects the account", async () => {
    const playlists = [
      {
        id: "PL-music",
        title: "Mafia music",
        itemCount: 20,
        thumbnailUrl: "https://i.ytimg.com/music.jpg",
      },
    ];
    const playlistItems = [
      { videoId: "video-1", title: "Opening", position: 0, thumbnailUrl: null },
    ];
    const oauth = {
      getStatus: vi.fn().mockResolvedValue({
        configured: true,
        connected: true,
        accountLabel: "Mafia Host",
      }),
      listPlaylists: vi.fn().mockResolvedValue(playlists),
      listPlaylistItems: vi.fn().mockResolvedValue(playlistItems),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as YouTubeOAuthService;
    const oauthApp = await buildApp({
      pool,
      youtubeOAuth: oauth,
      authenticateRequest: async () => authenticatedUser,
    });
    await oauthApp.ready();

    const status = await oauthApp.inject({ method: "GET", url: "/api/music/oauth/status" });
    const listed = await oauthApp.inject({ method: "GET", url: "/api/music/playlists" });
    const items = await oauthApp.inject({
      method: "GET",
      url: "/api/music/playlists/PL-music/items",
    });
    const disconnected = await oauthApp.inject({
      method: "DELETE",
      url: "/api/music/oauth/connection",
    });

    expect(status.json()).toEqual({
      configured: true,
      connected: true,
      accountLabel: "Mafia Host",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ playlists });
    expect(items.statusCode).toBe(200);
    expect(items.json()).toEqual({ items: playlistItems });
    expect(oauth.listPlaylistItems).toHaveBeenCalledWith(authenticatedUser.id, "PL-music");
    expect(disconnected.statusCode).toBe(204);
    expect(oauth.disconnect).toHaveBeenCalledWith(authenticatedUser.id);

    await oauthApp.close();
  });

  it("saves, lists, and restores a client-id game session aggregate", async () => {
    const gameId = randomUUID();
    const mutationId = randomUUID();
    const state = {
      setup: {
        step: "players",
        hostPlayerId: "",
        selectedPlayerIds: Array.from({ length: 10 }, () => ""),
        setup: null,
      },
      game: null,
      hostPlayerId: null,
      hostName: null,
      playlistId: "PL-restorable",
      log: [],
      undoHistory: [],
    };

    const saved = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: { name: "Restorable table", mutationId, baseRevision: 0, state, results: null },
    });
    const retried = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: { name: "Restorable table", mutationId, baseRevision: 0, state, results: null },
    });
    const listed = await app.inject({ method: "GET", url: "/api/game-sessions" });
    const restored = await app.inject({ method: "GET", url: `/api/game-sessions/${gameId}` });

    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ gameId, revision: 1, duplicate: false });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ ...saved.json(), duplicate: true });
    expect(listed.json().sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ gameId, name: "Restorable table" })]),
    );
    expect(restored.statusCode).toBe(200);
    expect(restored.json().session).toMatchObject({ gameId, revision: 1, state, results: null });
  });

  it("rejects legacy mutations for an authoritative game session", async () => {
    const gameId = randomUUID();
    await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: {
        name: "Authoritative table",
        mutationId: randomUUID(),
        baseRevision: 0,
        state: {
          setup: null,
          game: null,
          hostPlayerId: null,
          hostName: null,
          playlistId: "",
          log: [],
          undoHistory: [],
        },
        results: null,
      },
    });

    const responses = [
      await app.inject({
        method: "POST",
        url: `/api/games/${gameId}/events`,
        payload: {
          idempotencyKey: randomUUID(),
          type: "foul.issued",
          phase: "day",
          payload: { seat: 1 },
        },
      }),
      await app.inject({
        method: "POST",
        url: `/api/games/${gameId}/events/truncate`,
        payload: { fromIdempotencyKey: randomUUID() },
      }),
      await app.inject({ method: "DELETE", url: `/api/games/${gameId}` }),
      await app.inject({ method: "DELETE", url: `/api/games/${gameId}/results` }),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "game_session_authoritative" });
    }
    const readable = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    expect(readable.statusCode).toBe(200);
  });

  it("rejects timer and music controls on the legacy durable event route", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/games",
      payload: { name: "Auxiliary controls" },
    });
    const gameId = created.json().gameId as string;

    for (const type of ["timer.started", "music.fade-in"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/games/${gameId}/events`,
        payload: {
          idempotencyKey: `${type}-test`,
          type,
          phase: "day",
          payload: {},
        },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("returns a conflict when a mutation id is reused with different content", async () => {
    const gameId = randomUUID();
    const mutationId = randomUUID();
    const state = {
      setup: null,
      game: null,
      hostPlayerId: null,
      hostName: null,
      playlistId: "original",
      log: [],
      undoHistory: [],
    };
    await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: { name: "Exact retry", mutationId, baseRevision: 0, state, results: null },
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: {
        name: "Exact retry",
        mutationId,
        baseRevision: 0,
        state: { ...state, playlistId: "different" },
        results: null,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "game_session_mutation_mismatch" });
  });

  it("rejects timer and music controls from the durable aggregate log", async () => {
    const gameId = randomUUID();
    const response = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: {
        name: "Invalid auxiliary log",
        mutationId: randomUUID(),
        baseRevision: 0,
        state: {
          setup: null,
          game: null,
          hostPlayerId: null,
          hostName: null,
          playlistId: "PL",
          log: [
            {
              id: randomUUID(),
              sequence: 1,
              type: "timer.paused",
              phase: "day",
              payload: {},
              createdAt: "2026-08-18T08:00:00.000Z",
            },
          ],
          undoHistory: [],
        },
        results: null,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_failed" });
    expect(await pool.query("SELECT 1 FROM game_sessions WHERE id = $1", [gameId])).toHaveProperty(
      "rowCount",
      0,
    );
  });

  it("requires the exact public origin before a session-cookie mutation", async () => {
    const endSession = vi.fn(async () => undefined);
    const googleAuth = {
      configured: true,
      getUserForSession: vi.fn(async () => authenticatedUser),
      endSession,
    } as unknown as GoogleAuthService;
    const protectedApp = await buildApp({
      pool,
      googleAuth,
      publicAppUrl: "https://mafia.example.test",
    });
    await protectedApp.ready();

    for (const origin of [
      undefined,
      "not a URL",
      "http://mafia.example.test",
      "https://evil.test",
    ]) {
      const response = await protectedApp.inject({
        method: "DELETE",
        url: "/api/auth/session",
        headers: {
          cookie: "mafia_session=private-session-token",
          ...(origin === undefined ? {} : { origin }),
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "csrf_origin_mismatch" });
    }
    expect(endSession).not.toHaveBeenCalled();

    const accepted = await protectedApp.inject({
      method: "DELETE",
      url: "/api/auth/session",
      headers: {
        cookie: "mafia_session=private-session-token",
        origin: "https://mafia.example.test",
      },
    });
    expect(accepted.statusCode).toBe(204);
    expect(endSession).toHaveBeenCalledWith("private-session-token");
    await protectedApp.close();
  });

  it("throttles Google sign-in attempts with a stable retry contract", async () => {
    const googleAuth = {
      configured: true,
      createAuthorizationUrl: vi.fn(
        (state: string) => `https://accounts.example.test?state=${state}`,
      ),
    } as unknown as GoogleAuthService;
    const throttledApp = await buildApp({
      pool,
      googleAuth,
      publicAppUrl: "https://mafia.example.test",
      authRateLimit: { limit: 2, windowMs: 10_000 },
    });
    await throttledApp.ready();

    const first = await throttledApp.inject({ method: "GET", url: "/api/auth/google/start" });
    const second = await throttledApp.inject({ method: "GET", url: "/api/auth/google/start" });
    const rejected = await throttledApp.inject({ method: "GET", url: "/api/auth/google/start" });

    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(302);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("10");
    expect(rejected.json()).toEqual({ error: "auth_rate_limited" });
    expect(googleAuth.createAuthorizationUrl).toHaveBeenCalledTimes(2);
    await throttledApp.close();
  });

  it("does not expose unexpected failure details to clients", async () => {
    const secretMarker = "private-role-and-check-result";
    const googleAuth = {
      configured: true,
      getUserForSession: vi.fn(async () => {
        throw new Error(secretMarker);
      }),
    } as unknown as GoogleAuthService;
    const errorApp = await buildApp({ pool, googleAuth });
    await errorApp.ready();

    const response = await errorApp.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: "mafia_session=private-session-token" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_server_error" });
    expect(response.body).not.toContain(secretMarker);
    expect(response.body).not.toContain("private-session-token");
    await errorApp.close();
  });

  it("requires authentication on every protected API route", async () => {
    const id = "00000000-0000-4000-8000-000000000099";
    const club = {
      name: "Protected club",
      city: "Málaga",
      headerLogo: null,
      cardLogo: null,
      language: "en",
    };
    const routes = [
      { method: "GET", url: "/api/clubs" },
      { method: "POST", url: "/api/clubs", payload: { ...club, ownerConsent: true } },
      { method: "PUT", url: `/api/clubs/${id}`, payload: club },
      { method: "DELETE", url: `/api/clubs/${id}` },
      { method: "GET", url: "/api/music/oauth/status" },
      { method: "GET", url: "/api/music/oauth/start" },
      { method: "GET", url: "/api/music/oauth/callback?code=code&state=state" },
      { method: "GET", url: "/api/music/playlists" },
      { method: "GET", url: "/api/music/playlists/playlist/items" },
      { method: "DELETE", url: "/api/music/oauth/connection" },
      { method: "GET", url: "/api/players" },
      { method: "POST", url: "/api/players" },
      { method: "PUT", url: `/api/players/${id}` },
      { method: "DELETE", url: `/api/players/${id}` },
      { method: "GET", url: "/api/game-sessions" },
      { method: "GET", url: `/api/game-sessions/${id}` },
      { method: "PUT", url: `/api/game-sessions/${id}` },
      { method: "DELETE", url: `/api/game-sessions/${id}?expectedRevision=0` },
      { method: "POST", url: "/api/games" },
      { method: "DELETE", url: `/api/games/${id}` },
      { method: "POST", url: `/api/games/${id}/events/truncate` },
      { method: "POST", url: `/api/games/${id}/events` },
      { method: "GET", url: `/api/games/${id}/events` },
      { method: "PUT", url: `/api/games/${id}/results` },
      { method: "DELETE", url: `/api/games/${id}/results` },
    ] as const;
    const anonymousApp = await buildApp({
      pool,
      authenticateRequest: async () => null,
      defaultClubId: DEFAULT_CLUB_ID,
    });
    await anonymousApp.ready();

    for (const route of routes) {
      const response = await anonymousApp.inject({
        method: route.method,
        url: route.url,
        ...("payload" in route ? { payload: route.payload } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(response.json(), `${route.method} ${route.url}`).toEqual({
        error: "authentication_required",
      });
    }
    await anonymousApp.close();
  });

  it("enforces club membership and manager-only route classes", async () => {
    const regularUser = {
      id: randomUUID(),
      email: `regular-${randomUUID()}@example.test`,
      name: "Regular user",
      picture: null,
    };
    const outsider = {
      id: randomUUID(),
      email: `outsider-${randomUUID()}@example.test`,
      name: "Outsider",
      picture: null,
    };
    for (const user of [regularUser, outsider]) {
      await pool.query(
        "INSERT INTO users (id, email, display_name, picture) VALUES ($1, $2, $3, $4)",
        [user.id, user.email, user.name, user.picture],
      );
    }
    await pool.query(
      "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'user')",
      [DEFAULT_CLUB_ID, regularUser.id],
    );
    const regularApp = await buildApp({
      pool,
      authenticateRequest: async () => regularUser,
      defaultClubId: DEFAULT_CLUB_ID,
    });
    const outsiderApp = await buildApp({
      pool,
      authenticateRequest: async () => outsider,
      defaultClubId: DEFAULT_CLUB_ID,
    });
    await Promise.all([regularApp.ready(), outsiderApp.ready()]);
    const id = "00000000-0000-4000-8000-000000000099";
    const club = {
      name: "Protected club",
      city: "Málaga",
      headerLogo: null,
      cardLogo: null,
      language: "en",
    };
    const managerRoutes = [
      { method: "PUT", url: `/api/clubs/${DEFAULT_CLUB_ID}`, payload: club },
      { method: "DELETE", url: `/api/clubs/${DEFAULT_CLUB_ID}` },
      { method: "POST", url: "/api/players" },
      { method: "PUT", url: `/api/players/${id}` },
      { method: "DELETE", url: `/api/players/${id}` },
    ] as const;
    const memberRoutes = [
      ...managerRoutes,
      { method: "GET", url: "/api/players" },
      { method: "GET", url: "/api/game-sessions" },
      { method: "GET", url: `/api/game-sessions/${id}` },
      { method: "PUT", url: `/api/game-sessions/${id}` },
      { method: "DELETE", url: `/api/game-sessions/${id}?expectedRevision=0` },
      { method: "POST", url: "/api/games" },
      { method: "DELETE", url: `/api/games/${id}` },
      { method: "POST", url: `/api/games/${id}/events/truncate` },
      { method: "POST", url: `/api/games/${id}/events` },
      { method: "GET", url: `/api/games/${id}/events` },
      { method: "PUT", url: `/api/games/${id}/results` },
      { method: "DELETE", url: `/api/games/${id}/results` },
    ] as const;

    for (const route of memberRoutes) {
      const response = await outsiderApp.inject({
        method: route.method,
        url: route.url,
        ...("payload" in route ? { payload: route.payload } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json(), `${route.method} ${route.url}`).toEqual({
        error: "club_access_denied",
      });
    }
    for (const route of managerRoutes) {
      const response = await regularApp.inject({
        method: route.method,
        url: route.url,
        ...("payload" in route ? { payload: route.payload } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json(), `${route.method} ${route.url}`).toEqual({
        error: "club_manager_required",
      });
    }
    expect(await regularApp.inject({ method: "GET", url: "/api/players" })).toHaveProperty(
      "statusCode",
      200,
    );

    await Promise.all([regularApp.close(), outsiderApp.close()]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
      [regularUser.id, outsider.id],
    ]);
  });
});
