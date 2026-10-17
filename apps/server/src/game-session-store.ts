import { z } from "zod";
import {
  CASPER_PLAYER_ID,
  type StatisticsGame,
  type StatisticsParticipant,
} from "@mafia/game-domain";
import {
  assertSupportedGame,
  inspectGameIdentities,
  InvalidGameIdentityError,
} from "./game-session-identity.js";
import { adjudicationMetadataSchema } from "./game-session-validation.js";
import { statisticsIdentityKey } from "./statistics-identity.js";

export type GameSessionState = Readonly<Record<string, unknown>>;
export type FinalGameResults = Readonly<Record<string, unknown>>;

export interface CreateGameSessionInput {
  readonly clubId?: string;
  readonly creationId: string;
  readonly tournamentId?: string | null;
  readonly name: string;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}
export interface SaveGameSessionInput {
  readonly clubId?: string;
  readonly gameId: string;
  readonly name: string;
  readonly mutationId: string;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}
export interface StoredGameSession {
  readonly gameId: string;
  readonly tournamentId?: string | null;
  readonly name: string;
  readonly revision: number;
  readonly duplicate: boolean;
  readonly status: "active" | "completed";
  readonly updatedAt: Date;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}
export interface GameSessionSummary {
  readonly gameId: string;
  readonly tournamentId?: string | null;
  readonly name: string;
  readonly revision: number;
  readonly hostPlayerId: string | null;
  readonly phase: string;
  readonly day: number;
  readonly updatedAt: Date;
}
export interface CompletedGameSessionFilters {
  readonly from?: string;
  readonly to?: string;
  readonly playerId?: string;
  readonly outcome?: "red" | "black" | "draw" | "cancelled";
}
export interface CompletedGameSessionSummary {
  readonly gameId: string;
  readonly tournamentId?: string | null;
  readonly name: string;
  readonly revision: number;
  readonly hostPlayerId: string | null;
  readonly outcome: "red" | "black" | "draw" | "cancelled" | null;
  readonly winner: "red" | "black" | null;
  readonly reason: string | null;
  readonly playedAt: string | null;
  readonly day: number | null;
  readonly timelineAvailable: boolean;
  readonly eventCount: number;
  readonly updatedAt: Date;
}
export class GameSessionOperationError extends Error {
  public override readonly name: string = "GameSessionOperationError";
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class GameSessionNotFoundError extends GameSessionOperationError {
  public override readonly name = "GameSessionNotFoundError";
  public constructor() {
    super("game_session_not_found", "The game session does not exist in the selected club");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const integerIn = (
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
const member = <T extends string>(value: unknown, values: readonly T[]): T | null =>
  values.includes(value as T) ? (value as T) : null;
const observedTimestamp = z.iso.datetime({ offset: true });
const playedTime = (value: unknown): string | null =>
  typeof value === "string" && observedTimestamp.safeParse(value).success
    ? new Date(value).toISOString()
    : null;

/** A detail-presence flag, NOT a replay verdict. Broken retained detail must reach client inspection. */
export const timelineAvailable = (state: GameSessionState): boolean =>
  state.initialGame != null ||
  state.headEventId != null ||
  (Array.isArray(state.events) ? state.events.length > 0 : state.events != null);

/** Independent accepted observations; absence or an invalid optional fact never poisons its peers. */
export const completionMetadata = (value: FinalGameResults | null) => ({
  outcome: member(value?.outcome, ["red", "black", "draw", "cancelled"] as const),
  winner: member(value?.winner, ["red", "black"] as const),
  reason: asString(value?.reason),
  playedAt: playedTime(value?.playedAt),
});
export interface ProjectableResults {
  readonly hostPlayerId: string | null;
  readonly outcome: CompletedGameSessionSummary["outcome"];
  readonly winner: CompletedGameSessionSummary["winner"];
  readonly reason: string | null;
  readonly playedAt: string | null;
  readonly players: readonly StatisticsParticipant[] | null;
}
export const projectableResults = (
  value: FinalGameResults | null,
  state?: GameSessionState,
): ProjectableResults | null => {
  if (!isRecord(value)) return null;
  if (inspectGameIdentities(state ?? {}, value).invalid) throw new InvalidGameIdentityError();
  const game = isRecord(state?.game) ? state.game : null;
  // Only directly observed terminal snapshot fields can fill an omitted result field.
  // Never read setup, replay events, derive teams, or union a replacement result roster.
  const snapshotRows =
    game &&
    ["finished", "draw", "cancelled"].includes(game.phase as string) &&
    Array.isArray(game.players)
      ? game.players.filter(isRecord)
      : null;
  const snapshotId = (row: Record<string, unknown>): string => {
    const id = row.playerId ?? row.id;
    if (typeof id !== "string") throw new InvalidGameIdentityError();
    return id;
  };
  const snapshots = new Map(
    (snapshotRows ?? []).map((row) => [statisticsIdentityKey(snapshotId(row)), row]),
  );
  // This is a stored observation, not a recalculation. Bind ownership to the
  // unique terminal snapshot row, never a corrected result seat.
  const bestMove = isRecord(game?.bestMove) ? game.bestMove : null;
  const bestMoveSeat = integerIn(bestMove?.playerSeat, 1, 10);
  const bestMoveOwners =
    bestMoveSeat === null
      ? []
      : (snapshotRows?.filter((row) => integerIn(row.seat, 1, 10) === bestMoveSeat) ?? []);
  const bestMoveOwner = bestMoveOwners.length === 1 ? bestMoveOwners[0] : undefined;
  const rows = Object.hasOwn(value, "players")
    ? Array.isArray(value.players)
      ? value.players
      : null
    : (snapshotRows?.map((row) => ({ ...row, playerId: snapshotId(row) })) ?? null);
  const setup = isRecord(state?.setup) ? state.setup : null;
  return {
    ...completionMetadata(value),
    hostPlayerId: Object.hasOwn(value, "hostPlayerId")
      ? asString(value.hostPlayerId) || null
      : asString(state?.hostPlayerId) || asString(setup?.hostPlayerId) || null,
    players:
      rows?.map((candidate): StatisticsParticipant => {
        if (!isRecord(candidate) || typeof candidate.playerId !== "string")
          throw new InvalidGameIdentityError();
        const snapshot = snapshots.get(statisticsIdentityKey(candidate.playerId));
        const observed = (key: string): unknown =>
          Object.hasOwn(candidate, key) ? candidate[key] : snapshot?.[key];
        return {
          playerId: candidate.playerId,
          seat: integerIn(observed("seat"), 1, 10),
          role: member(observed("role"), ["sheriff", "citizen", "mafia", "don"] as const),
          team: member(observed("team"), ["red", "black"] as const),
          status: member(observed("status"), ["active", "eliminated", "red-carded"] as const),
          fouls: integerIn(observed("fouls"), 0),
          bestMoveHits: integerIn(
            Object.hasOwn(candidate, "bestMoveHits") ||
              (snapshot && Object.hasOwn(snapshot, "bestMoveHits"))
              ? observed("bestMoveHits")
              : snapshot && snapshot === bestMoveOwner
                ? bestMove?.mafiaHits
                : undefined,
            0,
            3,
          ),
        };
      }) ?? null,
  };
};

/** Bound result metadata without interpreting rules or altering saved JSON. */
export const assertValidResultAdjudication = (results: FinalGameResults | null): void => {
  if (
    results !== null &&
    results.adjudication !== undefined &&
    !adjudicationMetadataSchema.safeParse(results.adjudication).success
  ) {
    throw new GameSessionOperationError(
      "invalid_game_adjudication",
      "Invalid adjudication metadata",
    );
  }
};
const completeSeats = (roster: readonly { playerId: string; seat: number | null }[]): boolean =>
  roster.length === 10 &&
  new Set(roster.map((p) => statisticsIdentityKey(p.playerId))).size === 10 &&
  roster.every((p) => p.seat !== null) &&
  new Set(roster.map((p) => p.seat)).size === 10;

/** Narrow accepted-result view: no live roles, private events, copied profiles or replay inference. */
export const statisticsGame = (
  session: Pick<
    StoredGameSession,
    "gameId" | "name" | "revision" | "status" | "state" | "results" | "tournamentId"
  >,
): StatisticsGame => {
  const { state, results } = session;
  assertSupportedGame(state, results);
  if (inspectGameIdentities(state, results).invalid) throw new InvalidGameIdentityError();
  assertValidResultAdjudication(results);
  const game = isRecord(state.game) ? state.game : null;
  const setup = isRecord(state.setup) ? state.setup : null;
  const projection = session.status === "completed" ? projectableResults(results, state) : null;
  const resultRoster = projection?.players ?? null;
  const rawRoster = Array.isArray(game?.players) ? game.players : null;
  const roster =
    rawRoster?.map((p) => ({
      playerId: isRecord(p) && typeof p.id === "string" ? p.id : "",
      seat: isRecord(p) ? integerIn(p.seat, 1, 10) : null,
    })) ?? null;
  const resultComplete = resultRoster !== null && completeSeats(resultRoster);
  const stateComplete = roster !== null && completeSeats(roster);
  const matchesRoster =
    roster !== null &&
    resultRoster !== null &&
    roster.length === resultRoster.length &&
    roster.every((p) =>
      resultRoster.some(
        (r) =>
          statisticsIdentityKey(r.playerId) === statisticsIdentityKey(p.playerId) &&
          r.seat === p.seat,
      ),
    );
  const rosterComplete =
    resultRoster === null
      ? null
      : results &&
          Object.hasOwn(results, "rosterComplete") &&
          typeof results.rosterComplete !== "boolean"
        ? null
        : results?.rosterComplete === false
          ? false
          : resultComplete && (roster === null || (stateComplete && matchesRoster));
  const hasCasper =
    results && Object.hasOwn(results, "hasCasper")
      ? typeof results.hasCasper === "boolean"
        ? results.hasCasper
        : null
      : setup?.casperEnabled === true ||
          [...(roster ?? []), ...(resultRoster ?? [])].some((p) => p.playerId === CASPER_PLAYER_ID)
        ? true
        : setup?.casperEnabled === false || resultComplete || stateComplete
          ? false
          : null;
  const adjudication =
    results?.adjudication === undefined
      ? undefined
      : adjudicationMetadataSchema.parse(results.adjudication);
  return {
    gameId: session.gameId,
    name: session.name,
    revision: session.revision,
    status: session.status,
    hasCasper,
    rosterComplete,
    timelineAvailable: timelineAvailable(state),
    playedAt: projection?.playedAt ?? null,
    hostPlayerId:
      projection !== null
        ? projection.hostPlayerId
        : asString(state.hostPlayerId) || asString(setup?.hostPlayerId) || null,
    outcome: projection?.outcome ?? null,
    reason: projection?.reason ?? null,
    ...(adjudication ? { adjudication } : {}),
    tournamentId: session.tournamentId ?? null,
    participants: resultRoster?.filter((p) => p.playerId !== CASPER_PLAYER_ID) ?? null,
  };
};
