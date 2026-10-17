import {
  createInitialGameBaseline,
  assignRoleForSeat,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createSeededRandom,
  createSetup,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type GameState,
  type InitialGameBaseline,
  type PlayerInput,
  type ReplayFrame,
  type Role,
} from "@mafia/game-domain";
import { getActiveBranch } from "../game/game-history.js";

export const SAMPLE_GAME_LABEL = "Sample game · not saved" as const;
const SAMPLE_GAME_ID = "00000000-0000-4000-8000-000000000700";
const SAMPLE_STARTED_AT = Date.UTC(2026, 7, 24, 18, 0, 0);
const samplePlayers = (): readonly PlayerInput[] =>
  Array.from({ length: 10 }, (_, index) => ({ id: `sample-player-${index + 1}`, seat: index + 1 }));
const rolesBySeat: readonly Role[] = [
  "sheriff",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "mafia",
  "mafia",
  "don",
];
const createInitialGame = (): GameState => {
  let setup = beginRoleDraw(createSetup(samplePlayers()), createSeededRandom(20260824));
  for (const [index, role] of rolesBySeat.entries())
    setup = assignRoleForSeat(setup, index + 1, role);
  return createGame(completeRoleDraw(setup));
};
const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
export interface SampleGameHistory {
  readonly label: typeof SAMPLE_GAME_LABEL;
  readonly baseline: InitialGameBaseline;
  readonly entries: readonly GameLogEntry[];
  readonly headEventId: string;
  readonly activeEntries: readonly GameLogEntry[];
  readonly frames: readonly ReplayFrame[];
  readonly game: GameState;
}

/** Every accepted event executes a current public domain action; never relabel old fixture JSON. */
const createCurrentSample = (
  outcome: "completed" | "adjudicated" | "rules-draw",
): SampleGameHistory => {
  const baseline = deepFreeze(createInitialGameBaseline(createInitialGame()));
  const entries: GameLogEntry[] = [];
  let game = baseline.game;
  const append = (draft: CanonicalGameEventDraft): void => {
    const sequence = entries.length + 1;
    const created = createGameLogEntry({
      gameId: SAMPLE_GAME_ID,
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      sequence,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: new Date(SAMPLE_STARTED_AT + sequence * 60_000).toISOString(),
      before: game,
      draft,
    });
    entries.push(created.entry);
    game = created.after;
  };
  const history = (): SampleGameHistory => {
    const headEventId = entries.at(-1)!.id;
    const activeEntries = getActiveBranch(entries, headEventId);
    const replayed = replayGameLog(baseline, activeEntries);
    return {
      label: SAMPLE_GAME_LABEL,
      baseline,
      entries,
      headEventId,
      activeEntries,
      frames: replayed.frames,
      game: replayed.game,
    };
  };
  append({ type: "game.started", payload: {} });
  for (const to of [
    "mafia-sleep",
    "don-identification",
    "sheriff-identification",
    "free-seating",
    "day",
  ] as const)
    append({ type: "phase.changed", payload: { to } });
  if (outcome === "rules-draw") {
    for (let night = 2; night <= 3; night += 1) {
      append({ type: "voting.legally-skipped", payload: { reason: "no-nominees" } });
      append({
        type: "mafia.shots-resolved",
        payload: {
          shots: [8, 9, 10].map((shooterSeat) => ({
            shooterSeat,
            targetSeat: shooterSeat - 5,
            secret: true as const,
          })),
          result: { kind: "miss" },
        },
      });
      append({ type: "phase.changed", payload: { to: "night-don" } });
      append({ type: "don.check-skipped", payload: {} });
      append({ type: "sheriff.check-skipped", payload: {} });
      append({ type: "phase.changed", payload: { to: night === 3 ? "draw" : "day" } });
    }
    return history();
  }
  append({ type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: 7 } });
  append({ type: "player.nominated", payload: { nominatorSeat: 2, candidateSeat: 6 } });
  append({
    type: "foul.issued",
    payload: { seat: outcome === "completed" ? 9 : 5, foulNumber: 1, redCarded: false },
  });
  append({ type: "phase.changed", payload: { to: "voting" } });
  append({ type: "voting.order-announced", payload: {} });
  append({ type: "voting.order-announced", payload: {} });
  append({ type: "voting.candidate-inspected", payload: { candidateSeat: 6 } });
  append({ type: "voting.candidate-mentioned", payload: { candidateSeat: 7 } });
  append({ type: "voting.candidate-mentioned", payload: { candidateSeat: 7 } });
  append({ type: "vote.accepted", payload: { voterSeat: 1, candidateSeat: 7 } });
  append({ type: "voting.count-disputed", payload: { candidateSeat: 7, reason: "Missed hand" } });
  append({
    type: "voting.count-ruled",
    payload: {
      voteAssignments: { 1: 7 },
      externalReviewAcknowledged: true,
      reason: "Final reviewed count",
    },
  });
  append({
    type: "vote.corrected",
    payload: { voterSeat: 1, candidateSeat: null, reason: "Obvious transcription slip" },
  });
  append({
    type: "vote.corrected",
    payload: { voterSeat: 1, candidateSeat: 7, reason: "Accepted hand restored" },
  });
  for (const voterSeat of [2, 3, 4, 5, 6])
    append({ type: "vote.accepted", payload: { voterSeat, candidateSeat: 7 } });
  append({ type: "voting.candidate-stopped", payload: { candidateSeat: 7 } });
  append({ type: "voting.live-advanced", payload: { candidateSeat: 6 } });
  append({ type: "voting.candidate-mentioned", payload: { candidateSeat: 6 } });
  append({ type: "voting.candidate-mentioned", payload: { candidateSeat: 6 } });
  append({ type: "voting.candidate-stopped", payload: { candidateSeat: 6 } });
  append({
    type: "voting.resolved",
    payload: {
      voteAssignments: { 1: 7, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 6, 8: 6, 9: 6, 10: 6 },
      result: { kind: "winner", seats: [7], totals: { 7: 6, 6: 4 } },
    },
  });
  append({ type: "phase.changed", payload: { to: "night-mafia" } });
  append({
    type: "mafia.shots-resolved",
    payload: {
      shots: [8, 9, 10].map((shooterSeat) => ({
        shooterSeat,
        targetSeat: 2,
        secret: true as const,
      })),
      result: { kind: "kill", targetSeat: 2 },
    },
  });
  append({ type: "phase.changed", payload: { to: "night-don" } });
  append({ type: "don.checked", payload: { targetSeat: 1, match: true } });
  append({ type: "sheriff.checked", payload: { targetSeat: 10, match: true } });
  append({ type: "phase.changed", payload: { to: "night-resolution" } });
  append({ type: "phase.changed", payload: { to: "best-move" } });
  append({ type: "best-move.number-accepted", payload: { seat: 8 } });
  append({ type: "best-move.number-accepted", payload: { seat: 8 } });
  append({
    type: "best-move.slip-corrected",
    payload: { index: 1, seat: 9, reason: "Obvious spoken slip" },
  });
  append({
    type: "best-move.finalized",
    payload: { reason: "finished-early", readbackAcknowledged: true },
  });
  append({ type: "phase.changed", payload: { to: "goodbye-speech" } });
  append({ type: "phase.changed", payload: { to: "day" } });
  if (outcome === "completed") {
    append({ type: "foul.issued", payload: { seat: 9, foulNumber: 2, redCarded: false } });
    append({ type: "foul.issued", payload: { seat: 9, foulNumber: 3, redCarded: false } });
    append({
      type: "discipline.foul-issued",
      payload: {
        seat: 9,
        foulNumber: 4,
        redCarded: true,
        removal: {
          seat: 9,
          stage: "day-discussion",
          rule: "6.2.1",
          reason: "Fourth observed speech violation",
          checkInProgress: false,
        },
      },
    });
  } else {
    append({
      type: "discipline.removal-observed",
      payload: {
        seat: 9,
        stage: "day-discussion",
        rule: "6.2.3",
        reason: "Referee observed prohibited interaction",
        checkInProgress: false,
      },
    });
  }
  append({ type: "discipline.removals-announced", payload: { seats: [9] } });
  append({ type: "voting.legally-skipped", payload: { reason: "disciplinary-cancellation" } });
  append({ type: "phase.changed", payload: { to: "night-mafia" } });
  append({ type: "mafia.multiple-shot-observed", payload: { shooterSeat: 8 } });
  append({
    type: "mafia.shots-resolved",
    payload: {
      shots: [8, 10].map((shooterSeat) => ({ shooterSeat, targetSeat: 3, secret: true as const })),
      result: { kind: "miss" },
    },
  });
  append({ type: "phase.changed", payload: { to: "night-don" } });
  append({ type: "don.check-skipped", payload: {} });
  append({ type: "sheriff.check-skipped", payload: {} });
  append({ type: "phase.changed", payload: { to: "day" } });
  if (outcome === "adjudicated") {
    append({
      type: "game.adjudicated",
      payload: {
        losingTeam: "black",
        offenderSeat: 10,
        rule: "6.3.5",
        reason: "Committee-approved disciplinary loss",
        committeeApproved: true,
      },
    });
  } else {
    for (const seat of [8, 10]) {
      append({
        type: "discipline.removal-observed",
        payload: {
          seat,
          stage: "day-discussion",
          rule: "6.2.3",
          reason: "Referee observed prohibited interaction",
          checkInProgress: false,
        },
      });
      append({ type: "discipline.removals-announced", payload: { seats: [seat] } });
    }
  }
  append({ type: "game.completed", payload: { winner: "red" } });
  return history();
};

export const createSampleGameHistory = (): SampleGameHistory => createCurrentSample("completed");
/** Current judge-decision scenario; the name does not select a different engine or schema. */
export const createFederationSampleGameHistory = (
  outcome: "adjudicated" | "rules-draw" = "adjudicated",
): SampleGameHistory => createCurrentSample(outcome);
