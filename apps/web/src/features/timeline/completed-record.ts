import type { StatisticsParticipant } from "@mafia/game-domain";
import type { CompletedGameSessionSummary, RemoteGameSession } from "../../api/client.js";

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
const string = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const integer = (
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
const member = <T extends string>(value: unknown, values: readonly T[]): T | null =>
  values.includes(value as T) ? (value as T) : null;
// Presence, not truthiness: explicit corrections and unknowns override earlier observations.
const observed = (
  key: string,
  ...sources: readonly (Readonly<Record<string, unknown>> | null)[]
): unknown => sources.find((source) => source !== null && Object.hasOwn(source, key))?.[key];
const identityKey = (id: string): string =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : id;
const timestamp = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return null;
  const [, year, month, day] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return Number(day) <= daysInMonth ? value : null;
};

/** Read-only factual projection. Never infer a result, role/team, zero or time from replay/storage metadata. */
export const completedRecordFacts = (
  session: RemoteGameSession,
  summary: CompletedGameSessionSummary | null,
) => {
  const completed = session.status === "completed";
  const results = completed ? record(session.results) : null;
  const state = completed ? record(session.state) : null;
  const summaryFacts = completed ? record(summary) : null;
  const snapshotGame = record(state?.game);
  const game =
    member(snapshotGame?.phase, ["finished", "draw", "cancelled"]) === null ? null : snapshotGame;
  const setup = record(state?.setup);
  const bestMove = record(game?.bestMove);
  const bestMoveOwnerSeat = integer(bestMove?.playerSeat, 1, 10);
  const snapshotRoster = Array.isArray(game?.players) ? game.players.map(record) : [];
  const bestMoveOwners = snapshotRoster.filter(
    (snapshot) => bestMoveOwnerSeat !== null && snapshot?.seat === bestMoveOwnerSeat,
  );
  const rawRoster = observed("players", results, game);
  const roster = Array.isArray(rawRoster) ? rawRoster : null;
  const participants: readonly StatisticsParticipant[] | null =
    roster?.flatMap((value): StatisticsParticipant[] => {
      const player = record(value);
      const playerId = string(player?.playerId) ?? string(player?.id);
      if (player === null || playerId === null) return [];
      const matches = snapshotRoster.filter((snapshot) => {
        const id = string(snapshot?.id);
        return id !== null && identityKey(id) === identityKey(playerId);
      });
      const snapshot = matches.length === 1 ? matches[0]! : null;
      const seat = integer(observed("seat", player, snapshot), 1, 10);
      return [
        {
          playerId,
          seat,
          role: member(observed("role", player, snapshot), ["citizen", "sheriff", "mafia", "don"]),
          team: member(observed("team", player, snapshot), ["red", "black"]),
          status: member(observed("status", player, snapshot), [
            "active",
            "eliminated",
            "red-carded",
          ]),
          fouls: integer(observed("fouls", player, snapshot), 0),
          bestMoveHits: integer(
            observed("bestMoveHits", player, snapshot, {
              bestMoveHits:
                bestMoveOwners.length === 1 && snapshot === bestMoveOwners[0]
                  ? bestMove?.mafiaHits
                  : null,
            }),
            0,
            3,
          ),
        },
      ];
    }) ?? null;
  const adjudication = record(observed("adjudication", results, game));
  return {
    outcome: member(observed("outcome", results, summaryFacts), [
      "red",
      "black",
      "draw",
      "cancelled",
    ]),
    winner: member(
      observed("winner", results, {
        winner: member(game?.winner, ["red", "black"]) ?? summaryFacts?.winner,
      }),
      ["red", "black"],
    ),
    reason: string(observed("reason", results, summaryFacts)),
    playedAt: timestamp(observed("playedAt", results, summaryFacts)),
    hostPlayerId: string(
      observed("hostPlayerId", results, {
        hostPlayerId:
          string(state?.hostPlayerId) ?? string(setup?.hostPlayerId) ?? summaryFacts?.hostPlayerId,
      }),
    ),
    day: integer(game?.day, 0) ?? integer(summaryFacts?.day, 0),
    participants,
    adjudication:
      adjudication === null
        ? null
        : {
            losingTeam: member(adjudication.losingTeam, ["red", "black"]),
            offenderSeat: integer(adjudication.offenderSeat, 1, 10),
            rule: string(adjudication.rule),
            reason: string(adjudication.reason),
            committeeApproved:
              typeof adjudication.committeeApproved === "boolean"
                ? adjudication.committeeApproved
                : null,
          },
  };
};

export type CompletedRecordFacts = ReturnType<typeof completedRecordFacts>;
