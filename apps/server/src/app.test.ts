import { randomUUID } from "node:crypto";
import { createGameLogEntry } from "@mafia/game-domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { GameSessionStore } from "./game-session-store.js";
import type { AppUser, GoogleAuthService } from "./google-auth.js";
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

const createReplayGameFixture = async () => {
  const hostPlayerId = randomUUID();
  const playerIds = Array.from({ length: 10 }, () => randomUUID());
  for (const [index, id] of [hostPlayerId, ...playerIds].entries()) {
    await pool.query("INSERT INTO players (id, nickname) VALUES ($1, $2)", [
      id,
      `API replay ${index} ${randomUUID().slice(0, 8)}`,
    ]);
  }
  const roles = ["sheriff", ...Array(6).fill("citizen"), "mafia", "mafia", "don"] as const;
  const players = playerIds.map((id, index) => ({
    id,
    name: `Player ${index + 1}`,
    seat: index + 1,
    role: roles[index]!,
    team: index >= 7 ? ("black" as const) : ("red" as const),
    status: "active" as const,
    fouls: 0,
    mutePending: false,
  }));
  const game = {
    phase: "day" as const,
    day: 1,
    players,
    turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
    currentTurnIndex: 0,
    nominations: [],
    voteAssignments: {},
    shotAssignments: {},
    winner: null,
  };
  return { hostPlayerId, game };
};

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
        ...consent,
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
        ownerConsent: true,
      },
    });
    expect(createdClub.statusCode).toBe(201);
    const secondClubId = createdClub.json().club.id as string;

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

    const secondRoster = await app.inject({
      method: "GET",
      url: "/api/players",
      headers: { ...authHeaders, "x-club-id": secondClubId },
    });
    const firstRoster = await app.inject({
      method: "GET",
      url: "/api/players",
      headers: { ...authHeaders, "x-club-id": defaultClubId },
    });
    expect(secondRoster.json().players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nickname: "Owner",
          consent: true,
          email: authenticatedUser.email,
          clubManager: true,
          managerLocked: true,
        }),
      ]),
    );
    expect(secondRoster.json().players).toEqual(
      expect.arrayContaining([expect.objectContaining({ nickname })]),
    );
    expect(secondRoster.json().players.map((player: { id: string }) => player.id)).toContain(
      createdPlayer.json().player.id,
    );
    expect(firstRoster.json().players).toEqual(
      expect.arrayContaining([expect.objectContaining({ nickname })]),
    );
    expect(
      firstRoster
        .json()
        .players.find((player: { nickname: string }) => player.nickname === nickname).id,
    ).not.toBe(createdPlayer.json().player.id);
    expect(firstRoster.json().players.map((player: { id: string }) => player.id)).not.toContain(
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
      secret: false,
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
        secret: false,
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
        secret: false,
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
        secret: false,
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
        secret: false,
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
        secret: false,
      },
    });

    expect(invalid.statusCode).toBe(400);
    const log = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    expect(log.json().events).toEqual([]);
  });

  it("redacts secret payloads and integrity hashes from public log requests", async () => {
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
        secret: true,
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
        clubManager: true,
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
      clubManager: false,
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
        clubManager: true,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().player).toMatchObject({ clubManager: true, managerLocked: false });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/players/${created.json().player.id}`,
      payload: {
        nickname: `${created.json().player.nickname}-updated`,
        consent: true,
        firstName: "API",
        lastName: "Manager",
        email: manager.email,
        clubManager: true,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().player).toMatchObject({ clubManager: true, managerLocked: false });
  });

  it("returns manager_consent_required when an unlinked player is promoted without consent", async () => {
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
        clubManager: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "manager_consent_required" });
  });

  it("returns manager_email_conflict separately from nickname conflicts", async () => {
    const email = `pending-conflict-${randomUUID()}@example.test`;
    const profile = {
      consent: true,
      firstName: "Pending",
      lastName: "Manager",
      email,
      clubManager: true,
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
    expect(conflict.json()).toEqual({ error: "manager_email_conflict" });

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
    expect(updateConflict.json()).toEqual({ error: "manager_email_conflict" });

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
    expect(linkedUserConflict.json()).toEqual({ error: "manager_email_conflict" });
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
        clubManager: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().player).toMatchObject({
      consent: false,
      consentAt: null,
      firstName: null,
      lastName: null,
      email: null,
      clubManager: true,
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
      "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'editor')",
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
          clubManager: true,
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
          clubManager: false,
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
          clubManager: false,
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
        consent: true,
        firstName: owner.firstName,
        lastName: owner.lastName,
        email: owner.email,
        clubManager: false,
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

  it("returns active_game and preserves an unfinalized persisted roster on direct player deletion", async () => {
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

  it("claims an invited manager before completing Google sign-in", async () => {
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
        clubManager: true,
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
      expect.arrayContaining([expect.objectContaining({ id: invitedClubId, role: "editor" })]),
    );

    const signedOut = await authApp.inject({
      method: "DELETE",
      url: "/api/auth/session",
      headers: { cookie: "mafia_session=application-session-token" },
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

  it("starts a session through the dedicated incremental operation endpoint", async () => {
    const gameId = randomUUID();
    const fixture = await createReplayGameFixture();
    const setup = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: {
        name: "Dedicated start",
        mutationId: randomUUID(),
        baseRevision: 0,
        state: {
          setup: null,
          game: null,
          hostPlayerId: fixture.hostPlayerId,
          hostName: "API Host",
          playlistId: "",
          log: [],
          undoHistory: [],
        },
        results: null,
      },
    });
    expect(setup.statusCode).toBe(201);
    const initialGame = { replayVersion: 1 as const, game: fixture.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-25T00:00:00.000Z",
      before: fixture.game,
      draft: { type: "game.checkpointed", payload: {}, secret: true },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/game-sessions/${gameId}/start`,
      payload: {
        mutationId: randomUUID(),
        baseRevision: 1,
        initialGame,
        event: started.entry,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      gameId,
      revision: 2,
      duplicate: false,
      state: {
        game: fixture.game,
        initialGame,
        events: [started.entry],
        headEventId: started.entry.id,
      },
    });
    const stored = await pool.query<{ state: Record<string, unknown> }>(
      "SELECT state FROM game_sessions WHERE id = $1",
      [gameId],
    );
    expect(stored.rows[0]?.state).not.toHaveProperty("game");
    expect(stored.rows[0]?.state).not.toHaveProperty("events");
  });

  it("normalizes a legacy snapshot through its dedicated idempotent endpoint", async () => {
    const gameId = randomUUID();
    const fixture = await createReplayGameFixture();
    const legacy = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: {
        name: "Normalize endpoint",
        mutationId: randomUUID(),
        baseRevision: 0,
        state: {
          setup: null,
          game: fixture.game,
          hostPlayerId: fixture.hostPlayerId,
          hostName: "Normalize Host",
          playlistId: "",
          log: [],
          undoHistory: [],
        },
        results: null,
      },
    });
    expect(legacy.statusCode).toBe(201);
    const mutationId = randomUUID();

    const response = await app.inject({
      method: "POST",
      url: `/api/game-sessions/${gameId}/normalize`,
      payload: { mutationId, baseRevision: 1 },
    });
    const retry = await app.inject({
      method: "POST",
      url: `/api/game-sessions/${gameId}/normalize`,
      payload: { mutationId, baseRevision: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      revision: 2,
      duplicate: false,
      previewableFromEventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      state: {
        game: fixture.game,
        events: [expect.objectContaining({ type: "game.checkpointed", sequence: 1 })],
      },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ revision: 2, duplicate: true });
  });

  it("appends exactly one canonical entry through the dedicated session event endpoint", async () => {
    const gameId = randomUUID();
    const fixture = await createReplayGameFixture();
    await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: {
        name: "Dedicated append",
        mutationId: randomUUID(),
        baseRevision: 0,
        state: {
          setup: null,
          game: null,
          hostPlayerId: fixture.hostPlayerId,
          hostName: "Append API Host",
          playlistId: "",
          log: [],
          undoHistory: [],
        },
        results: null,
      },
    });
    const initialGame = { replayVersion: 1 as const, game: fixture.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-25T00:00:00.000Z",
      before: fixture.game,
      draft: { type: "game.checkpointed", payload: {}, secret: true },
    });
    await app.inject({
      method: "POST",
      url: `/api/game-sessions/${gameId}/start`,
      payload: { mutationId: randomUUID(), baseRevision: 1, initialGame, event: started.entry },
    });
    const checkpoint = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: started.entry.id,
      createdAt: "2026-08-25T00:01:00.000Z",
      before: started.after,
      draft: {
        type: "foul.issued",
        payload: { seat: 1, foulNumber: 1, redCarded: false },
        secret: false,
      },
    });
    const mutationId = randomUUID();

    const response = await app.inject({
      method: "POST",
      url: `/api/game-sessions/${gameId}/events`,
      payload: { mutationId, baseRevision: 2, event: checkpoint.entry },
    });
    const retry = await app.inject({
      method: "POST",
      url: `/api/game-sessions/${gameId}/events`,
      payload: { mutationId, baseRevision: 2, event: checkpoint.entry },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      revision: 3,
      duplicate: false,
      state: {
        game: expect.objectContaining({
          players: expect.arrayContaining([expect.objectContaining({ seat: 1, fouls: 1 })]),
        }),
        events: [started.entry, checkpoint.entry],
        headEventId: checkpoint.entry.id,
      },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ revision: 3, duplicate: true });
    const restored = await app.inject({ method: "GET", url: `/api/game-sessions/${gameId}` });
    expect(restored.json().session.state).toMatchObject({
      game: expect.objectContaining({
        players: expect.arrayContaining([expect.objectContaining({ seat: 1, fouls: 1 })]),
      }),
      events: [started.entry, checkpoint.entry],
    });
  });

  it("moves the active replay head through the dedicated head endpoint", async () => {
    const gameId = randomUUID();
    const fixture = await createReplayGameFixture();
    const sessionStore = new GameSessionStore(pool);
    await sessionStore.save({
      gameId,
      name: "Dedicated head",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        setup: null,
        game: null,
        hostPlayerId: fixture.hostPlayerId,
        hostName: "Head API Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });
    const initialGame = { replayVersion: 1 as const, game: fixture.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-25T00:00:00.000Z",
      before: fixture.game,
      draft: { type: "game.checkpointed", payload: {}, secret: true },
    });
    await sessionStore.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: started.entry,
    });
    const checkpoint = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: started.entry.id,
      createdAt: "2026-08-25T00:01:00.000Z",
      before: started.after,
      draft: {
        type: "foul.issued",
        payload: { seat: 1, foulNumber: 1, redCarded: false },
        secret: false,
      },
    });
    await sessionStore.appendEvent({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
      event: checkpoint.entry,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/game-sessions/${gameId}/head`,
      payload: {
        mutationId: randomUUID(),
        baseRevision: 3,
        targetEventId: started.entry.id,
        reason: "reset",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      revision: 4,
      state: {
        game: expect.objectContaining({ currentTurnIndex: 0 }),
        headEventId: started.entry.id,
        resetReturnEventId: checkpoint.entry.id,
      },
    });
    expect(
      await pool.query(
        "SELECT COUNT(*)::int AS count FROM game_events WHERE game_id = $1 AND replay_sequence IS NOT NULL",
        [gameId],
      ),
    ).toMatchObject({ rows: [{ count: 2 }] });
  });

  it("completes a replayed finished session through the dedicated complete endpoint", async () => {
    const gameId = randomUUID();
    const fixture = await createReplayGameFixture();
    const finished = { ...fixture.game, phase: "finished" as const, winner: "red" as const };
    const sessionStore = new GameSessionStore(pool);
    await sessionStore.save({
      gameId,
      name: "Dedicated complete",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        setup: null,
        game: null,
        hostPlayerId: fixture.hostPlayerId,
        hostName: "Complete API Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });
    const initialGame = { replayVersion: 1 as const, game: finished };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-25T00:00:00.000Z",
      before: finished,
      draft: { type: "game.checkpointed", payload: {}, secret: true },
    });
    await sessionStore.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: started.entry,
    });
    const completedEvent = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: started.entry.id,
      createdAt: "2026-08-25T00:02:00.000Z",
      before: started.after,
      draft: { type: "game.completed", payload: { winner: "red" }, secret: false },
    });
    await sessionStore.appendEvent({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
      event: completedEvent.entry,
    });
    const results = {
      hostPlayerId: fixture.hostPlayerId,
      winner: "red" as const,
      playedAt: completedEvent.entry.createdAt,
      players: finished.players.map(({ id, seat, role, team, status, fouls }) => ({
        playerId: id,
        seat,
        role,
        team,
        status,
        fouls,
        bestMoveHits: null,
      })),
    };

    const response = await app.inject({
      method: "POST",
      url: `/api/game-sessions/${gameId}/complete`,
      payload: { mutationId: randomUUID(), baseRevision: 3, results },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      revision: 4,
      status: "completed",
      results,
      state: { game: finished, events: [started.entry, completedEvent.entry] },
    });
    expect(
      await pool.query("SELECT COUNT(*)::int AS count FROM game_events WHERE game_id = $1", [
        gameId,
      ]),
    ).toMatchObject({ rows: [{ count: 3 }] });
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
    const listed = await app.inject({ method: "GET", url: "/api/game-sessions" });
    const restored = await app.inject({ method: "GET", url: `/api/game-sessions/${gameId}` });

    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ gameId, revision: 1, duplicate: false });
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
          secret: false,
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
          secret: false,
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
              secret: false,
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
});
