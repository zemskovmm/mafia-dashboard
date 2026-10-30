import type { GameState, ReplayFrame } from "@mafia/game-domain";
import { pendingPublicDepartureSeats } from "./player-exit-transitions.js";

export type PlayerDepartureCause = "unknown" | "mafia" | "vote" | "discipline";
export type PlayerDepartureCauses = Readonly<Partial<Record<number, PlayerDepartureCause>>>;
export interface PlayerActionPresentation {
  readonly endpoints: PlayerDepartureCauses;
  readonly action?: Readonly<{
    id: string;
    after: GameState;
    fouls: Readonly<Partial<Record<number, number>>>;
    adjudication: boolean;
  }>;
}

/** Only explicit current facts can explain a checkpoint; old inactive status cannot. */
const knownCause = (game: GameState, seat: number): PlayerDepartureCause | undefined => {
  if (game.players.find((p) => p.seat === seat)?.status === "red-carded") return "discipline";
  if (game.goodbyeSeats?.includes(seat)) {
    if (game.goodbyeNext === "night") return "vote";
    if (game.goodbyeNext === "day") return "mafia";
  }
  if (
    game.phase.startsWith("night-") &&
    game.nightResult?.kind === "kill" &&
    game.nightResult.targetSeat === seat
  )
    return "mafia";
  return undefined;
};

/** Retain causes through phase cleanup, but never through player replacement/restoration. */
export const advanceDepartureCauses = (
  previous: PlayerDepartureCauses,
  before: GameState,
  after: GameState,
): PlayerDepartureCauses => {
  const causes: Partial<Record<number, PlayerDepartureCause>> = {};
  for (const player of after.players) {
    if (player.status === "active") continue;
    const old = before.players.find((p) => p.id === player.id && p.seat === player.seat);
    let cause =
      knownCause(after, player.seat) ??
      (old ? (previous[player.seat] ?? knownCause(before, player.seat)) : undefined);
    if (
      !cause &&
      old?.status === "active" &&
      player.status === "eliminated" &&
      ["day", "voting", "car-crash-decision", "car-crash-result"].includes(before.phase)
    )
      cause = "vote";
    causes[player.seat] = cause ?? "unknown";
  }
  return causes;
};

export const publicDepartureCauses = (
  game: GameState,
  causes: PlayerDepartureCauses,
): PlayerDepartureCauses => {
  const pending = pendingPublicDepartureSeats(game);
  return Object.fromEntries(
    game.players.flatMap((player) => {
      if (player.status === "red-carded") return [[player.seat, "discipline"]];
      if (player.status !== "eliminated" || pending.includes(player.seat)) return [];
      return [[player.seat, causes[player.seat] ?? "unknown"]];
    }),
  );
};

/** Pure web projection of an admitted history PREFIX, never a second replay or saved field. */
export const projectPlayerActions = (
  frames: readonly ReplayFrame[],
  game: GameState,
): PlayerActionPresentation => {
  let causes: PlayerDepartureCauses = {};
  for (const frame of frames) causes = advanceDepartureCauses(causes, frame.before, frame.after);
  const last = frames.at(-1);
  // The displayed game may also contain an unaccepted vote/shot draft. That cannot create a cue.
  const fouls: Partial<Record<number, number>> = {};
  if (last?.entry.type === "foul.issued" && !last.entry.payload.redCarded)
    fouls[last.entry.payload.seat] = last.entry.payload.foulNumber;
  return {
    endpoints: publicDepartureCauses(game, causes),
    action: last
      ? {
          id: last.entry.id,
          after: last.after,
          fouls,
          adjudication: last.entry.type === "game.adjudicated",
        }
      : undefined,
  };
};
