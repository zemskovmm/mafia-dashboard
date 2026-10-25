import { describe, expect, it } from "vitest";
import {
  buildNotebookCreation,
  createNotebookDraft,
  parseNotebookCell,
  type NotebookDraft,
} from "./notebook-model.js";
import { readNotebookRecord } from "./notebook-import.js";

describe("manual notebook notation", () => {
  it("keeps blanks unknown, accepts both X alphabets, and rejects invented night actions", () => {
    expect(parseNotebookCell("  ", "day")).toEqual({});
    for (const mark of ["x", "X", "х", "Х"]) {
      expect(parseNotebookCell(mark, "night")).toEqual({ eliminated: true });
      expect(parseNotebookCell(`10${mark}`, "day")).toEqual({ nomination: 10, eliminated: true });
    }
    for (const notation of ["0", "11", "-1", "4.5", "01", "4 XX", "4 5", "•", "*"])
      expect(parseNotebookCell(notation, "day")).toBeNull();
    for (const notation of ["4", "4X", "shot 4", "*"])
      expect(parseNotebookCell(notation, "night")).toBeNull();
  });
  it("retains a nomination and Cyrillic elimination mark in the same day cell", () => {
    expect(parseNotebookCell("4 х", "day")).toEqual({ nomination: 4, eliminated: true });
    expect(parseNotebookCell("4 X", "night")).toBeNull();
  });
});

const players = [
  { id: "a", nickname: "Alice" },
  { id: "b", nickname: "Boris" },
  { id: "c", nickname: "Cleo" },
];
const sparseDraft = (): NotebookDraft => {
  const draft = createNotebookDraft();
  return {
    ...draft,
    name: "Paper",
    rows: draft.rows.map((row, index) => (index === 0 ? { ...row, playerId: "a" } : row)),
  };
};

describe("sparse notebook creation", () => {
  it("uses the server's label limit and rejects normalized invalid calendar dates", () => {
    expect(
      buildNotebookCreation({ ...sparseDraft(), name: "a".repeat(100) }, players, "id").payload,
    ).not.toBeNull();
    expect(
      buildNotebookCreation({ ...sparseDraft(), name: "a".repeat(101) }, players, "id").errors.name,
    ).toBe("nameError");
    expect(
      buildNotebookCreation({ ...sparseDraft(), playedAt: "2026-02-30T19:30" }, players, "id")
        .errors.playedAt,
    ).toBe("dateError");
  });

  it("retains a known Best Move owner without inventing targets or zero hits", () => {
    const payload = buildNotebookCreation(
      { ...sparseDraft(), bestMoveOwner: "1" },
      players,
      "id",
    ).payload;
    expect(payload?.state.notebook.bestMove).toEqual({ ownerSeat: 1, targetSeats: [] });
    expect(payload?.results.players[0]).not.toHaveProperty("bestMoveHits");
  });
  it("omits every missing fact rather than inventing alive players, time, zeros or a winner", () => {
    const payload = buildNotebookCreation(sparseDraft(), players, "creation").payload;
    expect(payload).toEqual({
      creationId: "creation",
      name: "Paper",
      state: { notebook: { dayCount: 5, cells: [] } },
      results: { players: [{ playerId: "a", seat: 1 }] },
    });
  });
  it("records explicit roles/teams and known zero Best Move hits, but never infers an owner", () => {
    const base = sparseDraft();
    const draft: NotebookDraft = {
      ...base,
      bestMoveOwner: "1",
      bestMoveTargets: ["2", "", ""],
      rows: base.rows.map((row, index) =>
        index === 1 ? { ...row, playerId: "b", role: "citizen" } : row,
      ),
    };
    expect(buildNotebookCreation(draft, players, "creation").payload?.results.players).toEqual([
      { playerId: "a", seat: 1, bestMoveHits: 0 },
      { playerId: "b", seat: 2, role: "citizen", team: "red" },
    ]);
    expect(
      buildNotebookCreation({ ...draft, bestMoveOwner: "" }, players, "creation").payload?.results
        .players[0],
    ).not.toHaveProperty("bestMoveHits");
    expect(
      buildNotebookCreation({ ...draft, bestMoveTargets: ["3", "", ""] }, players, "creation")
        .payload?.results.players[0],
    ).not.toHaveProperty("bestMoveHits");
  });
  it("validates duplicate targets, an empty roster, labels and bounded days without a payload", () => {
    for (const draft of [
      createNotebookDraft(),
      { ...sparseDraft(), name: " " },
      { ...sparseDraft(), dayCount: 21 },
      { ...sparseDraft(), bestMoveTargets: ["2", "2", ""] },
    ]) {
      const result = buildNotebookCreation(draft, players, "creation");
      expect(result.payload).toBeNull();
      expect(Object.keys(result.errors).length).toBeGreaterThan(0);
    }
  });
  it("keeps a known seat role and Best Move result independent of an unknown player identity", () => {
    const draft = sparseDraft();
    const result = buildNotebookCreation(
      {
        ...draft,
        bestMoveOwner: "1",
        bestMoveTargets: ["2", "", ""],
        rows: draft.rows.map((row, index) => (index === 1 ? { ...row, role: "don" } : row)),
      },
      players,
      "creation",
    );
    expect(result.errors).toEqual({});
    expect(result.payload?.state.notebook.seatRoles).toEqual([{ seat: 2, role: "don" }]);
    expect(result.payload?.results.players).toEqual([{ playerId: "a", seat: 1, bestMoveHits: 1 }]);
    expect(readNotebookRecord(result.payload?.state.notebook)).toEqual(
      result.payload?.state.notebook,
    );
  });
  it("records only an explicitly supplied played time, host and outcome", () => {
    const payload = buildNotebookCreation(
      { ...sparseDraft(), playedAt: "2026-02-12T19:30", hostPlayerId: "c", outcome: "draw" },
      players,
      "creation",
    ).payload;
    expect(payload?.results).toEqual({
      players: [{ playerId: "a", seat: 1 }],
      playedAt: new Date("2026-02-12T19:30").toISOString(),
      hostPlayerId: "c",
      outcome: "draw",
      winner: null,
    });
  });
});

describe("saved notebook admission", () => {
  it("clones bounded observations and rejects malformed, duplicated and excessive saved cells", () => {
    const cell = { seat: 1, day: 1, phase: "day", nomination: 4, eliminated: true };
    const record = { dayCount: 5, cells: [cell], bestMove: { ownerSeat: 1, targetSeats: [2, 3] } };
    expect(readNotebookRecord(record)).toEqual(record);
    expect(readNotebookRecord(record)).not.toBe(record);
    for (const value of [
      null,
      [],
      {},
      { ...record, dayCount: 21 },
      { ...record, cells: Array(101).fill(cell) },
      { ...record, cells: [cell, cell] },
      { ...record, cells: [{ ...cell, phase: "night" }] },
      { ...record, cells: [{ ...cell, day: 6 }] },
      { ...record, cells: [{ ...cell, seat: 0 }] },
      { dayCount: 1, cells: [{ seat: 1, day: 1, phase: "night", eliminated: false }] },
      { ...record, bestMove: { targetSeats: [2, 2] } },
      { ...record, bestMove: { targetSeats: [1, 2, 3, 4] } },
      { ...record, bestMove: { ownerSeat: "1", targetSeats: [] } },
      { ...record, bestMove: { targetSeats: [] } },
      { ...record, seatRoles: null },
      { ...record, seatRoles: [{ seat: 11, role: "don" }] },
      { ...record, seatRoles: [{ seat: 2, role: "unknown" }] },
      {
        ...record,
        seatRoles: [
          { seat: 2, role: "don" },
          { seat: 2, role: "mafia" },
        ],
      },
      { ...record, seatRoles: Array(11).fill({ seat: 1, role: "citizen" }) },
    ])
      expect(readNotebookRecord(value)).toBeNull();
  });
});
