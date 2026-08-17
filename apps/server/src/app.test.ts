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
        idempotencyKey: "timer-1",
        type: "timer.started",
        phase: "day",
        seat: 3,
        payload: { seconds: 60 },
        secret: false,
      },
    });
    expect(response.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events`,
      payload: {
        idempotencyKey: "timer-1",
        type: "timer.started",
        phase: "day",
        seat: 3,
        payload: { seconds: 60 },
        secret: false,
      },
    });
    expect(duplicate.statusCode).toBe(200);

    const log = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    expect(log.statusCode).toBe(200);
    expect(log.json().events).toHaveLength(1);
    expect(log.json().events[0]).toMatchObject({ sequence: 1, type: "timer.started" });
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

  it("saves one finalized result per player and exposes aggregate statistics", async () => {
    const players: Array<{ id: string; nickname: string }> = [];
    for (let index = 0; index < 10; index += 1) {
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

    const gameId = randomUUID();
    const payload = {
      winner: "red",
      playedAt: "2026-08-17T22:00:00.000Z",
      players: players.map((player, index) => ({
        playerId: player.id,
        seat: index + 1,
        role: index === 0 ? "sheriff" : index < 7 ? "citizen" : index === 9 ? "don" : "mafia",
        team: index < 7 ? "red" : "black",
        status: index === 7 ? "eliminated" : "active",
        fouls: index === 0 ? 2 : 0,
      })),
    };
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
      .players.find((player: { id: string }) => player.id === players[0]!.id);
    expect(sheriff.statistics).toMatchObject({
      gamesPlayed: 1,
      wins: 1,
      losses: 0,
      sheriffGames: 1,
      totalFouls: 2,
    });
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
    const oauth = {
      getStatus: vi.fn().mockResolvedValue({
        configured: true,
        connected: true,
        accountLabel: "Mafia Host",
      }),
      listPlaylists: vi.fn().mockResolvedValue(playlists),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as YouTubeOAuthService;
    const oauthApp = await buildApp({ pool, youtubeOAuth: oauth });
    await oauthApp.ready();

    const status = await oauthApp.inject({ method: "GET", url: "/api/music/oauth/status" });
    const listed = await oauthApp.inject({ method: "GET", url: "/api/music/playlists" });
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
    expect(disconnected.statusCode).toBe(204);
    expect(oauth.disconnect).toHaveBeenCalledOnce();

    await oauthApp.close();
  });
});
