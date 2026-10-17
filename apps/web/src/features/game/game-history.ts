import {
  assertGameLogEntry,
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

  let currentId: string | null = headEventId;
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error(`Game history contains a cycle at ${currentId}`);
    visited.add(currentId);
    const entry: GameLogEntry | undefined = byId.get(currentId);
    if (entry === undefined) throw new Error(`Game history is missing parent/event ${currentId}`);
    assertGameLogEntry(entry);
    if (branchGameId === null) branchGameId = entry.gameId;
    else if (entry.gameId !== branchGameId) {
      throw new Error(`Game history crosses games at ${entry.id}`);
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

export const getUndoableEvents = (activeBranch: readonly GameLogEntry[]): readonly GameLogEntry[] =>
  activeBranch.filter(
    ({ type }) =>
      type !== "game.started" && type !== "game.checkpointed" && type !== "game.completed",
  );

/** Compatibility name: availability is derived from retained actions, never a quota. */
export const getRemainingUndoBudget = (
  entries: readonly GameLogEntry[],
  headEventId: string | null,
): number => getUndoableEvents(getActiveBranch(entries, headEventId)).length;
