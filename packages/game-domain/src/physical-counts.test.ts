import { describe, expect, it } from "vitest";
import * as domain from "./index.js";
import type { CanonicalGameEventDraft, GameLogEntry, GameState } from "./index.js";
const day = (): GameState => {
  let setup = domain.beginRoleDraw(
    domain.createSetup(
      Array.from({ length: 10 }, (_, i) => ({ id: `physical-${i + 1}`, seat: i + 1 })),
    ),
    domain.createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  let game = domain.createGame(domain.completeRoleDraw(setup));
  game = domain.applyGameEvent(game, {
    type: "phase.changed",
    payload: { to: "sheriff-identification" },
  });
  return domain.applyGameEvent(game, { type: "phase.changed", payload: { to: "day" } });
};
const decision = (): GameState => ({
  ...day(),
  phase: "car-crash-decision",
  carCrashSeats: [1, 2],
  carCrashVotes: {},
});
const roundTrip = (initial: GameState, drafts: readonly CanonicalGameEventDraft[]) => {
  const baseline = domain.createInitialGameBaseline(initial);
  let game = initial;
  const entries: GameLogEntry[] = [];
  for (const draft of [{ type: "game.checkpointed", payload: {} } as const, ...drafts]) {
    const accepted = domain.createGameLogEntry({
      gameId: "physical-counts",
      id: `e${entries.length + 1}`,
      sequence: entries.length + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: "2026-10-14T16:00:00Z",
      before: game,
      draft,
    });
    entries.push(accepted.entry);
    game = accepted.after;
    expect(
      domain.replayGameLog(
        JSON.parse(JSON.stringify(baseline)),
        JSON.parse(JSON.stringify(entries)),
      ).game,
    ).toEqual(JSON.parse(JSON.stringify(game)));
  }
  return { game, entries, baseline };
};
describe("physical counts and observations", () => {
  it("pins current shooter-only observations and conclusive collective closure bytes/hashes", async () => {
    const night = domain.beginNight(day());
    const shooterSeat = night.players.find((p) => p.team === "black")!.seat;
    const oldShot = roundTrip(night, [
      { type: "mafia.multiple-shot-observed", payload: { shooterSeat } },
    ]);
    const votes = { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true };
    const oldCount = roundTrip(decision(), [
      {
        type: "car-crash.ballot-resolved",
        payload: {
          votes,
          result: domain.resolveCarCrashVote({ ...decision(), carCrashVotes: votes }),
        },
      },
    ]);
    expect(
      await Promise.all(
        [oldShot, oldCount].map(async ({ baseline, entries, game }) => ({
          bytes: [
            ...new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(JSON.stringify({ baseline, entries })),
              ),
            ),
          ]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
          hashes: entries.map((e) => e.stateHashAfter),
          hasObservations: Object.hasOwn(game, "shotObservations"),
        })),
      ),
    ).toMatchSnapshot();
  });
  it.each([0, 2, 5, 6])(
    "explicitly completes %i supporting hands without invented no votes",
    (yesVotes) => {
      const initial = decision();
      const votes = Object.fromEntries(Array.from({ length: yesVotes }, (_, i) => [i + 1, true]));
      if (yesVotes <= 5)
        expect(() => domain.resolveCarCrashVote({ ...initial, carCrashVotes: votes })).toThrow();
      const result = { eliminate: yesVotes > 5, seats: [1, 2], yesVotes, eligibleVoters: 10 };
      const { game, entries, baseline } = roundTrip(initial, [
        { type: "car-crash.count-completed", payload: { votes, result } },
      ]);
      expect(game).toMatchObject({
        phase: "car-crash-result",
        carCrashVotes: votes,
        carCrashResult: result,
      });
      expect(Object.keys(game.carCrashVotes ?? {})).toHaveLength(yesVotes);
      expect(domain.replayGameLog(baseline, entries.slice(0, 1)).game.carCrashVotes).toEqual({});
      const continued = domain.applyGameEvent(game, {
        type: "phase.changed",
        payload: {
          to: yesVotes > 5 ? "goodbye-speech" : "night-mafia",
        },
      });
      expect(continued.players.filter((p) => p.status === "eliminated").map((p) => p.seat)).toEqual(
        yesVotes > 5 ? [1, 2] : [],
      );
    },
  );
  it("retains eligibility, phase, exact payload and voter validation on explicit completion", () => {
    const initial = decision();
    const event = {
      type: "car-crash.count-completed",
      payload: {
        votes: {},
        result: { eliminate: false, seats: [1, 2], yesVotes: 0, eligibleVoters: 10 },
      },
    } as const;
    for (const state of [
      day(),
      { ...initial, carCrashSeats: initial.players.map((p) => p.seat) },
      { ...initial, carCrashSeats: [1, 2, 3, 4, 5] },
      { ...initial, carCrashSeats: [] },
      { ...initial, carCrashSeats: [1, 1] },
      { ...initial, carCrashSeats: [1, 11] },
      {
        ...initial,
        carCrashSeats: [1, 2, 3],
        players: initial.players.map((p) =>
          p.seat === 10 ? { ...p, status: "eliminated" as const } : p,
        ),
      },
    ]) {
      expect(domain.tryApplyGameEvent(state, event).ok).toBe(false);
    }
    for (const votes of [{ 11: true }, { "01": true }, { 1: "yes" }, { 1: true }]) {
      expect(
        domain.tryApplyGameEvent(initial, {
          ...event,
          payload: { ...event.payload, votes },
        } as unknown as CanonicalGameEventDraft).ok,
      ).toBe(false);
    }
    const inactive = {
      ...initial,
      players: initial.players.map((p) =>
        p.seat === 10 ? { ...p, status: "eliminated" as const } : p,
      ),
    };
    expect(
      domain.tryApplyGameEvent(inactive, {
        ...event,
        payload: {
          votes: { 10: true },
          result: { ...event.payload.result, eligibleVoters: 9, yesVotes: 1 },
        },
      }).ok,
    ).toBe(false);
    expect(() => domain.assertCanonicalGameEventDraft(event)).not.toThrow();
  });
  it.each([1, 2, 3])(
    "retains unlimited ordered shots for %i shooters across correction/replay/Undo",
    (count) => {
      const initial = domain.beginNight(day());
      const shooters = initial.players.filter((p) => p.team === "black").slice(0, count);
      const available = {
        ...initial,
        players: initial.players.map((p) =>
          p.team === "black" && !shooters.includes(p) ? { ...p, status: "eliminated" as const } : p,
        ),
      };
      const shotAssignments = Object.fromEntries(shooters.map((p) => [p.seat, 9]));
      const observations = Array.from({ length: 24 }, (_, i) => ({
        shooterSeat: shooters[i % count]!.seat,
        targetSeat: i === 23 ? 10 : 9,
      }));
      const { game, baseline, entries } = roundTrip(available, [
        { type: "mafia.shots-observed", payload: { shotAssignments, observations } },
      ]);
      expect(game.shotAssignments).toEqual(shotAssignments);
      expect(game.shotObservations).toEqual(
        observations.map((shot) => ({ ...shot, additional: true })),
      );
      expect(domain.resolveMafiaShots(game).result).toEqual({ kind: "miss" });
      const corrected = domain.toggleAllMafiaShotsForTarget(
        domain.toggleAllMafiaShotsForTarget(game, 9),
        9,
      );
      expect(domain.resolveMafiaShots(corrected).result).toEqual({ kind: "miss" });
      expect(corrected.shotObservations).toEqual(game.shotObservations);
      const replayed = domain.replayGameLog(baseline, entries.slice(0, 1)).game;
      expect(replayed.shotObservations).toBeUndefined();
      expect(domain.isSecretGameEventType("mafia.shots-observed")).toBe(true);
      const resolution = domain.resolveMafiaShots(game);
      const restored = roundTrip(game, [
        {
          type: "mafia.shots-resolved",
          payload: { shots: resolution.secretShots, result: resolution.result },
        },
      ]).game;
      expect(restored.shotObservations).toEqual(game.shotObservations);
    },
  );
  it("a first observed shot fills the assignment, only a further shot misses, and next night resets", () => {
    const initial = domain.beginNight(day());
    const shooters = initial.players.filter((p) => p.team === "black");
    const observations = shooters.map((p) => ({ shooterSeat: p.seat, targetSeat: 9 }));
    const first = roundTrip(initial, [
      { type: "mafia.shots-observed", payload: { shotAssignments: {}, observations } },
    ]).game;
    expect(first.shotObservations?.every((shot) => !shot.additional)).toBe(true);
    expect(domain.resolveMafiaShots(first).result).toEqual({ kind: "kill", targetSeat: 9 });
    const again = roundTrip(first, [
      {
        type: "mafia.shots-observed",
        payload: { shotAssignments: {}, observations: [observations[0]!] },
      },
    ]).game;
    expect(again.shotObservations?.at(-1)?.additional).toBe(true);
    expect(domain.resolveMafiaShots(again).result).toEqual({ kind: "miss" });
    let next = domain.completeMafiaShots(domain.resolveMafiaShots(again).game);
    if (next.phase === "night-don") next = domain.skipDonCheck(next);
    if (next.phase === "night-sheriff") next = domain.skipSheriffCheck(next);
    expect(next.shotObservations).toEqual(again.shotObservations);
    next = domain.beginNight(domain.completeNight(next));
    expect(next.shotObservations).toEqual([]);
    expect(domain.beginNight(day())).not.toHaveProperty("shotObservations");
  });
  it("validates physical shooters, seated targets, assignments and nonempty batches; permits inactive targets", () => {
    const initial = domain.beginNight(day());
    const shooterSeat = initial.players.find((p) => p.team === "black")!.seat;
    const red = initial.players.find((p) => p.team === "red")!.seat;
    const event = {
      type: "mafia.shots-observed",
      payload: { shotAssignments: {}, observations: [{ shooterSeat, targetSeat: red }] },
    } as const;
    for (const state of [
      day(),
      {
        ...initial,
        players: initial.players.map((p) =>
          p.seat === shooterSeat ? { ...p, status: "eliminated" as const } : p,
        ),
      },
    ])
      expect(domain.tryApplyGameEvent(state, event).ok).toBe(false);
    for (const payload of [
      { shotAssignments: {}, observations: [] },
      { shotAssignments: {}, observations: [{ shooterSeat: red, targetSeat: 9 }] },
      { shotAssignments: {}, observations: [{ shooterSeat, targetSeat: 11 }] },
      { shotAssignments: { [red]: 9 }, observations: event.payload.observations },
      { shotAssignments: { "01": 9 }, observations: event.payload.observations },
    ])
      expect(domain.tryApplyGameEvent(initial, { ...event, payload }).ok).toBe(false);
    const inactive = {
      ...initial,
      players: initial.players.map((p) =>
        p.seat === red ? { ...p, status: "eliminated" as const } : p,
      ),
    };
    expect(domain.tryApplyGameEvent(inactive, event).ok).toBe(true);
    expect(() => domain.assertCanonicalGameEventDraft(event)).not.toThrow();
  });
});
