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
