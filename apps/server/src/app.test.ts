import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import type { YouTubeOAuthService } from "./youtube-oauth.js";

const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test",
});
const app = await buildApp({ pool });

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("server API", () => {
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

  it("redacts secret event payloads from public log requests", async () => {
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

    const host = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    const publicLog = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/events?visibility=public`,
    });

    expect(host.json().events[0].payload).toEqual({ targetSeat: 8, match: true });
    expect(publicLog.json().events[0].payload).toEqual({ redacted: true });
  });

  it("creates consent-safe player profiles and rejects duplicate nicknames", async () => {
    const nickname = `Profile-${randomUUID().slice(0, 8)}`;
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

    const listed = await app.inject({ method: "GET", url: "/api/players" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().players).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.json().player.id, nickname })]),
    );
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
    const oauthApp = await buildApp({ pool, youtubeOAuth: oauth });
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

    const callback = await oauthApp.inject({
      method: "GET",
      url: `/api/music/oauth/callback?code=authorization-code&state=${location.searchParams.get("state")}`,
      headers: { cookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/?music=connected");
    expect(callback.headers["set-cookie"]).toContain("Max-Age=0");
    expect(oauth.exchangeCode).toHaveBeenCalledWith("authorization-code");

    await oauthApp.close();
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
    const oauthApp = await buildApp({ pool, youtubeOAuth: oauth });
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
    expect(oauth.listPlaylistItems).toHaveBeenCalledWith("PL-music");
    expect(disconnected.statusCode).toBe(204);
    expect(oauth.disconnect).toHaveBeenCalledOnce();

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
