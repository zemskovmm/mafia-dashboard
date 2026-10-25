import {
  MAX_NOTEBOOK_DAYS,
  type NotebookCell,
  type NotebookRecord,
  type NotebookSeatRole,
} from "@mafia/game-domain";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maximum;

/** Bounded admission of saved notebook detail; never admit canonical state by cast. */
export const readNotebookRecord = (value: unknown): NotebookRecord | null => {
  if (
    !object(value) ||
    !integer(value.dayCount, MAX_NOTEBOOK_DAYS) ||
    !Array.isArray(value.cells) ||
    value.cells.length > value.dayCount * 20
  )
    return null;
  const dayCount = value.dayCount;
  const seatRoles: NotebookSeatRole[] = [];
  if (value.seatRoles !== undefined) {
    if (!Array.isArray(value.seatRoles) || value.seatRoles.length > 10) return null;
    for (const candidate of value.seatRoles) {
      if (!object(candidate) || !integer(candidate.seat, 10)) return null;
      const { seat, role } = candidate;
      if (role !== "citizen" && role !== "mafia" && role !== "don" && role !== "sheriff")
        return null;
      if (seatRoles.some((entry) => entry.seat === seat)) return null;
      seatRoles.push({ seat, role });
    }
  }
  const keys = new Set<string>();
  const cells: NotebookCell[] = [];
  for (const candidate of value.cells) {
    if (
      !object(candidate) ||
      !integer(candidate.seat, 10) ||
      !integer(candidate.day, dayCount) ||
      (candidate.phase !== "day" && candidate.phase !== "night")
    )
      return null;
    const { seat, day, phase, nomination, eliminated } = candidate;
    if (nomination !== undefined && (phase !== "day" || !integer(nomination, 10))) return null;
    if (eliminated !== undefined && eliminated !== true) return null;
    if (nomination === undefined && eliminated !== true) return null;
    const key = `${seat}:${day}:${phase}`;
    if (keys.has(key)) return null;
    keys.add(key);
    cells.push({
      seat,
      day,
      phase,
      ...(nomination === undefined ? {} : { nomination }),
      ...(eliminated === true ? { eliminated: true } : {}),
    });
  }
  const record = { dayCount, cells, ...(value.seatRoles === undefined ? {} : { seatRoles }) };
  if (value.bestMove === undefined) return record;
  const best = value.bestMove;
  if (
    !object(best) ||
    (best.ownerSeat !== undefined && !integer(best.ownerSeat, 10)) ||
    !Array.isArray(best.targetSeats) ||
    (best.targetSeats.length === 0 && best.ownerSeat === undefined) ||
    best.targetSeats.length > 3 ||
    !best.targetSeats.every((seat) => integer(seat, 10)) ||
    new Set(best.targetSeats).size !== best.targetSeats.length
  )
    return null;
  return {
    ...record,
    bestMove: {
      ...(best.ownerSeat === undefined ? {} : { ownerSeat: best.ownerSeat }),
      targetSeats: [...best.targetSeats],
    },
  };
};
