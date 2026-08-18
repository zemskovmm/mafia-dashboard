import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { RemoteGameSession } from "./client.js";
import {
  ApiError,
  createPlayer,
  deleteGameResults,
  deleteRemoteGame,
  disconnectMusicAccount,
  getGameSession,
  getMusicAccountStatus,
  listActiveGameSessions,
  listMusicPlaylists,
  listPlayers,
  saveGameResults,
  saveGameSession,
  truncateRemoteEvents,
  updatePlayer,
} from "./client.js";

const emptyStatistics = {
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
};

const player = {
  id: "00000000-0000-4000-8000-000000000001",
  nickname: "Alpha",
  consent: false,
  firstName: null,
  lastName: null,
  email: null,
  consentAt: null,
  createdAt: "2026-08-17T20:00:00.000Z",
  updatedAt: "2026-08-17T20:00:00.000Z",
  lastPlayedAt: null,
  statistics: emptyStatistics,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("player API client", () => {
  it("keeps detailed session responses separate from list summaries", () => {
    expectTypeOf<RemoteGameSession>().not.toHaveProperty("phase");
  });

  it("loads ordered player profiles", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ players: [player] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPlayers()).resolves.toEqual([player]);
    expect(fetchMock).toHaveBeenCalledWith("/api/players");
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
      firstName: null,
      lastName: null,
      email: null,
    };
    await expect(createPlayer(input)).resolves.toEqual(player);
    await expect(updatePlayer(player.id, { ...input, nickname: "Beta" })).resolves.toMatchObject({
      nickname: "Beta",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/players/${player.id}`,
      expect.objectContaining({ method: "PUT" }),
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
      firstName: null,
      lastName: null,
      email: null,
    });
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 409, code: "nickname_conflict" });
  });

  it("saves finalized game results with a retry-safe PUT", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const results = {
      hostPlayerId: "00000000-0000-4000-8000-000000000011",
      winner: "red" as const,
      playedAt: "2026-08-17T22:00:00.000Z",
      players: [
        {
          playerId: player.id,
          seat: 1,
          role: "sheriff" as const,
          team: "red" as const,
          status: "active" as const,
          fouls: 0,
        },
      ],
    };

    await saveGameResults("00000000-0000-4000-8000-000000000002", results);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/games/00000000-0000-4000-8000-000000000002/results",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(results) }),
    );
  });

  it("truncates an undone remote event tail by idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await truncateRemoteEvents("00000000-0000-4000-8000-000000000002", "undo-from-this-event");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/games/00000000-0000-4000-8000-000000000002/events/truncate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromIdempotencyKey: "undo-from-this-event" }),
      },
    );
  });

  it("tombstones a cleared remote game with DELETE", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteRemoteGame("00000000-0000-4000-8000-000000000002");

    expect(fetchMock).toHaveBeenCalledWith("/api/games/00000000-0000-4000-8000-000000000002", {
      method: "DELETE",
    });
  });

  it("retracts finalized game results with an idempotent DELETE", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteGameResults("00000000-0000-4000-8000-000000000002");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/games/00000000-0000-4000-8000-000000000002/results",
      { method: "DELETE" },
    );
  });
});

describe("game session aggregate API client", () => {
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
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/game-sessions/${gameId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mutation),
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
