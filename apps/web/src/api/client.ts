import type { GameLogEntry, InitialGameBaseline } from "@mafia/game-domain";

interface PlayerStatistics {
  readonly hostedGames: number;
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly losses: number;
  readonly redGames: number;
  readonly redWins: number;
  readonly blackGames: number;
  readonly blackWins: number;
  readonly sheriffGames: number;
  readonly citizenGames: number;
  readonly mafiaGames: number;
  readonly donGames: number;
  readonly totalFouls: number;
  readonly eliminations: number;
  readonly redCards: number;
  readonly bestMoves: number;
  readonly bestMoveMafiaHits: number;
}

export interface PlayerProfile {
  readonly id: string;
  readonly nickname: string;
  readonly consent: boolean;
  readonly clubManager: boolean;
  readonly managerLocked: boolean;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly consentAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastPlayedAt: string | null;
  readonly statistics: PlayerStatistics;
}

export interface AppUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly picture: string | null;
}

export interface AuthSession {
  readonly configured: boolean;
  readonly user: AppUser | null;
}

interface ClubDetails {
  readonly name: string;
  readonly city: string;
  readonly headerLogo: string | null;
  readonly cardLogo: string | null;
}

export interface ClubInput extends ClubDetails {
  readonly ownerConsent: true;
}

export type ClubUpdateInput = ClubDetails;

export interface Club extends ClubDetails {
  readonly id: string;
  readonly role: "owner" | "editor";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PlayerProfileInput =
  | {
      readonly nickname: string;
      readonly consent: false;
      readonly clubManager: false;
      readonly firstName: null;
      readonly lastName: null;
      readonly email: null;
    }
  | {
      readonly nickname: string;
      readonly consent: false;
      readonly clubManager: true;
      readonly firstName: null;
      readonly lastName: null;
      readonly email: null;
    }
  | {
      readonly nickname: string;
      readonly consent: true;
      readonly clubManager: boolean;
      readonly firstName: string;
      readonly lastName: string;
      readonly email: string;
    };

export interface FinalGameResults {
  readonly hostPlayerId: string;
  readonly winner: "red" | "black";
  readonly playedAt: string;
  readonly players: readonly {
    readonly playerId: string;
    readonly seat: number;
    readonly role: "sheriff" | "citizen" | "mafia" | "don";
    readonly team: "red" | "black";
    readonly status: "active" | "eliminated" | "red-carded";
    readonly fouls: number;
    readonly bestMoveHits: number | null;
  }[];
}

export interface GameSessionState {
  readonly setup: unknown | null;
  readonly game: unknown | null;
  readonly hostPlayerId: string | null;
  readonly hostName: string | null;
  readonly playlistId: string;
  readonly log: readonly unknown[];
  readonly undoHistory: readonly unknown[];
  readonly initialGame?: InitialGameBaseline | null;
  readonly events?: readonly GameLogEntry[];
  readonly headEventId?: string | null;
  readonly resetReturnEventId?: string | null;
  readonly legacyLog?: readonly unknown[];
}

export interface GameSessionMutation {
  readonly name: string;
  readonly mutationId: string;
  readonly baseRevision: number;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}

export interface SessionMetadata {
  readonly setup: unknown | null;
  readonly hostPlayerId: string | null;
  readonly hostName: string | null;
  readonly playlistId: string;
  readonly legacyLog: readonly unknown[];
}

interface GameSessionOperationBase {
  readonly name: string;
  readonly mutationId: string;
  readonly baseRevision: number;
}

export type GameSessionOperation =
  | (GameSessionOperationBase & {
      readonly kind: "metadata";
      readonly metadata: SessionMetadata;
    })
  | (GameSessionOperationBase & { readonly kind: "normalize" })
  | (GameSessionOperationBase & {
      readonly kind: "start";
      readonly baseline: InitialGameBaseline;
      readonly event: GameLogEntry;
    })
  | (GameSessionOperationBase & {
      readonly kind: "append-event";
      readonly event: GameLogEntry;
    })
  | (GameSessionOperationBase & {
      readonly kind: "move-head";
      readonly targetEventId: string;
      readonly reason: "undo" | "reset" | "restore-reset";
    })
  | (GameSessionOperationBase & {
      readonly kind: "complete";
      readonly results: FinalGameResults;
    });

export interface GameSessionOperationResponse {
  readonly revision: number;
  readonly duplicate: boolean;
  readonly name?: string;
  readonly gameId?: string;
  readonly state?: GameSessionState;
  readonly results?: FinalGameResults | null;
}

export interface ActiveGameSessionSummary {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly hostName: string | null;
  readonly phase: string;
  readonly day: number;
  readonly updatedAt: string;
}

export interface RemoteGameSession {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly duplicate: boolean;
  readonly status: "active" | "completed";
  readonly updatedAt: string;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}

export interface CompletedGameSessionSummary {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly hostName: string | null;
  readonly winner: "red" | "black";
  readonly playedAt: string;
  readonly day: number;
  readonly eventCount: number;
  readonly updatedAt: string;
}

export interface GameEventRecord {
  readonly id: string;
  readonly gameId: string;
  readonly sequence: number;
  readonly parentEventId?: string | null;
  readonly type: string;
  readonly phase: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface MusicAccountStatus {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly accountLabel: string | null;
}

export interface MusicPlaylist {
  readonly id: string;
  readonly title: string;
  readonly itemCount: number;
  readonly thumbnailUrl: string | null;
}

export interface MusicPlaylistItem {
  readonly videoId: string;
  readonly title: string;
  readonly position: number;
  readonly thumbnailUrl: string | null;
}

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const throwApiError = async (response: Response, message: string): Promise<never> => {
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
  } catch {
    // Non-JSON failures still retain their HTTP status.
  }
  throw new ApiError(message, response.status, code);
};

const clubHeaders = (clubId: string | undefined, json = false): HeadersInit => ({
  ...(json ? { "content-type": "application/json" } : {}),
  ...(clubId === undefined ? {} : { "x-club-id": clubId }),
});

const persistenceRequestTimeoutMs = 4_000;
const fetchPersistenceRequest = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), persistenceRequestTimeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
};

export const checkServerReady = async (): Promise<void> => {
  const response = await fetchPersistenceRequest("/health/ready");
  if (!response.ok) return throwApiError(response, "Server is not ready");
};

export const getAuthSession = async (): Promise<AuthSession> => {
  const response = await fetch("/api/auth/session");
  if (!response.ok) return throwApiError(response, "Unable to load the sign-in session");
  return (await response.json()) as AuthSession;
};

export const signOut = async (): Promise<void> => {
  const response = await fetch("/api/auth/session", { method: "DELETE" });
  if (!response.ok) return throwApiError(response, "Unable to sign out");
};

export const listClubs = async (): Promise<readonly Club[]> => {
  const response = await fetch("/api/clubs");
  if (!response.ok) return throwApiError(response, "Unable to load clubs");
  return ((await response.json()) as { clubs: readonly Club[] }).clubs;
};

export const createClub = async (input: ClubInput): Promise<Club> => {
  const response = await fetch("/api/clubs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) return throwApiError(response, "Unable to create club");
  return ((await response.json()) as { club: Club }).club;
};

export const updateClub = async (clubId: string, input: ClubUpdateInput): Promise<Club> => {
  const response = await fetch(`/api/clubs/${clubId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) return throwApiError(response, "Unable to update club");
  return ((await response.json()) as { club: Club }).club;
};

export const deleteClub = async (clubId: string): Promise<void> => {
  const response = await fetch(`/api/clubs/${clubId}`, {
    method: "DELETE",
  });
  if (!response.ok) return throwApiError(response, "Unable to delete club");
};

export const getMusicAccountStatus = async (): Promise<MusicAccountStatus> => {
  const response = await fetch("/api/music/oauth/status");
  if (!response.ok) return throwApiError(response, "Unable to load music account status");
  return (await response.json()) as MusicAccountStatus;
};

export const listMusicPlaylists = async (): Promise<readonly MusicPlaylist[]> => {
  const response = await fetch("/api/music/playlists");
  if (!response.ok) return throwApiError(response, "Unable to load account playlists");
  const body = (await response.json()) as { playlists: readonly MusicPlaylist[] };
  return body.playlists;
};

export const listMusicPlaylistItems = async (
  playlistId: string,
): Promise<readonly MusicPlaylistItem[]> => {
  const response = await fetch(`/api/music/playlists/${encodeURIComponent(playlistId)}/items`);
  if (!response.ok) return throwApiError(response, "Unable to load playlist queue");
  const body = (await response.json()) as { items: readonly MusicPlaylistItem[] };
  return body.items;
};

export const disconnectMusicAccount = async (): Promise<void> => {
  const response = await fetch("/api/music/oauth/connection", { method: "DELETE" });
  if (!response.ok) return throwApiError(response, "Unable to disconnect music account");
};

export const listPlayers = async (clubId?: string): Promise<readonly PlayerProfile[]> => {
  const response = await fetch("/api/players", { headers: clubHeaders(clubId) });
  if (!response.ok) return throwApiError(response, "Unable to load players");
  const body = (await response.json()) as { players: readonly PlayerProfile[] };
  return body.players;
};

export const createPlayer = async (
  input: PlayerProfileInput,
  clubId?: string,
): Promise<PlayerProfile> => {
  const response = await fetch("/api/players", {
    method: "POST",
    headers: clubHeaders(clubId, true),
    body: JSON.stringify(input),
  });
  if (!response.ok) return throwApiError(response, "Unable to create player");
  const body = (await response.json()) as { player: PlayerProfile };
  return body.player;
};

export const updatePlayer = async (
  playerId: string,
  input: PlayerProfileInput,
  clubId?: string,
): Promise<PlayerProfile> => {
  const response = await fetch(`/api/players/${playerId}`, {
    method: "PUT",
    headers: clubHeaders(clubId, true),
    body: JSON.stringify(input),
  });
  if (!response.ok) return throwApiError(response, "Unable to update player");
  const body = (await response.json()) as { player: PlayerProfile };
  return body.player;
};

export const deletePlayer = async (playerId: string, clubId?: string): Promise<void> => {
  const response = await fetch(`/api/players/${playerId}`, {
    method: "DELETE",
    headers: clubHeaders(clubId),
  });
  if (!response.ok) return throwApiError(response, "Unable to delete player");
};

export const saveGameSession = async (
  gameId: string,
  mutation: GameSessionMutation,
  clubId?: string,
): Promise<RemoteGameSession> => {
  const response = await fetchPersistenceRequest(`/api/game-sessions/${gameId}`, {
    method: "PUT",
    headers: clubHeaders(clubId, true),
    body: JSON.stringify(mutation),
  });
  if (!response.ok) return throwApiError(response, "Unable to save the game session");
  return (await response.json()) as RemoteGameSession;
};

export const saveGameSessionOperation = async (
  gameId: string,
  operation: GameSessionOperation,
  clubId?: string,
): Promise<GameSessionOperationResponse> => {
  const request = (() => {
    const base = {
      mutationId: operation.mutationId,
      baseRevision: operation.baseRevision,
    };
    switch (operation.kind) {
      case "metadata":
        return {
          url: `/api/game-sessions/${gameId}`,
          method: "PUT",
          body: {
            name: operation.name,
            ...base,
            state: {
              setup: operation.metadata.setup,
              game: null,
              hostPlayerId: operation.metadata.hostPlayerId,
              hostName: operation.metadata.hostName,
              playlistId: operation.metadata.playlistId,
              log: operation.metadata.legacyLog,
              undoHistory: [],
              legacyLog: operation.metadata.legacyLog,
            },
            results: null,
          },
        } as const;
      case "normalize":
        return {
          url: `/api/game-sessions/${gameId}/normalize`,
          method: "POST",
          body: base,
        } as const;
      case "start":
        return {
          url: `/api/game-sessions/${gameId}/start`,
          method: "POST",
          body: { ...base, initialGame: operation.baseline, event: operation.event },
        } as const;
      case "append-event":
        return {
          url: `/api/game-sessions/${gameId}/events`,
          method: "POST",
          body: { ...base, event: operation.event },
        } as const;
      case "move-head":
        return {
          url: `/api/game-sessions/${gameId}/head`,
          method: "POST",
          body: { ...base, targetEventId: operation.targetEventId, reason: operation.reason },
        } as const;
      case "complete":
        return {
          url: `/api/game-sessions/${gameId}/complete`,
          method: "POST",
          body: { ...base, results: operation.results },
        } as const;
    }
  })();
  const response = await fetchPersistenceRequest(request.url, {
    method: request.method,
    headers: clubHeaders(clubId, true),
    body: JSON.stringify(request.body),
  });
  if (!response.ok) return throwApiError(response, "Unable to save the game session operation");
  return (await response.json()) as GameSessionOperationResponse;
};

export const listActiveGameSessions = async (
  clubId?: string,
): Promise<readonly ActiveGameSessionSummary[]> => {
  const response = await fetch("/api/game-sessions", { headers: clubHeaders(clubId) });
  if (!response.ok) return throwApiError(response, "Unable to load active game sessions");
  const body = (await response.json()) as { sessions: readonly ActiveGameSessionSummary[] };
  return body.sessions;
};

export const listCompletedGameSessions = async (
  clubId?: string,
): Promise<readonly CompletedGameSessionSummary[]> => {
  const response = await fetch("/api/game-sessions?status=completed", {
    headers: clubHeaders(clubId),
  });
  if (!response.ok) return throwApiError(response, "Unable to load completed game sessions");
  return ((await response.json()) as { sessions: readonly CompletedGameSessionSummary[] }).sessions;
};

export const getGameEvents = async (
  gameId: string,
  clubId?: string,
  visibility: "host" | "public" = "host",
): Promise<readonly GameEventRecord[]> => {
  const response = await fetch(
    `/api/games/${gameId}/events?visibility=${encodeURIComponent(visibility)}`,
    { headers: clubHeaders(clubId) },
  );
  if (!response.ok) return throwApiError(response, "Unable to load the game event history");
  return ((await response.json()) as { events: readonly GameEventRecord[] }).events;
};

export const getGameSession = async (
  gameId: string,
  clubId?: string,
): Promise<RemoteGameSession> => {
  const response = await fetch(`/api/game-sessions/${gameId}`, { headers: clubHeaders(clubId) });
  if (!response.ok) return throwApiError(response, "Unable to restore the game session");
  const body = (await response.json()) as { session: RemoteGameSession };
  return body.session;
};

export const clearGameSession = async (
  gameId: string,
  expectedRevision: number,
  clubId?: string,
): Promise<void> => {
  const response = await fetch(
    `/api/game-sessions/${gameId}?expectedRevision=${encodeURIComponent(expectedRevision)}`,
    { method: "DELETE", headers: clubHeaders(clubId) },
  );
  if (!response.ok) return throwApiError(response, "Unable to clear the game session");
};
