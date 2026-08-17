export interface RemoteGameEvent {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
  readonly seat?: number;
  readonly payload: Record<string, unknown>;
  readonly secret: boolean;
  readonly createdAt: string;
}

export interface PlayerStatistics {
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
  readonly winner: "red" | "black";
  readonly playedAt: string;
  readonly players: readonly {
    readonly playerId: string;
    readonly seat: number;
    readonly role: "sheriff" | "citizen" | "mafia" | "don";
    readonly team: "red" | "black";
    readonly status: "active" | "eliminated" | "red-carded";
    readonly fouls: number;
  }[];
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

export const disconnectMusicAccount = async (): Promise<void> => {
  const response = await fetch("/api/music/oauth/connection", { method: "DELETE" });
  if (!response.ok) return throwApiError(response, "Unable to disconnect music account");
};

export const listPlayers = async (): Promise<readonly PlayerProfile[]> => {
  const response = await fetch("/api/players");
  if (!response.ok) return throwApiError(response, "Unable to load players");
  const body = (await response.json()) as { players: readonly PlayerProfile[] };
  return body.players;
};

export const createPlayer = async (input: PlayerProfileInput): Promise<PlayerProfile> => {
  const response = await fetch("/api/players", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) return throwApiError(response, "Unable to create player");
  const body = (await response.json()) as { player: PlayerProfile };
  return body.player;
};

export const updatePlayer = async (
  playerId: string,
  input: PlayerProfileInput,
): Promise<PlayerProfile> => {
  const response = await fetch(`/api/players/${playerId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) return throwApiError(response, "Unable to update player");
  const body = (await response.json()) as { player: PlayerProfile };
  return body.player;
};

export const saveGameResults = async (gameId: string, results: FinalGameResults): Promise<void> => {
  const response = await fetch(`/api/games/${gameId}/results`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(results),
  });
  if (!response.ok) return throwApiError(response, "Unable to save player statistics");
};

export const createRemoteGame = async (name: string): Promise<string> => {
  const response = await fetch("/api/games", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error("Unable to create the persisted game");
  const body = (await response.json()) as { gameId: string };
  return body.gameId;
};

export const appendRemoteEvent = async (
  gameId: string,
  event: {
    readonly idempotencyKey: string;
    readonly type: string;
    readonly phase: string;
    readonly seat?: number;
    readonly payload: Record<string, unknown>;
    readonly secret: boolean;
  },
): Promise<void> => {
  const response = await fetch(`/api/games/${gameId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error("Unable to persist the game event");
};

export const readRemoteLog = async (gameId: string): Promise<readonly RemoteGameEvent[]> => {
  const response = await fetch(`/api/games/${gameId}/events`);
  if (!response.ok) throw new Error("Unable to load the game log");
  const body = (await response.json()) as { events: readonly RemoteGameEvent[] };
  return body.events;
};
