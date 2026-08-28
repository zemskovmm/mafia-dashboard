import {
  CURRENT_REPLAY_VERSION,
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
  Array.from({ length: 10 }, (_, index) => ({
    id: `sample-player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));

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
  for (const [index, role] of rolesBySeat.entries()) {
    setup = assignRoleForSeat(setup, index + 1, role);
  }
  return createGame(completeRoleDraw(setup));
};

const eventId = (sequence: number): string =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

const eventTime = (sequence: number): string =>
  new Date(SAMPLE_STARTED_AT + sequence * 60_000).toISOString();

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

export const createSampleGameHistory = (): SampleGameHistory => {
  const baseline: InitialGameBaseline = deepFreeze({
    replayVersion: CURRENT_REPLAY_VERSION,
    game: createInitialGame(),
  });
  const entries: GameLogEntry[] = [];
  let game = baseline.game;
  let parentEventId: string | null = null;
  let sequence = 0;

  const append = (draft: CanonicalGameEventDraft): GameLogEntry => {
    sequence += 1;
    const created = createGameLogEntry({
      gameId: SAMPLE_GAME_ID,
      id: eventId(sequence),
      sequence,
      parentEventId,
      createdAt: eventTime(sequence),
      before: game,
      draft,
    });
    entries.push(created.entry);
    game = created.after;
    parentEventId = created.entry.id;
    return created.entry;
  };

  append({ type: "game.started", payload: {} });
  append({ type: "phase.changed", payload: { to: "day" } });

  append({
    type: "player.nominated",
    payload: { nominatorSeat: 1, candidateSeat: 7 },
  });
  append({
    type: "foul.issued",
    payload: { seat: 9, foulNumber: 1, redCarded: false },
  });
  const dayOneVotes = Object.fromEntries(
    game.players.filter(({ status }) => status === "active").map(({ seat }) => [seat, 7]),
  );
  append({
    type: "voting.resolved",
    payload: {
      voteAssignments: dayOneVotes,
      result: { kind: "winner", seats: [7], totals: { 7: 10 } },
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
  append({
    type: "don.checked",
    payload: { targetSeat: 1, match: true },
  });
  append({
    type: "sheriff.checked",
    payload: { targetSeat: 10, match: true },
  });
  append({ type: "phase.changed", payload: { to: "night-resolution" } });
  append({
    type: "best-move.completed",
    payload: { playerSeat: 2, selectedSeats: [8, 9, 3], mafiaHits: 2 },
  });
  append({ type: "phase.changed", payload: { to: "day" } });

  append({
    type: "player.nominated",
    payload: { nominatorSeat: 3, candidateSeat: 10 },
  });

  const resetGame = game;
  const resetHeadEventId = parentEventId;
  append({
    type: "foul.issued",
    payload: { seat: 10, foulNumber: 1, redCarded: false },
  });
  game = resetGame;
  parentEventId = resetHeadEventId;

  for (const foulNumber of [2, 3, 4] as const) {
    append({
      type: "foul.issued",
      payload: { seat: 9, foulNumber, redCarded: foulNumber === 4 },
    });
  }
  append({
    type: "voting.skipped",
    payload: { reason: "host-skipped" },
  });
  append({ type: "phase.changed", payload: { to: "night-mafia" } });
  append({
    type: "mafia.shots-resolved",
    payload: {
      shots: [
        { shooterSeat: 8, targetSeat: 3, secret: true },
        { shooterSeat: 10, targetSeat: 4, secret: true },
      ],
      result: { kind: "miss" },
    },
  });
  append({
    type: "player.red-carded",
    payload: { seat: 8 },
  });
  append({
    type: "player.red-carded",
    payload: { seat: 10 },
  });
  append({ type: "game.completed", payload: { winner: "red" } });

  const headEventId = parentEventId!;
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
