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

export interface ClubInput {
  readonly name: string;
  readonly city: string;
  readonly headerLogo: string | null;
  readonly cardLogo: string | null;
}

export interface Club extends ClubInput {
  readonly id: string;
  readonly role: "owner" | "editor";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PlayerProfileInput =
  | {
      readonly nickname: string;
      readonly consent: false;
      readonly firstName: null;
      readonly lastName: null;
      readonly email: null;
    }
  | {
      readonly nickname: string;
      readonly consent: true;
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
}

export interface GameSessionMutation {
  readonly name: string;
  readonly mutationId: string;
  readonly baseRevision: number;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
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

export const updateClub = async (clubId: string, input: ClubInput): Promise<Club> => {
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
  const response = await fetch(`/api/game-sessions/${gameId}`, {
    method: "PUT",
    headers: clubHeaders(clubId, true),
    body: JSON.stringify(mutation),
  });
  if (!response.ok) return throwApiError(response, "Unable to save the game session");
  return (await response.json()) as RemoteGameSession;
};

export const listActiveGameSessions = async (
  clubId?: string,
): Promise<readonly ActiveGameSessionSummary[]> => {
  const response = await fetch("/api/game-sessions", { headers: clubHeaders(clubId) });
  if (!response.ok) return throwApiError(response, "Unable to load active game sessions");
  const body = (await response.json()) as { sessions: readonly ActiveGameSessionSummary[] };
  return body.sessions;
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
