import type {
  CurrentGameSessionState,
  FinalGameResults,
  GameSessionCreation,
  GameSessionState,
  RemoteGameSession,
} from "./api/client.js";
import { ApiError } from "./api/client.js";
import {
  assertGameLogEntry,
  createInitialGameBaseline,
  CURRENT_REPLAY_VERSION,
  replayGameLog,
  type GameLogEntry,
  type GameState,
  type InitialGameBaseline,
} from "@mafia/game-domain";
import { getActiveBranch } from "./features/game/game-history.js";
import {
  assertBrowserGameStorageGuard,
  type BrowserGameStorageGuard,
} from "./browser-game-storage-lock.js";

export interface GameSessionOperation {
  readonly kind: "snapshot";
  readonly name: string;
  readonly mutationId: string;
  readonly state: CurrentGameSessionState;
  readonly results: Readonly<Partial<FinalGameResults>> | null;
}

interface CurrentSession {
  readonly name: string;
  readonly state: CurrentGameSessionState;
  readonly results: Readonly<Partial<FinalGameResults>> | null;
}

export interface TournamentAssociation {
  readonly clubId: string;
  readonly gameId: string | null;
  readonly creationId: string | null;
  readonly confirmedTournamentId: string | null;
  readonly pending: { readonly intentId: string; readonly tournamentId: string | null } | null;
}

export interface CurrentGameSessionEnvelope {
  readonly version: 5;
  readonly clubId: string;
  readonly gameId: string | null;
  readonly creationId: string | null;
  readonly revision: number;
  readonly current: CurrentSession | null;
  readonly outbox: readonly GameSessionOperation[];
  readonly failed: boolean;
  readonly clearFailed: boolean;
  readonly clearingGameId: string | null;
  readonly removed: boolean;
  /** A v5 client-generated ID must be checked before it can be adopted. */
  readonly legacyGameId: string | null;
  readonly tournamentAssociation?: TournamentAssociation;
  /** Club-bound metadata only: never a historical gameplay snapshot. */
  readonly historicalTournaments?: readonly HistoricalTournamentIntent[];
}

interface HistoricalTournamentIntent {
  readonly gameId: string;
  readonly tournamentId: string | null;
  readonly intentId: string;
}

interface OutboxOptions {
  readonly storage: Storage;
  readonly storageGuard?: BrowserGameStorageGuard;
  readonly clubId?: string;
  readonly storageKey?: string;
  readonly createId: () => string;
  readonly create?: (input: GameSessionCreation) => Promise<RemoteGameSession>;
  /** Return only after exact-target server readback. */
  readonly assignTournament?: (
    gameId: string,
    tournamentId: string | null,
  ) => Promise<string | null>;
  readonly save: (
    gameId: string,
    operation: GameSessionOperation,
  ) => Promise<Pick<RemoteGameSession, "revision">>;
}

export const gameSessionStorageKey = "mafia-dashboard.game-session.v5";
const defaultClubId = "00000000-0000-4000-8000-000000000101";
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);
const isNullableUuid = (value: unknown): value is string | null => value === null || isUuid(value);
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Reject old structured identity copies, not free-text game titles or moderator reasons. */
const containsCopiedPlayerName = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsCopiedPlayerName);
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, "hostName") && value.hostName !== null) return true;
  const profileFields = ["name", "nickname", "firstName", "lastName", "email", "hostName"];
  const payload = value.payload;
  if (isRecord(payload) && profileFields.some((key) => Object.hasOwn(payload, key))) return true;
  if (
    (Object.hasOwn(value, "seat") &&
      (Object.hasOwn(value, "id") || Object.hasOwn(value, "playerId"))) ||
    Object.hasOwn(value, "playerId")
  ) {
    if (profileFields.some((key) => Object.hasOwn(value, key))) return true;
  }
  return Object.values(value).some(containsCopiedPlayerName);
};

/** Transport-shape refusal, never engine routing, stripping or resealing. */
const hasEngineSelector = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasEngineSelector);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      key === "rulesEdition" ||
      key === "rulesetId" ||
      key === "rulesetVersion" ||
      hasEngineSelector(child),
  );
};
const hasCurrentCanonicalShape = (state: Record<string, unknown>): boolean => {
  if (hasEngineSelector(state)) return false;
  if (
    state.initialGame !== null &&
    (!isRecord(state.initialGame) ||
      state.initialGame.replayVersion !== CURRENT_REPLAY_VERSION ||
      !isRecord(state.initialGame.game))
  )
    return false;
  if (!(
    Array.isArray(state.events) &&
    state.events.every(
      (entry: unknown) => isRecord(entry) && entry.replayVersion === CURRENT_REPLAY_VERSION,
    )
  ))
    return false;
  try {
    if (state.game !== null) {
      if (state.initialGame === null) return false;
      createInitialGameBaseline(state.game as GameState);
    }
    const entries: GameLogEntry[] = [];
    for (const entry of state.events) {
      assertGameLogEntry(entry);
      entries.push(entry);
    }
    if (state.initialGame === null)
      return (
        entries.length === 0 && state.headEventId === null && state.resetReturnEventId === null
      );
    const baseline = state.initialGame as InitialGameBaseline;
    replayGameLog(baseline, []);
    const ids = new Set(entries.map(({ id }) => id));
    if (new Set(entries.map(({ gameId }) => gameId)).size > 1) return false;
    if (
      (state.headEventId !== null &&
        (typeof state.headEventId !== "string" || !ids.has(state.headEventId))) ||
      (state.resetReturnEventId !== null &&
        (typeof state.resetReturnEventId !== "string" || !ids.has(state.resetReturnEventId)))
    )
      return false;
    const parents = new Set(entries.map(({ parentEventId }) => parentEventId));
    const validated = new Set<string>();
    // Validate abandoned branches too; never repair or rehash stored histories.
    for (const entry of entries) {
      if (!parents.has(entry.id)) {
        const branch = getActiveBranch(entries, entry.id);
        replayGameLog(baseline, branch);
        branch.forEach(({ id }) => validated.add(id));
      }
    }
    return ids.size === entries.length && validated.size === entries.length;
  } catch {
    return false;
  }
};

/** Current transport admission delegates canonical integrity to the domain. */
export const isCurrentGameSessionState = (value: unknown): value is CurrentGameSessionState =>
  isRecord(value) &&
  [
    "setup",
    "game",
    "hostPlayerId",
    "playlistId",
    "log",
    "undoHistory",
    "undoBudget",
    "initialGame",
    "events",
    "headEventId",
    "resetReturnEventId",
    "legacyLog",
  ].every((field) => Object.hasOwn(value, field)) &&
  (value.setup === null ||
    (isRecord(value.setup) &&
      (value.setup.step === "players" ||
        value.setup.step === "roles" ||
        value.setup.step === "music") &&
      (value.setup.hostPlayerId === undefined || typeof value.setup.hostPlayerId === "string") &&
      Array.isArray(value.setup.selectedPlayerIds) &&
      value.setup.selectedPlayerIds.every((id: unknown) => typeof id === "string") &&
      (value.setup.setup === null || isRecord(value.setup.setup)))) &&
  isNullableUuid(value.hostPlayerId) &&
  typeof value.playlistId === "string" &&
  Array.isArray(value.log) &&
  Array.isArray(value.legacyLog) &&
  Array.isArray(value.undoHistory) &&
  isNonNegativeInteger(value.undoBudget) &&
  value.undoBudget <= 3 &&
  Array.isArray(value.events) &&
  hasCurrentCanonicalShape(value) &&
  !containsCopiedPlayerName(value);

const isResults = (value: unknown): value is Readonly<Partial<FinalGameResults>> | null =>
  value === null ||
  (isRecord(value) && !containsCopiedPlayerName(value) && !hasEngineSelector(value));

const isCurrent = (value: unknown): value is CurrentSession =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isCurrentGameSessionState(value.state) &&
  isResults(value.results);

const isOperation = (value: unknown): value is GameSessionOperation =>
  isRecord(value) &&
  value.kind === "snapshot" &&
  typeof value.name === "string" &&
  isUuid(value.mutationId) &&
  isCurrentGameSessionState(value.state) &&
  isResults(value.results);

const emptyEnvelope = (clubId: string): CurrentGameSessionEnvelope => ({
  version: 5,
  clubId,
  gameId: null,
  creationId: null,
  revision: 0,
  current: null,
  outbox: [],
  failed: false,
  clearFailed: false,
  clearingGameId: null,
  removed: false,
  legacyGameId: null,
});

const isTournamentAssociation = (value: unknown, envelope: Record<string, unknown>): boolean =>
  isRecord(value) &&
  value.clubId === envelope.clubId &&
  value.gameId === envelope.gameId &&
  value.creationId === envelope.creationId &&
  (value.gameId === null
    ? isUuid(value.creationId)
    : isUuid(value.gameId) && value.creationId === null) &&
  isNullableUuid(value.confirmedTournamentId) &&
  (value.pending === null ||
    (isRecord(value.pending) &&
      isUuid(value.pending.intentId) &&
      isNullableUuid(value.pending.tournamentId)));

const normalizeEnvelope = (value: unknown): CurrentGameSessionEnvelope | null => {
  if (!isRecord(value) || !isUuid(value.clubId)) return null;

  if (value.version === 5 && Object.hasOwn(value, "creationId")) {
    if (Object.hasOwn(value, "historicalTournaments")) {
      const queue = value.historicalTournaments;
      if (
        !Array.isArray(queue) ||
        !queue.every(
          (entry) =>
            isRecord(entry) &&
            isUuid(entry.gameId) &&
            entry.gameId !== value.gameId &&
            isNullableUuid(entry.tournamentId) &&
            isUuid(entry.intentId),
        ) ||
        new Set(queue.map((entry) => entry.gameId)).size !== queue.length
      )
        return null;
    }
    if (
      Object.hasOwn(value, "tournamentAssociation") &&
      !isTournamentAssociation(value.tournamentAssociation, value)
    )
      return null;
    if (
      !isNullableUuid(value.gameId) ||
      !isNullableUuid(value.creationId) ||
      !isNonNegativeInteger(value.revision) ||
      !(value.current === null || isCurrent(value.current)) ||
      !Array.isArray(value.outbox) ||
      !value.outbox.every(isOperation) ||
      typeof value.failed !== "boolean" ||
      typeof value.clearFailed !== "boolean" ||
      !isNullableUuid(value.clearingGameId) ||
      typeof value.removed !== "boolean" ||
      !isNullableUuid(value.legacyGameId)
    ) {
      return null;
    }
    if (value.gameId === null && value.current !== null && value.creationId === null) return null;
    if (value.gameId !== null && value.current === null && value.clearingGameId === null)
      return null;
    return value as unknown as CurrentGameSessionEnvelope;
  }

  // V5 records came from a client-generated GUID scheme. Keep their snapshots
  // verbatim, but force the App to GET the GUID before treating it as server-owned.
  if (
    value.version !== 5 ||
    Object.hasOwn(value, "historicalTournaments") ||
    Object.hasOwn(value, "tournamentAssociation") ||
    !isNullableUuid(value.gameId) ||
    !isNonNegativeInteger(value.revision) ||
    !(value.current === null || isCurrent(value.current)) ||
    !Array.isArray(value.outbox) ||
    !value.outbox.every(isOperation) ||
    typeof value.failed !== "boolean" ||
    typeof value.clearFailed !== "boolean" ||
    !isNullableUuid(value.clearingGameId)
  ) {
    return null;
  }
  return {
    version: 5,
    clubId: value.clubId,
    gameId: value.gameId,
    creationId: null,
    revision: value.revision,
    current: value.current,
    outbox: value.outbox,
    failed: value.failed,
    clearFailed: value.clearFailed,
    clearingGameId: value.clearingGameId,
    removed: false,
    legacyGameId: value.gameId,
  };
};

export const isCurrentGameSessionEnvelope = (value: unknown): value is CurrentGameSessionEnvelope =>
  normalizeEnvelope(value) !== null;

export const parseCurrentGameSessionEnvelope = (raw: string): CurrentGameSessionEnvelope | null => {
  try {
    return normalizeEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
};

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return entry;
  });

const sameCurrent = (left: CurrentSession | null, right: CurrentSession): boolean =>
  left !== null && stableJson(left) === stableJson(right);

const remapEventGameIds = (
  state: CurrentGameSessionState,
  gameId: string,
): CurrentGameSessionState => ({
  ...state,
  events: state.events.map((event) => ({ ...event, gameId })),
});

export class GameSessionOutbox {
  private readonly options: OutboxOptions & { readonly clubId: string };
  private readonly storageKey: string;
  private envelope: CurrentGameSessionEnvelope;
  private storageSnapshot: string | null;
  private flushPromise: Promise<void> | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  public constructor(options: OutboxOptions) {
    const clubId = options.clubId ?? defaultClubId;
    if (!isUuid(clubId)) throw new Error("Club identity must be a UUID");
    this.options = { ...options, clubId };
    this.storageKey = options.storageKey ?? gameSessionStorageKey;
    this.storageSnapshot = options.storage.getItem(this.storageKey);
    this.envelope = this.readEnvelope(this.storageSnapshot);
    if (this.envelope.clubId !== clubId) {
      throw new Error("The durable game belongs to another club");
    }
  }

  public get status(): "saved" | "saving" | "offline" | "clearing" | "removed" {
    if (this.envelope.removed) return "removed";
    if (this.envelope.clearingGameId !== null) return "clearing";
    if (this.envelope.failed || this.envelope.clearFailed) return "offline";
    if (
      this.envelope.creationId !== null ||
      this.hasPendingMetadata ||
      this.envelope.outbox.length > 0 ||
      this.flushPromise !== null
    ) {
      return "saving";
    }
    return "saved";
  }

  public get pendingCount(): number {
    return (
      this.historicalTournaments.length +
      (this.envelope.removed
        ? 0
        : this.envelope.outbox.length +
          (this.envelope.creationId === null ? 0 : 1) +
          (this.hasPendingTournament ? 1 : 0))
    );
  }

  public get gameId(): string | null {
    return this.envelope.gameId;
  }

  public get tournamentId(): string | null {
    const association = this.envelope.tournamentAssociation;
    return association?.pending != null
      ? association.pending.tournamentId
      : (association?.confirmedTournamentId ?? null);
  }

  public get hasPendingTournament(): boolean {
    return this.envelope.tournamentAssociation?.pending != null;
  }

  private get historicalTournaments(): readonly HistoricalTournamentIntent[] {
    return this.envelope.historicalTournaments ?? [];
  }

  public get hasPendingMetadata(): boolean {
    return this.hasPendingTournament || this.historicalTournaments.length > 0;
  }

  public pendingTournamentId(gameId: string): string | null | undefined {
    return this.envelope.gameId === gameId
      ? this.envelope.tournamentAssociation?.pending?.tournamentId
      : this.historicalTournaments.find((intent) => intent.gameId === gameId)?.tournamentId;
  }

  /** All editors share one serialized durable lane; current-game edits coalesce. */
  public setGameTournament(gameId: string, tournamentId: string | null): void {
    this.synchronizeDurableState();
    if (!isUuid(gameId) || !isNullableUuid(tournamentId))
      throw new Error("Invalid tournament target");
    if (gameId === this.envelope.gameId) {
      if (this.envelope.removed) throw new Error("Game session was removed");
      this.setTournament(tournamentId);
      return;
    }
    const next = { gameId, tournamentId, intentId: this.options.createId() };
    const queue = this.historicalTournaments;
    this.envelope = {
      ...this.envelope,
      failed: false,
      historicalTournaments: queue.some((intent) => intent.gameId === gameId)
        ? queue.map((intent) => (intent.gameId === gameId ? next : intent))
        : [...queue, next],
    };
    this.persist();
  }

  public setTournament(tournamentId: string | null): void {
    this.synchronizeDurableState();
    if (!isNullableUuid(tournamentId)) throw new Error("Invalid tournament identity");
    if (this.envelope.removed || this.envelope.current === null) return;
    if (this.tournamentId === tournamentId && this.envelope.tournamentAssociation !== undefined)
      return;
    this.envelope = {
      ...this.envelope,
      failed: false,
      tournamentAssociation: {
        clubId: this.envelope.clubId,
        gameId: this.envelope.gameId,
        creationId: this.envelope.creationId,
        confirmedTournamentId: this.envelope.tournamentAssociation?.confirmedTournamentId ?? null,
        pending: { intentId: this.options.createId(), tournamentId },
      },
    };
    this.persist();
  }

  /** Historical correction changes metadata, never the active gameplay snapshot. */
  public reconcileTournament(gameId: string, tournamentId: string | null): void {
    this.synchronizeDurableState();
    if (this.envelope.gameId !== gameId || this.hasPendingTournament) return;
    if (!isNullableUuid(tournamentId)) throw new Error("Invalid tournament identity");
    this.envelope = {
      ...this.envelope,
      tournamentAssociation: {
        clubId: this.envelope.clubId,
        gameId,
        creationId: this.envelope.creationId,
        confirmedTournamentId: tournamentId,
        pending: null,
      },
    };
    this.persist();
  }

  public get revision(): number {
    return this.envelope.revision;
  }

  public get current(): CurrentSession | null {
    return this.envelope.current;
  }

  public get isCreating(): boolean {
    return this.envelope.gameId === null && this.envelope.creationId !== null;
  }

  public get isRemoved(): boolean {
    return this.envelope.removed;
  }

  public get needsRemoteVerification(): boolean {
    return this.envelope.legacyGameId !== null;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Persist one retry-stable creation identity before making the POST. */
  public beginCreation(
    name: string,
    state: CurrentGameSessionState,
    results: Readonly<Partial<FinalGameResults>> | null,
    tournamentId?: string | null,
  ): void {
    this.synchronizeDurableState();
    if (!isCurrentGameSessionState(state)) throw new Error("Invalid current game session state");
    if (!isResults(results)) throw new Error("Invalid current game session results");
    if (tournamentId !== undefined && !isNullableUuid(tournamentId))
      throw new Error("Invalid tournament identity");
    if (this.envelope.gameId !== null || this.envelope.creationId !== null) return;
    if (this.hasPendingMetadata)
      throw new Error("Tournament changes must finish before starting a game");
    this.envelope = {
      ...this.envelope,
      current: { name, state, results },
      creationId: this.options.createId(),
      failed: false,
      clearFailed: false,
      removed: false,
      legacyGameId: null,
    };
    if (tournamentId !== undefined) {
      this.envelope = {
        ...this.envelope,
        tournamentAssociation: {
          clubId: this.envelope.clubId,
          gameId: null,
          creationId: this.envelope.creationId,
          confirmedTournamentId: null,
          pending: { intentId: this.options.createId(), tournamentId },
        },
      };
    }
    this.persist();
  }

  /** Convert only a never-acknowledged v5 snapshot into a new server creation request. */
  public adoptLegacyDraft(): void {
    this.synchronizeDurableState();
    if (this.envelope.legacyGameId === null || this.envelope.current === null) return;
    this.generation += 1;
    this.flushPromise = null;
    if (this.envelope.revision > 0) {
      // A missing acknowledged record was deleted, not an unsent draft.
      // Keep the local snapshot for inspection without resurrecting it.
      this.envelope = {
        ...this.envelope,
        outbox: [],
        failed: false,
        removed: true,
        legacyGameId: null,
      };
      this.persist();
      return;
    }
    this.envelope = {
      ...this.envelope,
      gameId: null,
      creationId: this.options.createId(),
      outbox: [],
      failed: false,
      clearFailed: false,
      clearingGameId: null,
      removed: false,
      legacyGameId: null,
    };
    this.persist();
  }

  public confirmRemoteGame(gameId: string): void {
    this.synchronizeDurableState();
    if (this.envelope.gameId !== gameId || this.envelope.legacyGameId === null) return;
    this.envelope = { ...this.envelope, legacyGameId: null };
    this.persist();
  }

  public enqueue(
    name: string,
    state: GameSessionState,
    results: Readonly<Partial<FinalGameResults>> | null,
  ): void {
    this.synchronizeDurableState();
    if (
      this.envelope.removed ||
      (this.envelope.gameId === null && this.envelope.creationId === null)
    )
      return;
    if (!isCurrentGameSessionState(state)) throw new Error("Invalid current game session state");
    if (!isResults(results)) throw new Error("Invalid current game session results");
    const normalizedState =
      this.envelope.gameId === null ? state : remapEventGameIds(state, this.envelope.gameId);
    const current = { name, state: normalizedState, results };
    if (sameCurrent(this.envelope.current, current)) return;
    if (this.envelope.gameId === null) {
      // The pending POST uses the latest durable snapshot on retry. If it is
      // already in flight, reconciliation after acknowledgment queues a PUT.
      this.envelope = { ...this.envelope, current, failed: false, clearFailed: false };
      this.persist();
      return;
    }
    const retained = this.flushPromise === null ? [] : this.envelope.outbox.slice(0, 1);
    this.envelope = {
      ...this.envelope,
      current,
      outbox: [
        ...retained,
        {
          kind: "snapshot",
          name,
          mutationId: this.options.createId(),
          state: normalizedState,
          results,
        },
      ],
      failed: false,
      clearFailed: false,
    };
    this.persist();
  }

  /** Preserve the current local record while another server game is opened. */
  public park(): void {
    this.synchronizeDurableState();
    this.assertStorageGuard();
    if (this.isCreating) throw new Error("Game creation must finish before switching games");
    if (this.hasPendingMetadata)
      throw new Error("Tournament changes must finish before switching games");
    const identity = this.envelope.gameId ?? this.envelope.creationId;
    if (identity === null || this.envelope.current === null) return;
    const serialized = JSON.stringify(this.envelope);
    const key = this.parkedStorageKey(identity);
    this.options.storage.setItem(key, serialized);
    if (this.options.storage.getItem(key) !== serialized) {
      throw new Error("Browser game storage write could not be verified");
    }
    this.generation += 1;
    this.flushPromise = null;
    this.envelope = emptyEnvelope(this.options.clubId);
    this.persist();
  }

  /** Load a server snapshot, preferring a parked copy only with unsent work. */
  public activateRemote(session: RemoteGameSession): void {
    this.synchronizeDurableState();
    if (
      !isUuid(session.gameId) ||
      !isCurrentGameSessionState(session.state) ||
      !isResults(session.results) ||
      (session.tournamentId !== undefined && !isNullableUuid(session.tournamentId))
    ) {
      throw new Error("Invalid server game session");
    }
    if (this.envelope.gameId === session.gameId && this.pendingCount > 0) return;
    if (this.hasPendingMetadata)
      throw new Error("Tournament changes must finish before switching games");
    const parkedKey = this.parkedStorageKey(session.gameId);
    const parkedRaw = this.options.storage.getItem(parkedKey);
    const parked = parkedRaw === null ? null : parseCurrentGameSessionEnvelope(parkedRaw);
    if (
      parkedRaw !== null &&
      (parked === null || parked.gameId !== session.gameId || parked.clubId !== this.options.clubId)
    ) {
      throw new Error("Unsupported parked game session; original data was preserved");
    }
    if (
      this.envelope.current !== null &&
      (this.envelope.gameId !== session.gameId || this.envelope.creationId !== null)
    ) {
      this.park();
    }
    if (
      parked?.gameId === session.gameId &&
      parked.current !== null &&
      (parked.outbox.length > 0 ||
        parked.creationId !== null ||
        parked.tournamentAssociation?.pending != null)
    ) {
      this.options.storage.removeItem(parkedKey);
      this.envelope =
        session.tournamentId === undefined
          ? parked
          : {
              ...parked,
              tournamentAssociation: {
                clubId: this.options.clubId,
                gameId: session.gameId,
                creationId: null,
                confirmedTournamentId: session.tournamentId,
                pending: parked.tournamentAssociation?.pending ?? null,
              },
            };
      this.storageSnapshot = this.options.storage.getItem(this.storageKey);
      this.persist();
      return;
    }
    if (parkedRaw !== null) this.options.storage.removeItem(parkedKey);
    this.generation += 1;
    this.flushPromise = null;
    this.envelope = {
      version: 5,
      clubId: this.options.clubId,
      gameId: session.gameId,
      creationId: null,
      ...(session.tournamentId === undefined
        ? {}
        : {
            tournamentAssociation: {
              clubId: this.options.clubId,
              gameId: session.gameId,
              creationId: null,
              confirmedTournamentId: session.tournamentId,
              pending: null,
            },
          }),
      revision: session.revision,
      current: { name: session.name, state: session.state, results: session.results },
      outbox: [],
      failed: false,
      clearFailed: false,
      clearingGameId: null,
      removed: false,
      legacyGameId: null,
    };
    this.persist();
  }

  /** Remove only the local record after DELETE has been acknowledged. */
  public async clear(clearRemote: (gameId: string) => Promise<void>): Promise<void> {
    this.synchronizeDurableState();
    const gameId = this.envelope.gameId;
    if (gameId === null) {
      this.generation += 1;
      this.envelope = {
        ...emptyEnvelope(this.options.clubId),
        historicalTournaments: this.historicalTournaments,
      };
      this.persist();
      return;
    }
    this.envelope = { ...this.envelope, clearFailed: false, clearingGameId: gameId };
    this.persist();
    try {
      await clearRemote(gameId);
      if (this.envelope.gameId !== gameId) return;
      this.generation += 1;
      this.envelope = {
        ...emptyEnvelope(this.options.clubId),
        historicalTournaments: this.historicalTournaments,
      };
      this.persist();
    } catch (error) {
      if (this.envelope.gameId === gameId) {
        this.envelope = { ...this.envelope, clearFailed: true, clearingGameId: null };
        this.persist();
      }
      throw error;
    }
  }

  public flush(): Promise<void> {
    if (this.flushPromise !== null) return this.flushPromise;
    this.synchronizeDurableState();
    if (this.pendingCount === 0) return Promise.resolve();
    // Clearing current gameplay must not detach an in-flight historical PUT.
    // Keep its lane occupied, then drain retained/new intent after it settles.
    const drain = async (): Promise<void> => {
      do {
        const generation = this.generation;
        try {
          await this.flushAll(generation);
        } catch (error) {
          if (generation === this.generation) throw error;
        }
        if (this.flushPromise !== operation) return;
      } while (this.pendingCount > 0);
    };
    const operation = drain();
    this.flushPromise = operation;
    this.notify();
    operation.then(
      () => this.finishFlush(operation),
      () => this.finishFlush(operation),
    );
    return operation;
  }

  private finishFlush(operation: Promise<void>): void {
    if (this.flushPromise !== operation) return;
    this.flushPromise = null;
    this.notify();
  }

  private async flushAll(generation: number): Promise<void> {
    let targetGameId: string | null = null;
    try {
      if (this.envelope.gameId === null && this.envelope.creationId !== null) {
        const current = this.envelope.current;
        if (current === null) throw new Error("Creation is missing its game snapshot");
        const creationId = this.envelope.creationId;
        if (this.options.create === undefined) {
          throw new Error("Game-session creation is not configured");
        }
        const remote = await this.options.create({
          creationId,
          name: current.name,
          state: current.state,
          results: current.results,
          ...(this.envelope.tournamentAssociation === undefined
            ? {}
            : { tournamentId: this.tournamentId }),
        });
        if (generation !== this.generation) return;
        if (
          !isUuid(remote.gameId) ||
          !isCurrentGameSessionState(remote.state) ||
          (remote.tournamentId !== undefined && !isNullableUuid(remote.tournamentId))
        ) {
          throw new Error("Invalid game creation response");
        }
        const latest = this.envelope.current;
        if (latest === null) throw new Error("Creation is missing its game snapshot");
        const adopted = {
          name: latest.name,
          state: remapEventGameIds(latest.state, remote.gameId),
          results: latest.results,
        };
        const acknowledged = { name: remote.name, state: remote.state, results: remote.results };
        this.envelope = {
          ...this.envelope,
          gameId: remote.gameId,
          creationId: null,
          revision: remote.revision,
          current: adopted,
          outbox: sameCurrent(acknowledged, adopted)
            ? this.envelope.outbox
            : [
                ...this.envelope.outbox,
                {
                  kind: "snapshot",
                  name: adopted.name,
                  mutationId: this.options.createId(),
                  state: adopted.state,
                  results: adopted.results,
                },
              ],
          failed: false,
          legacyGameId: null,
        };
        const association = this.envelope.tournamentAssociation;
        if (association !== undefined || remote.tournamentId !== undefined) {
          this.envelope = {
            ...this.envelope,
            tournamentAssociation: {
              clubId: this.envelope.clubId,
              gameId: remote.gameId,
              creationId: null,
              confirmedTournamentId: remote.tournamentId ?? null,
              pending:
                association?.pending != null &&
                association.pending.tournamentId !== remote.tournamentId
                  ? association.pending
                  : null,
            },
          };
        }
        this.persist();
      }

      while (
        (this.envelope.outbox.length > 0 || this.hasPendingMetadata) &&
        generation === this.generation
      ) {
        targetGameId = this.envelope.gameId;
        if (this.envelope.outbox.length === 0 && !this.hasPendingTournament) {
          const pending = this.historicalTournaments[0];
          if (pending === undefined || this.options.assignTournament === undefined)
            throw new Error("Tournament assignment is not configured");
          targetGameId = pending.gameId;
          let confirmed: string | null;
          try {
            confirmed = await this.options.assignTournament(pending.gameId, pending.tournamentId);
          } catch (error) {
            if (generation !== this.generation) return;
            if (
              error instanceof ApiError &&
              error.status === 404 &&
              error.code === "game_session_not_found"
            ) {
              this.envelope = {
                ...this.envelope,
                historicalTournaments: this.historicalTournaments.filter(
                  (intent) => intent.gameId !== pending.gameId,
                ),
              };
              this.persist();
            } else if (
              this.historicalTournaments.find((intent) => intent.gameId === pending.gameId)
                ?.intentId !== pending.intentId
            ) {
              continue;
            }
            throw error;
          }
          if (generation !== this.generation) return;
          if (confirmed !== pending.tournamentId)
            throw new Error("Tournament assignment has not been confirmed");
          this.envelope = {
            ...this.envelope,
            failed: false,
            historicalTournaments: this.historicalTournaments.filter(
              (intent) => intent.gameId !== pending.gameId || intent.intentId !== pending.intentId,
            ),
          };
          this.persist();
          continue;
        }
        if (this.envelope.outbox.length === 0) {
          const association = this.envelope.tournamentAssociation;
          const pending = association?.pending;
          const gameId = this.envelope.gameId;
          if (
            association === undefined ||
            pending == null ||
            gameId === null ||
            this.options.assignTournament === undefined
          ) {
            throw new Error("Tournament assignment is not configured");
          }
          let confirmed: string | null;
          try {
            confirmed = await this.options.assignTournament(gameId, pending.tournamentId);
          } catch (error) {
            if (generation !== this.generation) return;
            if (
              !(
                error instanceof ApiError &&
                error.status === 404 &&
                error.code === "game_session_not_found"
              ) &&
              this.envelope.tournamentAssociation?.pending?.intentId !== pending.intentId
            )
              continue;
            throw error;
          }
          if (generation !== this.generation) return;
          if (confirmed !== pending.tournamentId)
            throw new Error("Tournament assignment has not been confirmed");
          this.envelope = {
            ...this.envelope,
            failed: false,
            tournamentAssociation: {
              ...association,
              confirmedTournamentId: confirmed,
              pending:
                this.envelope.tournamentAssociation?.pending?.intentId === pending.intentId &&
                this.envelope.tournamentAssociation.pending.tournamentId === pending.tournamentId
                  ? null
                  : (this.envelope.tournamentAssociation?.pending ?? null),
            },
          };
          this.persist();
          continue;
        }
        const gameId = this.envelope.gameId;
        const mutation = this.envelope.outbox[0];
        if (gameId === null || mutation === undefined)
          throw new Error("Invalid game session outbox");
        const remote = await this.options.save(gameId, mutation);
        if (generation !== this.generation) return;
        this.envelope = {
          ...this.envelope,
          revision: remote.revision,
          outbox: this.envelope.outbox.slice(1),
          failed: false,
        };
        this.persist();
      }
    } catch (error) {
      if (generation === this.generation) {
        if (
          error instanceof ApiError &&
          error.status === 404 &&
          error.code === "game_session_not_found" &&
          targetGameId !== null &&
          targetGameId === this.envelope.gameId
        ) {
          this.envelope = {
            ...this.envelope,
            outbox: [],
            failed: false,
            removed: true,
            ...(this.envelope.tournamentAssociation === undefined
              ? {}
              : {
                  tournamentAssociation: { ...this.envelope.tournamentAssociation, pending: null },
                }),
          };
        } else {
          this.envelope = { ...this.envelope, failed: true };
        }
        this.persist();
      }
      throw error;
    }
  }

  private synchronizeDurableState(): void {
    const raw = this.options.storage.getItem(this.storageKey);
    if (raw === this.storageSnapshot) return;
    this.envelope = this.readEnvelope(raw);
    this.storageSnapshot = raw;
    this.notify();
  }

  private readEnvelope(raw: string | null): CurrentGameSessionEnvelope {
    if (raw === null) return emptyEnvelope(this.options.clubId);
    const parsed = parseCurrentGameSessionEnvelope(raw);
    if (parsed === null) throw new Error("Browser game storage is invalid");
    if (parsed.clubId !== this.options.clubId)
      throw new Error("The durable game belongs to another club");
    return parsed;
  }

  private persist(): void {
    this.assertStorageGuard();
    const serialized =
      this.envelope.current === null &&
      this.envelope.outbox.length === 0 &&
      this.historicalTournaments.length === 0 &&
      this.envelope.creationId === null
        ? null
        : JSON.stringify(this.envelope);
    if (this.options.storage.getItem(this.storageKey) !== this.storageSnapshot) {
      throw new Error("Local session changed in another browser context");
    }
    if (serialized === null) this.options.storage.removeItem(this.storageKey);
    else this.options.storage.setItem(this.storageKey, serialized);
    if (this.options.storage.getItem(this.storageKey) !== serialized) {
      throw new Error("Browser game storage write could not be verified");
    }
    this.storageSnapshot = serialized;
    this.notify();
  }

  private parkedStorageKey(identity: string): string {
    return `${this.storageKey}.parked.${identity}`;
  }

  private assertStorageGuard(): void {
    if (this.options.storageGuard !== undefined) {
      assertBrowserGameStorageGuard(this.options.storageGuard);
      return;
    }
    if (
      import.meta.env.MODE !== "test" &&
      typeof window !== "undefined" &&
      this.options.storage === window.localStorage
    ) {
      throw new Error("Browser game storage lock is required");
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
