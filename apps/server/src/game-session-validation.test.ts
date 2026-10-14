import { randomUUID } from "node:crypto";
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
        game: { phase: "not-a-server-rule", rulesEdition: "mafgame-2026-07-01" },
        initialGame: { replayVersion: 2, rulesEdition: "mafgame-2026-07-01" },
        events: [{ replayVersion: 2, malformed: true }],
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
