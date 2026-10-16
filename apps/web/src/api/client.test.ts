import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  assignGameTournament,
  listTournaments,
  createTournament,
  getClubStatistics,
  getPlayerStatistics,
  sanitizeApiValidationIssues,
  checkServerReady,
  clearGameSession,
  createGameSession,
  createClub,
  createPlayer,
  deleteClub,
  disconnectMusicAccount,
  getAuthSession,
  getAppVersion,
  getGameEvents,
  getGameSession,
  getMusicAccountStatus,
  listActiveGameSessions,
  listClubs,
  listCompletedGameSessions,
  listMusicPlaylists,
  listPlayers,
  saveGameSessionOperation,
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

describe("app version API client", () => {
  it("returns the exact non-default server version without using a cached response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ version: "2.7.123", commit: "abc123" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAppVersion()).resolves.toBe("2.7.123");
    expect(fetchMock).toHaveBeenCalledWith("/health/version", { cache: "no-store" });
  });

  it.each([
    null,
    {},
    { version: "2.7.123" },
    { version: "2.7.123", commit: 123 },
    ...[
      "",
      "1.0",
      "01.0.0",
      "1.00.0",
      "1.0.01",
      "1.-1.0",
      "1.2.3-beta",
      "1.0.9007199254740992",
      "1e2.0.0",
    ].map((version) => ({ version, commit: "abc123" })),
  ])("rejects a malformed version response: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));

    await expect(getAppVersion()).rejects.toThrow("Invalid app version response");
  });

  it("preserves HTTP error status and code", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })),
    );

    await expect(getAppVersion()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      code: "unavailable",
    });
  });

  it("propagates network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network unavailable")));

    await expect(getAppVersion()).rejects.toThrow("Network unavailable");
  });
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
  it("retains only allowlisted history codes and bounded positions", () => {
    const diagnostic = { code: "history.hash_mismatch", eventIndex: 4, replayIndex: 2 };
    expect(
      sanitizeApiValidationIssues([
        {
          path: ["state", "events"],
          message: "private",
          diagnostic: { ...diagnostic, eventId: "private" },
        },
      ]),
    ).toEqual([{ path: "state.events", message: "Invalid value", diagnostic }]);
    for (const invalid of [
      null,
      [],
      { code: "private" },
      { ...diagnostic, eventIndex: -1 },
      { ...diagnostic, eventIndex: 1.5 },
      { ...diagnostic, replayIndex: Number.MAX_SAFE_INTEGER },
      { ...diagnostic, replayIndex: "private" },
    ]) {
      expect(
        sanitizeApiValidationIssues([{ path: ["state", "events"], diagnostic: invalid }]),
      ).toEqual([{ path: "state.events", message: "Invalid value" }]);
    }
  });
  it("retains only bounded static validation diagnostics from a failed save", async () => {
    const gameId = "00000000-0000-4000-8000-000000000002";
    const clubId = "00000000-0000-4000-8000-000000000101";
    const safeIssue = {
      path: "state.game.voteAssignments",
      message: "The final voting candidate must receive every remaining active vote",
    };
    const privateSentinel = "must-not-leak-private-validation-value";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "validation_failed",
            issues: [
              { path: ["results", "hostPlayerId"], message: privateSentinel },
              { path: ["state", "undoHistory", privateSentinel], message: privateSentinel },
              {
                path: ["state", "game", "players", 3, "role"],
                message: privateSentinel,
              },
              { path: ["results", "players", 3, "role"], message: privateSentinel },
              ...Array.from({ length: 12 }, () => ({
                path: ["state", "game", "voteAssignments"],
                message: safeIssue.message,
              })),
            ],
            request: { state: { events: [{ payload: privateSentinel }] } },
            headers: { authorization: `Bearer ${privateSentinel}` },
            credentials: { token: privateSentinel },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    let failure: unknown;
    try {
      await saveGameSessionOperation(
        gameId,
        {
          kind: "snapshot",
          name: "Table",
          mutationId: "00000000-0000-4000-8000-000000000003",
          state: {
            setup: null,
            game: null,
            hostPlayerId: null,
            hostName: null,
            playlistId: "PL",
            log: [],
            undoHistory: [],
            undoBudget: 0,
            initialGame: null,
            events: [],
            headEventId: null,
            resetReturnEventId: null,
            legacyLog: [],
          },
          results: null,
        },
        clubId,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ApiError);
    if (!(failure instanceof ApiError)) throw new Error("Expected an API error");
    expect(failure).toMatchObject({
      status: 400,
      code: "validation_failed",
      details: {
        issues: [
          { path: "results.hostPlayerId", message: "Invalid value" },
          { path: "state.undoHistory", message: "Invalid value" },
          { path: "state.game", message: "Invalid value" },
          { path: "results", message: "Invalid value" },
          ...Array.from({ length: 6 }, () => safeIssue),
        ],
      },
    });
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain(privateSentinel);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("credentials");
  });

  it("bounds the validation issue scan before retaining diagnostics", async () => {
    const privateSentinel = "must-not-scan-unbounded-validation-values";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "validation_failed",
            issues: [
              { path: ["results", "hostPlayerId"], message: privateSentinel },
              ...Array.from({ length: 99 }, () => ({
                path: ["unrecognized", privateSentinel],
                message: privateSentinel,
              })),
              { path: ["results", "hostPlayerId"], message: privateSentinel },
            ],
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    let failure: unknown;
    try {
      await checkServerReady();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ApiError);
    if (!(failure instanceof ApiError)) throw new Error("Expected an API error");
    expect(failure.details).toEqual({
      issues: [{ path: "results.hostPlayerId", message: "Invalid value" }],
    });
    expect(JSON.stringify(failure)).not.toContain(privateSentinel);
  });

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
    const clubId = "00000000-0000-4000-8000-000000000101";
    const state = {
      setup: null,
      game: null,
      hostPlayerId: null,
      hostName: null,
      playlistId: "PL",
      log: [],
      undoHistory: [],
      undoBudget: 0,
      initialGame: null,
      events: [],
      headEventId: null,
      resetReturnEventId: null,
      legacyLog: [],
    };
    const operation = {
      kind: "snapshot" as const,
      name: "Table",
      mutationId: "00000000-0000-4000-8000-000000000003",
      state,
      results: null,
    };
    const response = { revision: 1, duplicate: false, name: "Table" };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveGameSessionOperation(gameId, operation, clubId)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/game-sessions/${gameId}`,
      expect.objectContaining({
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-club-id": clubId,
        },
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
    const clubId = "00000000-0000-4000-8000-000000000101";
    const state = {
      setup: null,
      game: null,
      hostPlayerId: null,
      hostName: null,
      playlistId: "PL",
      log: [],
      undoHistory: [],
      undoBudget: 0,
      initialGame: null,
      events: [],
      headEventId: null,
      resetReturnEventId: null,
      legacyLog: [],
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
    const session = { ...summary, duplicate: false, status: "active", state, results: null };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(session), {
          status: 200,
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
      state,
      results: null,
    };

    await expect(
      saveGameSessionOperation(gameId, { ...mutation, kind: "snapshot" }, clubId),
    ).resolves.toEqual(session);
    await expect(listActiveGameSessions()).resolves.toEqual([summary]);
    await expect(getGameSession(gameId)).resolves.toEqual(session);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/game-sessions/${gameId}`,
      expect.objectContaining({
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-club-id": clubId,
        },
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

const clubId = "00000000-0000-4000-8000-000000000001";
const gameId = "00000000-0000-4000-8000-000000000002";
const creationId = "00000000-0000-4000-8000-000000000003";
const mutationId = "00000000-0000-4000-8000-000000000004";
const state = {
  setup: null,
  game: null,
  hostPlayerId: null,
  hostName: null,
  playlistId: "",
  log: [],
  undoHistory: [],
  undoBudget: 0,
  initialGame: null,
  events: [],
  headEventId: null,
  resetReturnEventId: null,
  legacyLog: [],
};

const remote = {
  gameId,
  name: "Table A",
  status: "active" as const,
  rulesetId: "classic",
  rulesetVersion: 1,
  revision: 1,
  duplicate: false,
  createdAt: "2026-09-26T20:00:00.000Z",
  updatedAt: "2026-09-26T20:00:00.000Z",
  state,
  results: null,
};

describe("statistics and tournament API client", () => {
  it("scopes reads, creation and paginated statistics to the selected club", async () => {
    const tournament = { id: creationId, name: "Autumn" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tournaments: [tournament] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tournament })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ players: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ history: [] })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listTournaments(clubId)).resolves.toEqual([tournament]);
    await expect(createTournament("Autumn", clubId)).resolves.toEqual(tournament);
    await getClubStatistics(clubId, { tournamentId: "none", edition: "legacy" });
    await getPlayerStatistics(gameId, clubId, { role: "don" }, { cursor: "a+b/", limit: 25 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/tournaments",
      "/api/tournaments",
      "/api/statistics?edition=legacy&tournamentId=none",
      `/api/statistics/players/${gameId}?role=don&cursor=a%2Bb%2F&limit=25`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toMatchObject({ "x-club-id": clubId });
    }
  });

  it.each([creationId, null])(
    "confirms explicit assignment %s only after exact game readback",
    async (tournamentId) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ tournamentId })))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ session: { ...remote, tournamentId } })),
        );
      vi.stubGlobal("fetch", fetchMock);
      await expect(assignGameTournament(gameId, tournamentId, clubId)).resolves.toBe(tournamentId);
      expect(fetchMock.mock.calls[0]).toEqual([
        `/api/game-sessions/${gameId}/tournament`,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ tournamentId }),
          headers: { "content-type": "application/json", "x-club-id": clubId },
        }),
      ]);
      expect(fetchMock.mock.calls[1]).toEqual([
        `/api/game-sessions/${gameId}`,
        expect.objectContaining({ cache: "no-store", headers: { "x-club-id": clubId } }),
      ]);
    },
  );

  it.each([
    { ...remote, tournamentId: null },
    { ...remote, gameId: creationId, tournamentId: creationId },
    remote,
  ])("does not confirm mismatched, absent or wrong-target metadata", async (session) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ tournamentId: creationId })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ session }))),
    );
    await expect(assignGameTournament(gameId, creationId, clubId)).rejects.toThrow();
  });
});

describe("game-session record client", () => {
  it("creates with a stable creation ID and no client game GUID", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(remote), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createGameSession({ creationId, name: "Table A", state, results: null }, clubId),
    ).resolves.toEqual(remote);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/game-sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-club-id": clubId }),
        body: JSON.stringify({ creationId, name: "Table A", state, results: null }),
      }),
    );
  });

  it("updates a server GUID without revision prerequisites or ownership headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(remote)));
    vi.stubGlobal("fetch", fetchMock);

    await saveGameSessionOperation(
      gameId,
      { kind: "snapshot", name: "Table A", mutationId, state, results: null },
      clubId,
    );

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request.method).toBe("PUT");
    expect(request.headers).toEqual(expect.objectContaining({ "x-club-id": clubId }));
    expect(request.body).toBe(
      JSON.stringify({ name: "Table A", mutationId, state, results: null }),
    );
  });

  it("deletes directly by server GUID and surfaces a rejected request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(clearGameSession(gameId, clubId)).resolves.toBeUndefined();
    await expect(clearGameSession(gameId, clubId)).rejects.toEqual(expect.any(ApiError));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/game-sessions/${gameId}`);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "x-club-id": clubId }),
      }),
    );
  });
});
