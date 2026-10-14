import {
  replayGameLog,
  type GameLogEntry,
  type GameState,
  type InitialGameBaseline,
} from "@mafia/game-domain";

export const getActiveBranch = (
  entries: readonly GameLogEntry[],
  headEventId: string | null,
): readonly GameLogEntry[] => {
  if (headEventId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) throw new Error("Game history contains duplicate event IDs");
  const reversed: GameLogEntry[] = [];
  const visited = new Set<string>();
  let branchGameId: string | null = null;
  let branchHead: GameLogEntry | undefined;
  let currentId: string | null = headEventId;
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error(`Game history contains a cycle at ${currentId}`);
    visited.add(currentId);
    const entry: GameLogEntry | undefined = byId.get(currentId);
    if (entry === undefined) throw new Error(`Game history is missing parent/event ${currentId}`);
    if (branchGameId === null) branchGameId = entry.gameId;
    else if (entry.gameId !== branchGameId) {
      throw new Error(`Game history crosses games at ${entry.id}`);
    }
    if (branchHead === undefined) branchHead = entry;
    else if (
      entry.replayVersion !== branchHead.replayVersion ||
      entry.rulesEdition !== branchHead.rulesEdition
    ) {
      throw new Error(`Game history crosses rules editions or replay versions at ${entry.id}`);
    }
    reversed.push(entry);
    currentId = entry.parentEventId;
  }
  return reversed.reverse();
};

export const replayToEvent = (
  baseline: InitialGameBaseline,
  entries: readonly GameLogEntry[],
  eventId: string,
): GameState => replayGameLog(baseline, getActiveBranch(entries, eventId)).game;

export const getUndoableEvents = (
  activeBranch: readonly GameLogEntry[],
): readonly GameLogEntry[] => {
  let checkpointIndex = -1;
  for (const [index, entry] of activeBranch.entries()) {
    if (entry.dayAfter > entry.dayBefore) checkpointIndex = index;
  }
  return activeBranch
    .slice(checkpointIndex + 1)
    .filter(
      ({ type }) =>
        type !== "game.started" && type !== "game.checkpointed" && type !== "game.completed",
    )
    .slice(-3);
};

export const getRemainingUndoBudget = (
  entries: readonly GameLogEntry[],
  headEventId: string | null,
): number => {
  if (headEventId === null) return 0;
  const activeBranch = getActiveBranch(entries, headEventId);
  const head = activeBranch.at(-1);
  if (head === undefined) return 0;
  const maximumSequence = Math.max(...entries.map(({ sequence }) => sequence));
  const alreadyUndone = Math.max(0, maximumSequence - head.sequence);
  return Math.min(getUndoableEvents(activeBranch).length, Math.max(0, 3 - alreadyUndone));
};
