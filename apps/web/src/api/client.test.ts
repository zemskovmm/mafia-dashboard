import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  checkServerReady,
  clearGameSession,
  createClub,
  createPlayer,
  deleteClub,
  disconnectMusicAccount,
  getAuthSession,
  getGameEvents,
  getGameSession,
  getMusicAccountStatus,
  listActiveGameSessions,
  listClubs,
  listCompletedGameSessions,
  listMusicPlaylists,
  listPlayers,
  saveGameSession,
  signOut,
  updateClub,
  updatePlayer,
} from "./client.js";
import type { PlayerProfile, PlayerProfileInput } from "./client.js";

const emptyStatistics = {
  hostedGames: 0,
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  redGames: 0,
  redWins: 0,
  blackGames: 0,
  blackWins: 0,
  sheriffGames: 0,
  citizenGames: 0,
  mafiaGames: 0,
  donGames: 0,
  totalFouls: 0,
  eliminations: 0,
  redCards: 0,
  bestMoves: 0,
  bestMoveMafiaHits: 0,
};

const player = {
  id: "00000000-0000-4000-8000-000000000001",
  nickname: "Alpha",
  consent: false,
  clubAccess: "none",
  managerLocked: false,
  firstName: null,
  lastName: null,
  email: null,
  consentAt: null,
  createdAt: "2026-08-17T20:00:00.000Z",
  updatedAt: "2026-08-17T20:00:00.000Z",
  lastPlayedAt: null,
  statistics: emptyStatistics,
} satisfies PlayerProfile;

const lockedManagerConsentWithdrawal: PlayerProfileInput = {
  nickname: "Owner",
  consent: false,
  clubAccess: "manager",
  firstName: null,
  lastName: null,
  email: null,
};
void lockedManagerConsentWithdrawal;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("club API client", () => {
  it("round-trips the club settings contract", async () => {
    const club = {
      id: "00000000-0000-4000-8000-000000000101",
      name: "Mafia Malaga",
      city: "Málaga",
      headerLogo: null,
      cardLogo: null,
      language: "ru" as const,
      bestMoveEnabled: false,
      role: "manager" as const,
      createdAt: "2026-08-17T20:00:00.000Z",
      updatedAt: "2026-08-17T20:00:00.000Z",
    };
    const created = { ...club, language: "en" as const, bestMoveEnabled: true };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ clubs: [club] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ club: created }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ club }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listClubs()).resolves.toEqual([club]);
    await expect(
      createClub({
        name: created.name,
        city: created.city,
        headerLogo: null,
        cardLogo: null,
        language: "en",
        bestMoveEnabled: true,
        ownerConsent: true,
      }),
    ).resolves.toEqual(created);
    await expect(
      updateClub(club.id, {
        name: club.name,
        city: club.city,
        headerLogo: null,
        cardLogo: null,
        language: "ru",
        bestMoveEnabled: false,
      }),
    ).resolves.toEqual(club);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/clubs",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"bestMoveEnabled":true'),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/clubs/${club.id}`,
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"bestMoveEnabled":false'),
      }),
    );
  });

  it("uses the secure server session for club requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteClub("00000000-0000-4000-8000-000000000101");

    expect(fetchMock).toHaveBeenCalledWith("/api/clubs/00000000-0000-4000-8000-000000000101", {
      method: "DELETE",
    });
  });

  it("loads and clears the current Google-backed application session", async () => {
    const session = {
      configured: true,
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "owner@example.test",
        name: "Club owner",
        picture: null,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(session), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAuthSession()).resolves.toEqual(session);
    await signOut();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/auth/session");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/auth/session", { method: "DELETE" });
  });
});

describe("player API client", () => {
  it("loads ordered player profiles", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ players: [player] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPlayers()).resolves.toEqual([player]);
    expect(fetchMock).toHaveBeenCalledWith("/api/players", { headers: {} });
  });

  it("creates and updates consent-safe profiles", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ player }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ player: { ...player, nickname: "Beta" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      nickname: "Alpha",
      consent: false as const,
      clubAccess: "none",
      firstName: null,
      lastName: null,
      email: null,
    } satisfies PlayerProfileInput;
    await expect(createPlayer(input)).resolves.toEqual(player);
    await expect(updatePlayer(player.id, { ...input, nickname: "Beta" })).resolves.toMatchObject({
      nickname: "Beta",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/players",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/players/${player.id}`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ ...input, nickname: "Beta" }),
      }),
    );
  });

  it("surfaces typed API conflicts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "nickname_conflict" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const failure = createPlayer({
      nickname: "Alpha",
      consent: false,
      clubAccess: "none",
      firstName: null,
      lastName: null,
      email: null,
    });
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 409, code: "nickname_conflict" });
  });
});

describe("game session aggregate API client", () => {
  it("checks server and database readiness", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkServerReady()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/health/ready",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("bounds a readiness request that never reaches the server", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );

    const readiness = expect(checkServerReady()).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(4_000);

    await readiness;
  });

  it("uploads the complete authoritative browser snapshot without a revision precondition", async () => {
    const gameId = "00000000-0000-4000-8000-000000000002";
    const state = {
      setup: null,
      game: null,
      hostPlayerId: null,
      hostName: null,
      playlistId: "PL",
      log: [],
      undoHistory: [],
    };
    const operation = {
      kind: "snapshot",
      name: "Table",
      mutationId: "00000000-0000-4000-8000-000000000003",
      baseRevision: 0,
      state,
      results: null,
    };
    const response = { revision: 1, duplicate: false, name: "Table" };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = (await import("./client.js")) as unknown as {
      saveGameSessionOperation: (
        id: string,
        input: typeof operation,
        clubId?: string,
      ) => Promise<typeof response>;
    };

    await expect(api.saveGameSessionOperation(gameId, operation)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/game-sessions/${gameId}`,
      expect.objectContaining({
        method: "PUT",
        headers: { "content-type": "application/json" },
        signal: expect.any(AbortSignal),
        body: JSON.stringify({
          name: operation.name,
          mutationId: operation.mutationId,
          state,
          results: null,
        }),
      }),
    );
  });

  it("uses the authoritative mutation, active list, and restore endpoints", async () => {
    const gameId = "00000000-0000-4000-8000-000000000002";
    const state = {
      setup: null,
      game: null,
      hostPlayerId: null,
      hostName: null,
      playlistId: "PL",
      log: [],
      undoHistory: [],
    };
    const summary = {
      gameId,
      name: "Table",
      revision: 1,
      hostName: null,
      phase: "setup-players",
      day: 0,
      updatedAt: "2026-08-18T08:00:00.000Z",
    };
    const session = { ...summary, duplicate: false, status: "active", state };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(session), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessions: [summary] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const mutation = {
      name: "Table",
      mutationId: "00000000-0000-4000-8000-000000000003",
      baseRevision: 0,
      state,
      results: null,
    };

    await expect(saveGameSession(gameId, mutation)).resolves.toEqual(session);
    await expect(listActiveGameSessions()).resolves.toEqual([summary]);
    await expect(getGameSession(gameId)).resolves.toEqual(session);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/game-sessions/${gameId}`,
      expect.objectContaining({
        method: "PUT",
        headers: { "content-type": "application/json" },
        signal: expect.any(AbortSignal),
        body: JSON.stringify(mutation),
      }),
    );
  });
  it("loads completed summaries and host-visible events for the selected club", async () => {
    const gameId = "00000000-0000-4000-8000-000000000002";
    const clubId = "00000000-0000-4000-8000-000000000101";
    const completed = {
      gameId,
      name: "Completed",
      revision: 8,
      hostName: "Host",
      winner: "red",
      playedAt: "2026-08-24T20:00:00.000Z",
      day: 3,
      eventCount: 20,
      updatedAt: "2026-08-24T20:00:00.000Z",
    };
    const events = [{ id: "event", gameId, sequence: 1, type: "game.started" }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessions: [completed] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listCompletedGameSessions(clubId)).resolves.toEqual([completed]);
    await expect(getGameEvents(gameId, clubId, "host")).resolves.toEqual(events);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/game-sessions?status=completed", {
      headers: { "x-club-id": clubId },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/games/${gameId}/events?visibility=host`, {
      headers: { "x-club-id": clubId },
    });
  });

  it("encodes completed-history filters in a stable query order", async () => {
    const clubId = "00000000-0000-4000-8000-000000000101";
    const playerId = "00000000-0000-4000-8000-000000000002";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listCompletedGameSessions(clubId, {
      from: "2026-08-01",
      to: "2026-08-31",
      playerId,
      outcome: "draw",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/game-sessions?status=completed&from=2026-08-01&to=2026-08-31&playerId=${playerId}&outcome=draw`,
      { headers: { "x-club-id": clubId } },
    );
  });

  it("sends the expected revision when clearing a session", async () => {
    const gameId = "00000000-0000-4000-8000-000000000002";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await clearGameSession(gameId, 7);

    expect(fetchMock).toHaveBeenCalledWith(`/api/game-sessions/${gameId}?expectedRevision=7`, {
      method: "DELETE",
      headers: {},
    });
  });
});

describe("music account API client", () => {
  it("loads the Google account connection status", async () => {
    const status = { configured: true, connected: true, accountLabel: "Mafia Host" };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(status), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getMusicAccountStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith("/api/music/oauth/status");
  });

  it("loads the connected account playlists", async () => {
    const playlists = [
      {
        id: "PL-music",
        title: "Mafia music",
        itemCount: 20,
        thumbnailUrl: "https://i.ytimg.com/music.jpg",
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ playlists }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listMusicPlaylists()).resolves.toEqual(playlists);
    expect(fetchMock).toHaveBeenCalledWith("/api/music/playlists");
  });

  it("disconnects the Google account with a non-form HTTP method", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await disconnectMusicAccount();

    expect(fetchMock).toHaveBeenCalledWith("/api/music/oauth/connection", { method: "DELETE" });
  });
});
