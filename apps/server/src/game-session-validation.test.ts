import { randomUUID } from "node:crypto";
import { MAX_NOTEBOOK_DAYS, type NotebookRecord } from "@mafia/game-domain";
import { describe, expect, it } from "vitest";
import { gameSessionCreationSchema, gameSessionMutationSchema } from "./game-session-validation.js";

describe("game record transport validation", () => {
  it("accepts opaque browser snapshots without enforcing game or replay rules", () => {
    expect(
      gameSessionCreationSchema.safeParse({
        creationId: randomUUID(),
        name: "Opaque",
        state: { game: { phase: "not-a-server-rule" }, events: [{ malformed: true }] },
        results: { arbitrary: "result" },
      }).success,
    ).toBe(true);
    expect(
      gameSessionMutationSchema.safeParse({
        operation: "snapshot",
        name: "Opaque",
        mutationId: randomUUID(),
        state: { brokenForOldReplay: true },
        results: null,
      }).success,
    ).toBe(true);
  });

  it("validates optional bounded adjudication metadata without deciding gameplay legality", () => {
    const adjudication = {
      losingTeam: "red",
      offenderSeat: 10,
      rule: "external-rule-reference",
      reason: "Recorded referee ruling",
      committeeApproved: false,
    };
    // Unknown rule references and committee requirements belong to the browser domain.
    // The server also does not reconcile winner, phase or replay markers with a ruling.
    const input = {
      creationId: randomUUID(),
      name: "Federation",
      state: {
        game: { phase: "not-a-server-rule" },
        initialGame: { replayVersion: 3 },
        events: [{ replayVersion: 3, malformed: true }],
      },
      results: { winner: "red", reason: null, adjudication },
    };
    expect(gameSessionCreationSchema.parse(input)).toEqual(input);
    const mutation = {
      mutationId: randomUUID(),
      name: input.name,
      state: input.state,
      results: input.results,
    };
    expect(gameSessionMutationSchema.parse(mutation)).toEqual(mutation);

    for (const invalid of [
      null,
      [],
      { ...adjudication, losingTeam: "draw" },
      { ...adjudication, offenderSeat: 0 },
      { ...adjudication, offenderSeat: 11 },
      { ...adjudication, offenderSeat: 1.5 },
      { ...adjudication, offenderSeat: "1" },
      { ...adjudication, offenderSeat: null },
      { ...adjudication, rule: "" },
      { ...adjudication, rule: " " },
      { ...adjudication, rule: " rule " },
      { ...adjudication, rule: "r".repeat(101) },
      { ...adjudication, reason: "" },
      { ...adjudication, reason: " " },
      { ...adjudication, reason: " reason " },
      { ...adjudication, reason: "r".repeat(501) },
      { ...adjudication, committeeApproved: "true" },
      { ...adjudication, committeeApproved: null },
      { ...adjudication, nickname: "Copied profile" },
      { ...adjudication, offenderPlayerId: randomUUID() },
      { losingTeam: "red", rule: "6.3.1", reason: "Missing acknowledgement" },
    ]) {
      for (const [schema, envelope] of [
        [gameSessionCreationSchema, input],
        [gameSessionMutationSchema, mutation],
      ] as const) {
        expect(schema.safeParse({ ...envelope, results: { adjudication: invalid } }).success).toBe(
          false,
        );
      }
    }
    const boundary = {
      losingTeam: "black",
      rule: "r".repeat(100),
      reason: "r".repeat(500),
      committeeApproved: true,
    };
    expect(
      gameSessionCreationSchema.parse({ ...input, results: { adjudication: boundary } }).results,
    ).toEqual({ adjudication: boundary });
  });

  describe.each([
    ["creation", gameSessionCreationSchema, { creationId: randomUUID() }],
    ["mutation", gameSessionMutationSchema, { mutationId: randomUUID() }],
  ] as const)("%s notebook shape", (_kind, schema, identity) => {
    const envelope = (notebook: unknown) => ({
      ...identity,
      name: "Notebook",
      state: { notebook },
      results: { players: [] },
    });
    const cell = { seat: 1, day: 1, phase: "day", nomination: 4 };
    const minimal = { dayCount: 1, cells: [] };

    it("retains sparse and combined observations exactly without applying game rules", () => {
      const notebook: NotebookRecord = {
        dayCount: 2,
        cells: [
          { seat: 1, day: 1, phase: "day", nomination: 4, eliminated: true },
          { seat: 4, day: 1, phase: "night", eliminated: true },
          // Repeated eliminations, self-nomination and an unseated Best Move owner
          // are factual transport, not something for server rule adjudication.
          { seat: 4, day: 2, phase: "night", eliminated: true },
          { seat: 10, day: 2, phase: "day", nomination: 10 },
        ],
        bestMove: { ownerSeat: 9, targetSeats: [1, 4, 10] },
      };
      const input = envelope(notebook);
      expect(schema.parse(input)).toEqual(input);
      for (const accepted of [
        minimal,
        { ...minimal, bestMove: { targetSeats: [10] } },
        { ...minimal, bestMove: { ownerSeat: 1, targetSeats: [1] } },
        { ...minimal, bestMove: { ownerSeat: 1, targetSeats: [] } },
      ]) {
        const sparse = envelope(accepted);
        expect(schema.parse(sparse)).toEqual(sparse);
      }
    });

    it("admits all 400 distinct coordinates at the bounded day limit", () => {
      const cells = Array.from({ length: MAX_NOTEBOOK_DAYS }, (_, day) =>
        Array.from({ length: 10 }, (_, seat) =>
          (["day", "night"] as const).map((phase) => ({
            seat: seat + 1,
            day: day + 1,
            phase,
            eliminated: true as const,
          })),
        ).flat(),
      ).flat();
      expect(cells).toHaveLength(400);
      const input = envelope({ dayCount: MAX_NOTEBOOK_DAYS, cells });
      expect(schema.parse(input)).toEqual(input);
    });

    it.each([
      ["null notebook", null],
      ["array notebook", []],
      ["missing day count", { cells: [] }],
      ["missing cells", { dayCount: 1 }],
      ["zero day count", { ...minimal, dayCount: 0 }],
      ["too many days", { ...minimal, dayCount: MAX_NOTEBOOK_DAYS + 1 }],
      ["fractional day count", { ...minimal, dayCount: 1.5 }],
      ["string day count", { ...minimal, dayCount: "1" }],
      ["null day count", { ...minimal, dayCount: null }],
      ["unknown notebook key", { ...minimal, note: "not part of the contract" }],
      ["non-array cells", { ...minimal, cells: {} }],
      ["null cell", { ...minimal, cells: [null] }],
      ["array cell", { ...minimal, cells: [[]] }],
      ["missing seat", { ...minimal, cells: [{ day: 1, phase: "day", nomination: 4 }] }],
      ["seat zero", { ...minimal, cells: [{ ...cell, seat: 0 }] }],
      ["seat eleven", { ...minimal, cells: [{ ...cell, seat: 11 }] }],
      ["fractional seat", { ...minimal, cells: [{ ...cell, seat: 1.5 }] }],
      ["string seat", { ...minimal, cells: [{ ...cell, seat: "1" }] }],
      ["missing day", { ...minimal, cells: [{ seat: 1, phase: "day", nomination: 4 }] }],
      ["day zero", { ...minimal, cells: [{ ...cell, day: 0 }] }],
      ["day beyond count", { ...minimal, cells: [{ ...cell, day: 2 }] }],
      ["fractional day", { ...minimal, cells: [{ ...cell, day: 1.5 }] }],
      ["string day", { ...minimal, cells: [{ ...cell, day: "1" }] }],
      ["missing phase", { ...minimal, cells: [{ seat: 1, day: 1, nomination: 4 }] }],
      ["unknown phase", { ...minimal, cells: [{ ...cell, phase: "vote" }] }],
      ["no observation", { ...minimal, cells: [{ seat: 1, day: 1, phase: "day" }] }],
      ["nomination zero", { ...minimal, cells: [{ ...cell, nomination: 0 }] }],
      ["nomination eleven", { ...minimal, cells: [{ ...cell, nomination: 11 }] }],
      ["fractional nomination", { ...minimal, cells: [{ ...cell, nomination: 4.5 }] }],
      ["string nomination", { ...minimal, cells: [{ ...cell, nomination: "4" }] }],
      ["null nomination", { ...minimal, cells: [{ ...cell, nomination: null }] }],
      ["night number", { ...minimal, cells: [{ ...cell, phase: "night" }] }],
      [
        "combined night number",
        { ...minimal, cells: [{ ...cell, phase: "night", eliminated: true }] },
      ],
      ["false elimination", { ...minimal, cells: [{ ...cell, eliminated: false }] }],
      ["numeric elimination", { ...minimal, cells: [{ ...cell, eliminated: 1 }] }],
      ["X elimination", { ...minimal, cells: [{ ...cell, eliminated: "X" }] }],
      ["null elimination", { ...minimal, cells: [{ ...cell, eliminated: null }] }],
      ["unknown cell key", { ...minimal, cells: [{ ...cell, votes: 4 }] }],
      ["copied cell name", { ...minimal, cells: [{ ...cell, name: "Profile name" }] }],
      [
        "duplicate coordinate",
        { ...minimal, cells: [cell, { seat: 1, day: 1, phase: "day", eliminated: true }] },
      ],
      ["too many cells", { ...minimal, cells: Array.from({ length: 401 }, () => cell) }],
      ["null Best Move", { ...minimal, bestMove: null }],
      ["array Best Move", { ...minimal, bestMove: [] }],
      ["missing targets", { ...minimal, bestMove: { ownerSeat: 1 } }],
      ["empty targets", { ...minimal, bestMove: { targetSeats: [] } }],
      ["too many targets", { ...minimal, bestMove: { targetSeats: [1, 2, 3, 4] } }],
      ["duplicate targets", { ...minimal, bestMove: { targetSeats: [1, 1] } }],
      ["zero target", { ...minimal, bestMove: { targetSeats: [0] } }],
      ["eleven target", { ...minimal, bestMove: { targetSeats: [11] } }],
      ["fractional target", { ...minimal, bestMove: { targetSeats: [1.5] } }],
      ["string target", { ...minimal, bestMove: { targetSeats: ["1"] } }],
      ["zero owner", { ...minimal, bestMove: { ownerSeat: 0, targetSeats: [1] } }],
      ["eleven owner", { ...minimal, bestMove: { ownerSeat: 11, targetSeats: [1] } }],
      ["fractional owner", { ...minimal, bestMove: { ownerSeat: 1.5, targetSeats: [1] } }],
      ["string owner", { ...minimal, bestMove: { ownerSeat: "1", targetSeats: [1] } }],
      ["null owner", { ...minimal, bestMove: { ownerSeat: null, targetSeats: [1] } }],
      ["unknown Best Move key", { ...minimal, bestMove: { targetSeats: [1], hits: 0 } }],
    ])("rejects %s rather than stripping or coercing accepted JSON", (_label, notebook) => {
      expect(schema.safeParse(envelope(notebook)).success).toBe(false);
    });

    it("leaves arbitrary outer snapshot and results data unchanged", () => {
      const input = {
        ...envelope(minimal),
        state: { notebook: minimal, opaque: { precision: "0001.2300", list: [null, false] } },
        results: { arbitrary: "result", players: [] },
      };
      expect(schema.parse(input)).toEqual(input);
      const withoutNotebook = {
        ...input,
        state: { arbitrary: { dayCount: -1, cells: "not notebook observations" } },
      };
      expect(schema.parse(withoutNotebook)).toEqual(withoutNotebook);
    });
  });

  it("still rejects malformed record envelopes", () => {
    expect(
      gameSessionCreationSchema.safeParse({
        creationId: "not-a-uuid",
        name: "",
        state: {},
        results: null,
      }).success,
    ).toBe(false);
    expect(
      gameSessionMutationSchema.safeParse({
        name: "valid",
        mutationId: randomUUID(),
        state: [],
        results: null,
      }).success,
    ).toBe(false);
  });
});
