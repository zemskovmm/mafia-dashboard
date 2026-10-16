import {
  sanitizeHistoryDiagnostic,
  type GameLogEntry,
  type HistoryDiagnostic,
  type InitialGameBaseline,
  type ClubTournament,
  type ClubStatisticsResponse,
  type PlayerStatisticsResponse,
  type StatisticsFilters,
  type StatisticsHistoryPage,
} from "@mafia/game-domain";

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
  readonly clubAccess: "none" | "user" | "manager";
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
  readonly language: "en" | "ru";
  readonly bestMoveEnabled: boolean;
}

export interface ClubInput extends ClubDetails {
  readonly ownerConsent: true;
}

export type ClubUpdateInput = ClubDetails;

export interface Club extends ClubDetails {
  readonly id: string;
  readonly role: "manager" | "user";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PlayerProfileInput =
  | {
      readonly nickname: string;
      readonly consent: false;
      readonly clubAccess: "none";
      readonly firstName: null;
      readonly lastName: null;
      readonly email: null;
    }
  | {
      readonly nickname: string;
      readonly consent: false;
      readonly clubAccess: "manager";
      readonly firstName: null;
      readonly lastName: null;
      readonly email: null;
    }
  | {
      readonly nickname: string;
      readonly consent: true;
      readonly clubAccess: "none" | "user" | "manager";
      readonly firstName: string;
      readonly lastName: string;
      readonly email: string;
    };

export interface FinalGameResults {
  readonly hostPlayerId: string;
  readonly outcome: "red" | "black" | "draw" | "cancelled";
  readonly winner: "red" | "black" | null;
  readonly reason: string | null;
  readonly playedAt: string;
  /** Referee ruling retained in authoritative JSON, not the win reason projection. */
  readonly adjudication?: {
    readonly losingTeam: "red" | "black";
    readonly offenderSeat?: number;
    readonly rule: string;
    readonly reason: string;
    readonly committeeApproved: boolean;
  };
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
  /** Older empty snapshots may contain null; current saves omit this field. */
  readonly hostName?: null;
  readonly playlistId: string;
  readonly log: readonly unknown[];
  readonly undoHistory: readonly unknown[];
  readonly undoBudget: number;
  readonly initialGame: InitialGameBaseline | null;
  readonly events: readonly GameLogEntry[];
  readonly headEventId: string | null;
  readonly resetReturnEventId: string | null;
  readonly legacyLog: readonly unknown[];
}

export type CurrentGameSessionState = GameSessionState;

export interface GameSessionOperation {
  readonly kind: "snapshot";
  readonly name: string;
  readonly mutationId: string;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}

export interface GameSessionCreation {
  readonly creationId: string;
  readonly tournamentId?: string | null;
  readonly name: string;
  readonly state: CurrentGameSessionState;
  readonly results: FinalGameResults | null;
}

export interface ActiveGameSessionSummary {
  readonly gameId: string;
  readonly tournamentId?: string | null;
  readonly name: string;
  readonly revision: number;
  readonly hostPlayerId: string | null;
  readonly phase: string;
  readonly day: number;
  readonly updatedAt: string;
}

export interface RemoteGameSession {
  readonly gameId: string;
  readonly tournamentId?: string | null;
  readonly name: string;
  readonly revision: number;
  readonly duplicate: boolean;
  readonly status: "active" | "completed";
  readonly rulesetId: string;
  readonly rulesetVersion: number;
  readonly updatedAt: string;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}

export interface CompletedGameSessionSummary {
  readonly gameId: string;
  readonly tournamentId?: string | null;
  readonly name: string;
  readonly revision: number;
  readonly hostPlayerId: string | null;
  readonly outcome: "red" | "black" | "draw" | "cancelled";
  readonly winner: "red" | "black" | null;
  readonly reason: string | null;
  readonly rulesetId: string;
  readonly rulesetVersion: number;
  readonly playedAt: string;
  readonly day: number;
  readonly eventCount: number;
  readonly updatedAt: string;
}

export interface CompletedGameSessionFilters {
  readonly from?: string;
  readonly to?: string;
  readonly playerId?: string;
  readonly outcome?: "red" | "black" | "draw" | "cancelled";
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
    public readonly details: unknown | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const validationIssuePaths = [
  "name",
  "mutationId",
  "state.game",
  "state.game.voteAssignments",
  "state.log",
  "state.undoHistory",
  "state.initialGame",
  "state.events",
  "state.legacyLog",
  "state.headEventId",
  "results",
  "results.hostPlayerId",
] as const;
const secretValidationPaths = new Set<ApiValidationPath>([
  "state.events",
  "state.log",
  "state.undoHistory",
  "state.initialGame",
  "state.legacyLog",
]);
const genericValidationReason = "Invalid value";
const finalVoteAssignmentReason =
  "The final voting candidate must receive every remaining active vote";
const maximumValidationIssueCandidates = 100;
const maximumValidationIssues = 10;

export type ApiValidationPath = (typeof validationIssuePaths)[number];
export type ApiValidationReason = typeof genericValidationReason | typeof finalVoteAssignmentReason;
export interface ApiValidationIssue {
  readonly path: ApiValidationPath;
  readonly message: ApiValidationReason;
  readonly diagnostic?: HistoryDiagnostic;
}

export interface ApiValidationDetails {
  readonly issues: readonly ApiValidationIssue[];
}

const isValidationPath = (value: string): value is ApiValidationPath =>
  (validationIssuePaths as readonly string[]).includes(value);

const safeValidationPath = (
  value: unknown,
): { readonly path: ApiValidationPath; readonly generic: boolean } | null => {
  if (typeof value === "string") {
    return isValidationPath(value)
      ? { path: value, generic: secretValidationPaths.has(value) }
      : null;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;

  if (value[0] === "state" && typeof value[1] === "string") {
    const path = `state.${value[1]}`;
    if (secretValidationPaths.has(path as ApiValidationPath)) {
      return { path: path as ApiValidationPath, generic: true };
    }
  }

  const segments: string[] = [];
  for (const segment of value) {
    if (typeof segment !== "string") break;
    segments.push(segment);
  }
  for (let length = segments.length; length > 0; length -= 1) {
    const path = segments.slice(0, length).join(".");
    if (isValidationPath(path)) return { path, generic: path !== segments.join(".") };
  }

  return null;
};

const safeValidationReason = (value: unknown): ApiValidationReason =>
  value === finalVoteAssignmentReason ? finalVoteAssignmentReason : genericValidationReason;

export const sanitizeApiValidationIssues = (value: unknown): readonly ApiValidationIssue[] => {
  if (!Array.isArray(value)) return Object.freeze([]);

  const issues: ApiValidationIssue[] = [];
  for (const candidate of value.slice(0, maximumValidationIssueCandidates)) {
    if (issues.length === maximumValidationIssues) break;
    if (typeof candidate !== "object" || candidate === null) continue;
    const issue = candidate as Record<string, unknown>;
    const validationPath = safeValidationPath(issue.path);
    if (validationPath === null) continue;
    const diagnostic = ["state.events", "state.initialGame", "state.headEventId"].includes(
      validationPath.path,
    )
      ? sanitizeHistoryDiagnostic(issue.diagnostic)
      : null;
    issues.push(
      Object.freeze({
        path: validationPath.path,
        ...(diagnostic === null ? {} : { diagnostic }),
        message: validationPath.generic
          ? genericValidationReason
          : safeValidationReason(issue.message),
      }),
    );
  }

  return Object.freeze(issues);
};

const safeErrorCode = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : null;

const safeValidationDetails = (value: unknown): ApiValidationDetails | null => {
  const issues = sanitizeApiValidationIssues(value);
  return issues.length === 0 ? null : { issues };
};

const throwApiError = async (response: Response, message: string): Promise<never> => {
  let code: string | null = null;
  let details: unknown | null = null;
  try {
    const body = (await response.json()) as {
      error?: unknown;
      issues?: unknown;
    };
    code = safeErrorCode(body.error);
    if (code === "validation_failed") details = safeValidationDetails(body.issues);
  } catch {
    // Non-JSON failures still retain their HTTP status.
  }
  throw new ApiError(message, response.status, code, details);
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

export const getAppVersion = async (): Promise<string> => {
  const response = await fetch("/health/version", { cache: "no-store" });
  if (!response.ok) return throwApiError(response, "Unable to load app version");
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid app version response");
  }
  const { version, commit } = body as Record<string, unknown>;
  if (typeof version !== "string" || typeof commit !== "string") {
    throw new Error("Invalid app version response");
  }
  const components = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version);
  if (
    components === null ||
    components.slice(1).some((value) => !Number.isSafeInteger(Number(value)))
  ) {
    throw new Error("Invalid app version response");
  }
  return version;
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

export const createGameSession = async (
  input: GameSessionCreation,
  clubId?: string,
): Promise<RemoteGameSession> => {
  const response = await fetchPersistenceRequest("/api/game-sessions", {
    method: "POST",
    headers: clubHeaders(clubId, true),
    body: JSON.stringify(input),
  });
  if (!response.ok) return throwApiError(response, "Unable to create the game session");
  return (await response.json()) as RemoteGameSession;
};

export const saveGameSessionOperation = async (
  gameId: string,
  operation: GameSessionOperation,
  clubId?: string,
): Promise<RemoteGameSession> => {
  const { state } = operation;
  const response = await fetchPersistenceRequest(`/api/game-sessions/${gameId}`, {
    method: "PUT",
    headers: clubHeaders(clubId, true),
    body: JSON.stringify({
      name: operation.name,
      mutationId: operation.mutationId,
      state: {
        setup: state.setup,
        game: state.game,
        hostPlayerId: state.hostPlayerId,
        hostName: state.hostName,
        playlistId: state.playlistId,
        log: state.log,
        undoHistory: state.undoHistory,
        undoBudget: state.undoBudget,
        initialGame: state.initialGame,
        events: state.events,
        headEventId: state.headEventId,
        resetReturnEventId: state.resetReturnEventId,
        legacyLog: state.legacyLog,
      },
      results: operation.results,
    }),
  });
  if (!response.ok) return throwApiError(response, "Unable to save the game session operation");
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

export const listCompletedGameSessions = async (
  clubId?: string,
  filters: CompletedGameSessionFilters = {},
): Promise<readonly CompletedGameSessionSummary[]> => {
  const query = new URLSearchParams({ status: "completed" });
  if (filters.from !== undefined) query.set("from", filters.from);
  if (filters.to !== undefined) query.set("to", filters.to);
  if (filters.playerId !== undefined) query.set("playerId", filters.playerId);
  if (filters.outcome !== undefined) query.set("outcome", filters.outcome);
  const response = await fetch(`/api/game-sessions?${query}`, {
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

export const listTournaments = async (clubId: string): Promise<readonly ClubTournament[]> => {
  const response = await fetch("/api/tournaments", { headers: clubHeaders(clubId) });
  if (!response.ok) return throwApiError(response, "Unable to load tournaments");
  return ((await response.json()) as { tournaments: readonly ClubTournament[] }).tournaments;
};

export const createTournament = async (name: string, clubId: string): Promise<ClubTournament> => {
  const response = await fetchPersistenceRequest("/api/tournaments", {
    method: "POST",
    headers: clubHeaders(clubId, true),
    body: JSON.stringify({ name }),
  });
  if (!response.ok) return throwApiError(response, "Unable to create tournament");
  return ((await response.json()) as { tournament: ClubTournament }).tournament;
};

/** An acknowledgment alone is not confirmation: inspect this exact game's metadata. */
export const assignGameTournament = async (
  gameId: string,
  tournamentId: string | null,
  clubId: string,
): Promise<string | null> => {
  const response = await fetchPersistenceRequest(
    `/api/game-sessions/${encodeURIComponent(gameId)}/tournament`,
    {
      method: "PUT",
      headers: clubHeaders(clubId, true),
      body: JSON.stringify({ tournamentId }),
    },
  );
  if (!response.ok) return throwApiError(response, "Unable to assign tournament");
  const readback = await fetchPersistenceRequest(
    `/api/game-sessions/${encodeURIComponent(gameId)}`,
    {
      headers: clubHeaders(clubId),
      cache: "no-store",
    },
  );
  if (!readback.ok) return throwApiError(readback, "Unable to confirm tournament assignment");
  const { session } = (await readback.json()) as { session: RemoteGameSession };
  if (session?.gameId !== gameId || session.tournamentId !== tournamentId) {
    throw new Error("Tournament assignment has not been confirmed");
  }
  return tournamentId;
};

const statisticsQuery = (filters: StatisticsFilters, page: StatisticsHistoryPage = {}): string => {
  const query = new URLSearchParams();
  for (const key of ["from", "to", "edition", "team", "role", "tournamentId"] as const) {
    const value = filters[key];
    if (value !== undefined) query.set(key, value);
  }
  if (page.cursor !== undefined) query.set("cursor", page.cursor);
  if (page.limit !== undefined) query.set("limit", String(page.limit));
  return query.size === 0 ? "" : `?${query}`;
};

export const getClubStatistics = async (
  clubId: string,
  filters: StatisticsFilters = {},
): Promise<ClubStatisticsResponse> => {
  const response = await fetch(`/api/statistics${statisticsQuery(filters)}`, {
    headers: clubHeaders(clubId),
  });
  if (!response.ok) return throwApiError(response, "Unable to load statistics");
  return (await response.json()) as ClubStatisticsResponse;
};

export const getPlayerStatistics = async (
  playerId: string,
  clubId: string,
  filters: StatisticsFilters = {},
  page: StatisticsHistoryPage = {},
): Promise<PlayerStatisticsResponse> => {
  const response = await fetch(
    `/api/statistics/players/${encodeURIComponent(playerId)}${statisticsQuery(filters, page)}`,
    {
      headers: clubHeaders(clubId),
    },
  );
  if (!response.ok) return throwApiError(response, "Unable to load player statistics");
  return (await response.json()) as PlayerStatisticsResponse;
};

export const clearGameSession = async (gameId: string, clubId?: string): Promise<void> => {
  const response = await fetch(`/api/game-sessions/${gameId}`, {
    method: "DELETE",
    headers: clubHeaders(clubId),
  });
  if (!response.ok) return throwApiError(response, "Unable to clear the game session");
};
