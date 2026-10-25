import {
  MAX_NOTEBOOK_DAYS,
  type NotebookCell,
  type NotebookGameCreation,
  type NotebookParticipant,
  type NotebookSeatRole,
  type Role,
} from "@mafia/game-domain";

export interface ParsedNotebookCell {
  readonly nomination?: number;
  readonly eliminated?: true;
}

/** Empty is an unknown observation, not a no-action observation. */
export const parseNotebookCell = (
  value: string,
  phase: "day" | "night",
): ParsedNotebookCell | null => {
  const text = value.trim().replace(/[хХx]/g, "X");
  if (text === "") return {};
  if (text === "X") return { eliminated: true };
  if (phase === "night") return null;
  const match = /^(10|[1-9])(?:\s*X)?$/.exec(text);
  if (match === null) return null;
  return { nomination: Number(match[1]), ...(text.endsWith("X") ? { eliminated: true } : {}) };
};

export interface NotebookPlayer {
  readonly id: string;
  readonly nickname: string;
}
export interface NotebookRowDraft {
  readonly playerId: string;
  readonly role: Role | "";
  readonly cells: readonly string[];
}
export interface NotebookDraft {
  readonly name: string;
  readonly playedAt: string;
  readonly hostPlayerId: string;
  readonly outcome: "" | "red" | "black" | "draw" | "cancelled";
  readonly dayCount: number;
  readonly rows: readonly NotebookRowDraft[];
  readonly bestMoveOwner: string;
  readonly bestMoveTargets: readonly string[];
}
export const createNotebookDraft = (): NotebookDraft => ({
  name: "",
  playedAt: "",
  hostPlayerId: "",
  outcome: "",
  dayCount: 5,
  rows: Array.from({ length: 10 }, () => ({
    playerId: "",
    role: "",
    cells: Array<string>(10).fill(""),
  })),
  bestMoveOwner: "",
  bestMoveTargets: ["", "", ""],
});

export type NotebookError =
  | "nameError"
  | "dateError"
  | "rosterError"
  | "playerError"
  | "duplicateError"
  | "hostError"
  | "dayError"
  | "nightError"
  | "targetsError"
  | "daysError";
export type NotebookErrors = Readonly<Record<string, NotebookError>>;
export const cellKey = (seat: number, index: number): string => `cell-${seat}-${index}`;
const seatNumber = (value: string): number | null =>
  /^(10|[1-9])$/.test(value) ? Number(value) : null;

export const buildNotebookCreation = (
  draft: NotebookDraft,
  players: readonly NotebookPlayer[],
  creationId: string,
): { readonly payload: NotebookGameCreation | null; readonly errors: NotebookErrors } => {
  const errors: Record<string, NotebookError> = {};
  const identities = new Set(players.map(({ id }) => id));
  const selected = new Set<string>();
  const cells: NotebookCell[] = [];
  const seatRoles: NotebookSeatRole[] = [];
  const participants: NotebookParticipant[] = [];
  if (draft.name.trim().length === 0 || draft.name.trim().length > 100) errors.name = "nameError";
  if (!Number.isInteger(draft.dayCount) || draft.dayCount < 1 || draft.dayCount > MAX_NOTEBOOK_DAYS)
    errors.days = "daysError";
  const playedDate = draft.playedAt === "" ? null : new Date(draft.playedAt);
  if (playedDate !== null) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(draft.playedAt);
    const actual = [
      playedDate.getFullYear(),
      playedDate.getMonth() + 1,
      playedDate.getDate(),
      playedDate.getHours(),
      playedDate.getMinutes(),
    ];
    if (
      parts === null ||
      !Number.isFinite(playedDate.getTime()) ||
      actual.some((part, index) => part !== Number(parts[index + 1]))
    )
      errors.playedAt = "dateError";
  }
  if (draft.hostPlayerId !== "" && !identities.has(draft.hostPlayerId)) errors.host = "hostError";
  if (draft.rows.length !== 10) errors.roster = "rosterError";
  draft.rows.forEach((row, index) => {
    const seat = index + 1;
    if (row.playerId !== "") {
      if (!identities.has(row.playerId)) errors[`player-${seat}`] = "playerError";
      if (selected.has(row.playerId)) errors[`player-${seat}`] = "duplicateError";
      if (row.playerId === draft.hostPlayerId) errors.host = "hostError";
      selected.add(row.playerId);
    }
    if (row.role !== "") seatRoles.push({ seat, role: row.role });
    row.cells.slice(0, draft.dayCount * 2).forEach((text, column) => {
      const phase = column % 2 === 0 ? "day" : "night";
      const observation = parseNotebookCell(text, phase);
      if (observation === null)
        errors[cellKey(seat, column)] = phase === "day" ? "dayError" : "nightError";
      else if (observation.nomination !== undefined || observation.eliminated === true)
        cells.push({ seat, day: Math.floor(column / 2) + 1, phase, ...observation });
    });
    if (row.playerId !== "") {
      const eliminated = cells.some((cell) => cell.seat === seat && cell.eliminated === true);
      participants.push({
        playerId: row.playerId,
        seat,
        ...(row.role === ""
          ? {}
          : {
              role: row.role,
              team:
                row.role === "mafia" || row.role === "don" ? ("black" as const) : ("red" as const),
            }),
        ...(eliminated ? { status: "eliminated" as const } : {}),
      });
    }
  });
  if (selected.size === 0) errors.roster = "rosterError";
  const targets = draft.bestMoveTargets.filter((target) => target !== "").map(seatNumber);
  const ownerSeat = draft.bestMoveOwner === "" ? null : seatNumber(draft.bestMoveOwner);
  if (
    targets.length > 3 ||
    targets.some((target) => target === null) ||
    new Set(targets).size !== targets.length ||
    (draft.bestMoveOwner !== "" && ownerSeat === null)
  )
    errors.bestMove = "targetsError";
  if (Object.keys(errors).length > 0) return { payload: null, errors };
  const targetSeats = targets.filter((target): target is number => target !== null);
  const targetRoles = targetSeats.map((seat) => draft.rows[seat - 1]?.role);
  const owner = participants.find((player) => player.seat === ownerSeat);
  const hitsKnown =
    owner !== undefined &&
    targetSeats.length > 0 &&
    targetRoles.every((role) => role !== undefined && role !== "");
  return {
    errors,
    payload: {
      creationId,
      name: draft.name.trim(),
      state: {
        notebook: {
          dayCount: draft.dayCount,
          cells,
          ...(seatRoles.length === 0 ? {} : { seatRoles }),
          ...(targetSeats.length > 0 || ownerSeat !== null
            ? { bestMove: { ...(ownerSeat === null ? {} : { ownerSeat }), targetSeats } }
            : {}),
        },
      },
      results: {
        players: participants.map((player) =>
          hitsKnown && player === owner
            ? {
                ...player,
                bestMoveHits: targetRoles.filter((role) => role === "mafia" || role === "don")
                  .length,
              }
            : player,
        ),
        ...(draft.hostPlayerId === "" ? {} : { hostPlayerId: draft.hostPlayerId }),
        ...(playedDate === null ? {} : { playedAt: playedDate.toISOString() }),
        ...(draft.outcome === ""
          ? {}
          : {
              outcome: draft.outcome,
              winner: draft.outcome === "red" || draft.outcome === "black" ? draft.outcome : null,
            }),
      },
    },
  };
};
