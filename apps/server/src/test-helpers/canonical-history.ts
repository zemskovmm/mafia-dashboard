import { createHash, randomUUID } from "node:crypto";

import {
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createInitialGameBaseline,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  resolveVote,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type GameState,
  type InitialGameBaseline,
  type SetupState,
} from "@mafia/game-domain";
import type { FinalGameResults } from "../game-session-store.js";

export const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Compare deterministic JSON values while retaining array/transcript/event order exactly.
const sortedJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, entry]) => [key, sortedJson(entry)]),
    );
  return value;
};
export const jsonHash = (value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(sortedJson(value)))
    .digest("hex")}`;

export type CanonicalSnapshot = {
  setup: {
    step: "roles";
    hostPlayerId: string;
    selectedPlayerIds: readonly string[];
    setup: SetupState;
    bestMoveEnabled: boolean;
  };
  game: GameState;
  hostPlayerId: string;
  playlistId: string;
  initialGame: InitialGameBaseline;
  events: GameLogEntry[];
  headEventId: string | null;
  resetReturnEventId: null;
  undoHistory: GameState[];
  undoBudget: number;
  log: never[];
  legacyLog: never[];
};

/** Real unfinished deal and completed setup; no replay chain exists yet. */
export const generateRoleDeal = (hostPlayerId: string, playerIds: readonly string[]) => {
  let setup = beginRoleDraw(
    createSetup(playerIds.map((id, index) => ({ id, seat: index + 1 }))),
    createSeededRandom(71),
  );
  // Capture a real unfinished deal separately: it is not a canonical baseline.
  setup = drawRoleForSeat(setup, 1);
  const draftState = jsonRoundTrip({
    setup: {
      step: "roles",
      hostPlayerId,
      selectedPlayerIds: playerIds,
      setup,
      bestMoveEnabled: true,
    },
    game: null,
    hostPlayerId,
    playlistId: "",
    initialGame: null,
    events: [],
    headEventId: null,
    resetReturnEventId: null,
    undoHistory: [],
    undoBudget: 3,
    log: [],
    legacyLog: [],
  });
  for (let seat = 2; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  setup = completeRoleDraw(setup);
  return { draftState, setup };
};

/** All accepted states come from reducers via the real canonical event factory. */
export const createCanonicalHistory = (
  gameId: string,
  hostPlayerId: string,
  playerIds: readonly string[],
) => {
  const { draftState, setup } = generateRoleDeal(hostPlayerId, playerIds);
  let game = createGame(setup);
  const baseline = createInitialGameBaseline(game);
  const entries: GameLogEntry[] = [];
  const append = (draft: CanonicalGameEventDraft) => {
    const { entry, after } = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: entries.length + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: new Date(Date.UTC(2026, 9, 14, 8, 0, entries.length)).toISOString(),
      before: game,
      draft,
    });
    entries.push(entry);
    game = after;
    return game;
  };
  const snapshot = (): CanonicalSnapshot =>
    jsonRoundTrip({
      setup: {
        step: "roles",
        hostPlayerId,
        selectedPlayerIds: playerIds,
        setup,
        bestMoveEnabled: true,
      },
      game,
      hostPlayerId,
      playlistId: "",
      initialGame: baseline,
      events: entries,
      headEventId: entries.at(-1)?.id ?? null,
      resetReturnEventId: null,
      undoHistory: [],
      undoBudget: 3,
      log: [],
      legacyLog: [],
    });
  append({ type: "game.started", payload: {} });
  for (const to of [
    "mafia-sleep",
    "don-identification",
    "sheriff-identification",
    "free-seating",
    "day",
  ] as const)
    append({ type: "phase.changed", payload: { to } });
  return { draftState, append, snapshot, current: () => game };
};

export const generateBestMoveAndBallot = (
  history: ReturnType<typeof createCanonicalHistory>,
  completion: "finished-early" | "declined",
) => {
  const { append, snapshot, current } = history;
  const victim = current().players.find(({ role }) => role === "citizen")!.seat;
  const blackSeat = current().players.find(({ team }) => team === "black")!.seat;
  const shots = current()
    .players.filter(({ team }) => team === "black")
    .map(({ seat }) => ({ shooterSeat: seat, targetSeat: victim, secret: true as const }));
  append({ type: "phase.changed", payload: { to: "night-mafia" } });
  append({
    type: "mafia.shots-resolved",
    payload: { shots, result: { kind: "kill", targetSeat: victim } },
  });
  append({ type: "phase.changed", payload: { to: "night-don" } });
  append({ type: "don.check-skipped", payload: {} });
  append({ type: "sheriff.check-skipped", payload: {} });
  append({ type: "phase.changed", payload: { to: "best-move" } });
  if (completion === "finished-early") {
    append({ type: "best-move.number-accepted", payload: { seat: victim } });
    append({ type: "best-move.number-accepted", payload: { seat: victim } });
    append({
      type: "best-move.slip-corrected",
      payload: {
        index: 1,
        seat: blackSeat,
        reason: "Obvious spoken slip — not a strategic replacement",
      },
    });
  }
  const partialBestMove = snapshot();
  append({
    type: "best-move.finalized",
    payload: { reason: completion, readbackAcknowledged: true },
  });
  const finalizedBestMove = snapshot();
  append({ type: "phase.changed", payload: { to: "goodbye-speech" } });
  append({ type: "phase.changed", payload: { to: "day" } });
  const [first, second] = current().turnOrder;
  append({ type: "player.nominated", payload: { nominatorSeat: first!, candidateSeat: first! } });
  append({ type: "player.nominated", payload: { nominatorSeat: second!, candidateSeat: second! } });
  append({ type: "phase.changed", payload: { to: "voting" } });
  append({ type: "voting.order-announced", payload: {} });
  append({ type: "voting.order-announced", payload: {} });
  append({ type: "voting.candidate-inspected", payload: { candidateSeat: second! } });
  append({ type: "voting.candidate-mentioned", payload: { candidateSeat: first! } });
  append({ type: "voting.candidate-mentioned", payload: { candidateSeat: first! } });
  append({ type: "vote.accepted", payload: { voterSeat: first!, candidateSeat: first! } });
  append({
    type: "voting.count-disputed",
    payload: { candidateSeat: first!, reason: "Missed hand; recording review required" },
  });
  const dispute = snapshot();
  append({
    type: "voting.count-ruled",
    payload: {
      voteAssignments: { [first!]: first! },
      externalReviewAcknowledged: true,
      reason: "Final count after external recording review",
    },
  });
  const ruling = snapshot();
  append({ type: "voting.candidate-stopped", payload: { candidateSeat: first! } });
  append({
    type: "vote.corrected",
    payload: {
      voterSeat: first!,
      candidateSeat: second!,
      reason: "Clerical assignment correction",
    },
  });
  append({ type: "voting.live-advanced", payload: { candidateSeat: second! } });
  append({ type: "voting.candidate-mentioned", payload: { candidateSeat: second! } });
  append({ type: "voting.candidate-mentioned", payload: { candidateSeat: second! } });
  append({ type: "voting.candidate-stopped", payload: { candidateSeat: second! } });
  const acceptedVotes = Object.fromEntries(
    Object.entries(current().voteAssignments).map(([seat, target]) => {
      if (target === undefined) throw new Error(`Unaccepted vote for seat ${seat}`);
      return [seat, target];
    }),
  );
  append({
    type: "voting.resolved",
    payload: { voteAssignments: acceptedVotes, result: resolveVote(current()) },
  });
  return {
    partialBestMove,
    finalizedBestMove,
    dispute,
    ruling,
    closedBallot: snapshot(),
    victim,
    blackSeat,
  };
};

export const generateAutomaticDraw = (history: ReturnType<typeof createCanonicalHistory>) => {
  for (const to of ["day", "draw"] as const) {
    history.append({ type: "phase.changed", payload: { to: "night-mafia" } });
    history.append({
      type: "mafia.shots-resolved",
      payload: { shots: [], result: { kind: "miss" } },
    });
    history.append({ type: "phase.changed", payload: { to: "night-don" } });
    history.append({ type: "don.check-skipped", payload: {} });
    history.append({ type: "sheriff.check-skipped", payload: {} });
    history.append({ type: "phase.changed", payload: { to } });
  }
  return history.snapshot();
};

/** Use the real browser Finish/result builder without changing web files. */
export const buildAcceptedResults = async (
  snapshot: CanonicalSnapshot,
  reason: string | null = null,
): Promise<FinalGameResults> => {
  const source = new URL("../../../web/src/features/players/game-results.ts", import.meta.url).href;
  // eslint-disable-next-line no-unsanitized/method -- Fixed repository-local source, never external input.
  const { buildFinalGameResults } = (await import(/* @vite-ignore */ source)) as {
    buildFinalGameResults: (
      game: GameState,
      at: Date,
      hostId: string,
      reason?: string | null,
    ) => FinalGameResults | null;
  };
  const result = buildFinalGameResults(
    snapshot.game,
    new Date("2026-10-14T08:30:00.000Z"),
    snapshot.hostPlayerId,
    reason,
  );
  if (result === null) throw new Error("The real Finish builder did not produce terminal results");
  return jsonRoundTrip(result);
};
