import type { GameState, ReplayFrame } from "@mafia/game-domain";

/** Additional unique supporters only; the original nominator never contributes to +N. */
export const getNominationSupporterSeats = (
  nomination: GameState["nominations"][number],
): readonly number[] =>
  [...new Set(nomination.supporterSeats ?? [])].filter((seat) => seat !== nomination.nominatorSeat);

/**
 * Display-only projection: one real checkpoint per round using reversible selections.
 * Its after-state contains the surviving relations at that checkpoint. Do not rewrite
 * entries/frames, synthesize hashes, or pass this collapsed list to canonical replay.
 * Rounds containing only legacy nomination facts retain their existing presentation.
 */
export const projectNominationHistory = (
  frames: readonly ReplayFrame[],
): {
  readonly frames: readonly ReplayFrame[];
  readonly summaryFrames: ReadonlySet<ReplayFrame>;
} => {
  const selectionRounds = new Set(
    frames
      .filter(({ entry }) => entry.type === "nomination.selection-set")
      .map(({ before }) => before.day),
  );
  const latest = new Map<number, ReplayFrame>();
  const isNomination = ({ entry }: ReplayFrame) =>
    entry.type === "nomination.selection-set" || entry.type === "player.nominated";
  for (const frame of frames) {
    if (selectionRounds.has(frame.before.day) && isNomination(frame))
      latest.set(frame.before.day, frame);
  }
  const summaryFrames = new Set(latest.values());
  return {
    summaryFrames,
    frames: frames.filter(
      (frame) =>
        !selectionRounds.has(frame.before.day) || !isNomination(frame) || summaryFrames.has(frame),
    ),
  };
};
