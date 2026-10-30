import { describe, expect, it } from "vitest";
import * as domain from "./index.js";
import type { GameState, SetupState } from "./types.js";

const setup = (): SetupState => {
  let state = domain.beginRoleDraw(
    domain.createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, seat: i + 1 }))),
    domain.createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) state = domain.drawRoleForSeat(state, seat);
  return domain.completeRoleDraw(state);
};
const opening = () => domain.createGame(setup());
const day = () => {
  let game = opening();
  for (let step = 0; step < 5; step++) game = domain.advanceSetupPhase(game);
  return game;
};
const miss = (game: GameState) => {
  let next = domain.completeMafiaShots(domain.resolveMafiaShots(domain.beginNight(game)).game);
  if (next.phase === "night-don") next = domain.skipDonCheck(next);
  if (next.phase === "night-sheriff") next = domain.skipSheriffCheck(next);
  return domain.completeNight(next);
};
const voting = (): GameState =>
  domain.startVoting({
    ...day(),
    nominations: [
      { nominatorSeat: 1, candidateSeat: 1, order: 1 },
      { nominatorSeat: 2, candidateSeat: 2, order: 2 },
    ],
  });
const call = (game: GameState) =>
  domain.mentionVotingCandidate(domain.mentionVotingCandidate(game));
const ready = () => domain.announceVotingOrder(domain.announceVotingOrder(voting()));
const kill = (game: GameState, seat: number) => {
  let next = domain.completeMafiaShots(
    domain.resolveMafiaShots(domain.toggleAllMafiaShotsForTarget(domain.beginNight(game), seat))
      .game,
  );
  if (next.phase === "night-don") next = domain.skipDonCheck(next);
  if (next.phase === "night-sheriff") next = domain.skipSheriffCheck(next);
  return next;
};

describe("federation disciplinary boundaries", () => {
  it("excludes pre-count removals immediately, defers count-stage announcements, and preserves shot-plus-DQ", () => {
    const state = domain.beginNight(day());
    const red = state.players.find((p) => p.team === "red")!.seat;
    const before = domain.observeDisciplinaryRemoval(state, {
      seat: red,
      stage: "before-shooting-count",
      rule: "6.2.3",
      reason: "Night violation",
      checkInProgress: false,
    });
    expect(before).toMatchObject({ ballotCancellationDay: 2 });
    expect(
      domain.resolveMafiaShots(domain.toggleAllMafiaShotsForTarget(before, red)).result,
    ).toEqual({ kind: "no-effect", targetSeat: red });
    const count = domain.observeDisciplinaryRemoval(
      domain.toggleAllMafiaShotsForTarget(state, red),
      {
        seat: red,
        stage: "shooting-count",
        rule: "6.2.3",
        reason: "Count-stage violation",
        checkInProgress: false,
      },
    );
    expect(count.disciplinaryRemovals?.[0]).toMatchObject({
      effectiveExcluded: true,
      departure: "pending",
      announcement: "pending",
    });
    expect(() => domain.announceDisciplinaryRemovals(count)).toThrow();
    const resolved = domain.resolveMafiaShots(count);
    expect(resolved.result).toEqual({ kind: "kill", targetSeat: red });
    expect(resolved.game.disciplinaryRemovals?.[0]).toMatchObject({
      shotDeath: true,
      departure: "departed",
    });
    expect(resolved.game.ballotCancellationDay).toBeUndefined();
    expect(
      domain.announceDisciplinaryRemovals(resolved.game).disciplinaryRemovals?.[0]?.announcement,
    ).toBe("announced");
  });
  it("never counts a removed shooter's shot, even if physically still present", () => {
    const state = domain.beginNight(day());
    const shooter = state.players.find((p) => p.team === "black")!.seat;
    const shots = domain.toggleAllMafiaShotsForTarget(state, 1);
    const removed = domain.observeDisciplinaryRemoval(shots, {
      seat: shooter,
      stage: "shooting-count",
      rule: "6.2.3",
      reason: "Night violation",
      checkInProgress: false,
    });
    expect(domain.resolveMafiaShots(removed).result.kind).toBe("kill");
    expect(() => domain.recordMafiaShot(removed, shooter, 2)).toThrow();
  });
  it("finishes the already-started owner's check, then removes; announces after Sheriff", () => {
    let state = domain.completeMafiaShots(domain.resolveMafiaShots(domain.beginNight(day())).game);
    const don = state.players.find((p) => p.role === "don")!.seat;
    const sheriff = state.players.find((p) => p.role === "sheriff")!.seat;
    state = domain.observeDisciplinaryRemoval(state, {
      seat: don,
      stage: "don-check",
      rule: "6.2.3",
      reason: "Check-stage violation",
      checkInProgress: true,
    });
    expect(domain.isNightCheckEligible(state, "don")).toBe(true);
    state = domain.performDonCheck(state, sheriff).game;
    expect(() => domain.announceDisciplinaryRemovals(state)).toThrow();
    state = domain.continueDonCheck(state);
    expect(state.phase).toBe("night-sheriff");
    expect(state.disciplinaryRemovals?.[0]).toMatchObject({
      departure: "departed",
      checkCompletionPending: false,
    });
    expect(domain.isNightCheckEligible(state, "don")).toBe(false);
    state = domain.skipSheriffCheck(state);
    expect(domain.announceDisciplinaryRemovals(state).disciplinaryRemovals?.[0]?.announcement).toBe(
      "announced",
    );
  });
  it("coalesces post-result debt and consumes only the following day's ballot", () => {
    const state = {
      ...day(),
      phase: "goodbye-speech" as const,
      goodbyeSeats: [1],
      goodbyeNext: "night" as const,
    };
    let game = domain.observeDisciplinaryRemoval(state, {
      seat: 2,
      stage: "after-voting-result",
      rule: "6.2.1",
      reason: "Fourth foul",
      checkInProgress: false,
    });
    game = domain.observeDisciplinaryRemoval(game, {
      seat: 3,
      stage: "after-voting-result",
      rule: "6.2.1",
      reason: "Fourth foul",
      checkInProgress: false,
    });
    expect(game.ballotCancellationDay).toBe(2);
    game = miss(game);
    expect(game.ballotCancellationDay).toBe(2);
    game = domain.startVoting({
      ...game,
      nominations: [
        { nominatorSeat: 4, candidateSeat: 4, order: 1 },
        { nominatorSeat: 5, candidateSeat: 5, order: 2 },
      ],
    });
    expect(game.phase).toBe("voting-cancelled");
    game = domain.beginNight(game);
    expect(game.ballotCancellationDay).toBeUndefined();
  });
  it("accepts a departing victim's sanction without cancelling the next ballot or double-counting", () => {
    const state = domain.completeEliminations(day(), [1]);
    const next = domain.observeDisciplinaryRemoval(state, {
      seat: 1,
      stage: "farewell",
      rule: "6.2.1",
      reason: "Farewell misconduct",
      checkInProgress: false,
    });
    expect(next.ballotCancellationDay).toBeUndefined();
    expect(next.firstDayDepartureSeats).toEqual([1]);
    expect(next.players.find((p) => p.seat === 1)?.status).toBe("red-carded");
    expect(next.goodbyeSeats).not.toContain(1);
  });
  it("exempts an already accepted collective-vote victim and completes the other departures once", () => {
    const state = {
      ...day(),
      phase: "car-crash-result" as const,
      carCrashSeats: [1, 2],
      carCrashResult: { eliminate: true, seats: [1, 2], yesVotes: 6, eligibleVoters: 10 },
    };
    const sanctioned = domain.observeDisciplinaryRemoval(state, {
      seat: 1,
      stage: "after-voting-result",
      rule: "6.2.4",
      reason: "Misconduct after accepted departure",
      checkInProgress: false,
    });
    expect(sanctioned.ballotCancellationDay).toBeUndefined();
    const next = domain.completeCarCrashResult(sanctioned);
    expect(next.firstDayDepartureSeats).toEqual([1, 2]);
    expect(next.players.find((p) => p.seat === 1)?.status).toBe("red-carded");
    expect(next.players.find((p) => p.seat === 2)?.status).toBe("eliminated");
    expect(next.goodbyeSeats).not.toContain(1);
  });
  it("requires explicit night timing for direct red cards and fourth fouls", () => {
    const night = domain.beginNight(day());
    expect(() => domain.redCard(night, 1)).toThrow(/timing|occurrence/i);
    const three = {
      ...night,
      players: night.players.map((p) => (p.seat === 1 ? { ...p, fouls: 3, mutePending: true } : p)),
    };
    expect(() => domain.issueFoul(three, 1)).toThrow(/timing|occurrence/i);
    const observation = {
      seat: 1,
      stage: "before-shooting-count" as const,
      rule: "6.2.1",
      reason: "Fourth foul",
      checkInProgress: false,
    };
    const next = domain.issueFoul(three, 1, observation);
    expect(next.players.find((p) => p.seat === 1)).toMatchObject({
      fouls: 4,
      status: "red-carded",
    });
    expect(next.disciplinaryRemovals?.[0]).toMatchObject(observation);
  });
  it("routes ordinary direct red cards to current-day or next-day debt without cancelling a completed result", () => {
    const state = day();
    expect(() => domain.redCard(state, 1)).toThrow(/reasoned|observation/i);
    expect(
      domain.redCard(state, 1, {
        seat: 1,
        stage: "day-discussion",
        rule: "6.2.4",
        reason: "Left the table without authorization",
        checkInProgress: false,
      }).ballotCancellationDay,
    ).toBe(1);
    const afterResult = {
      ...state,
      phase: "goodbye-speech" as const,
      goodbyeSeats: [1],
      goodbyeNext: "night" as const,
    };
    expect(
      domain.redCard(afterResult, 2, {
        seat: 2,
        stage: "after-voting-result",
        rule: "6.2.4",
        reason: "Left the table without authorization",
        checkInProgress: false,
      }),
    ).toMatchObject({ phase: "goodbye-speech", ballotCancellationDay: 2 });
  });
  it("terminates numerically after completing the already-underway last-Don check", () => {
    const initial = day();
    const don = initial.players.find((p) => p.role === "don")!.seat;
    const prior = {
      ...initial,
      players: initial.players.map((p) =>
        p.team === "black" && p.role !== "don" ? { ...p, status: "eliminated" as const } : p,
      ),
    };
    let state = domain.completeMafiaShots(domain.resolveMafiaShots(domain.beginNight(prior)).game);
    state = domain.observeDisciplinaryRemoval(state, {
      seat: don,
      stage: "don-check",
      rule: "6.2.3",
      reason: "Violation during the existing check",
      checkInProgress: true,
    });
    expect(state.phase).toBe("night-don");
    state = domain.performDonCheck(state, 1).game;
    state = domain.continueDonCheck(state);
    expect(state).toMatchObject({ phase: "finished", winner: "red" });
    expect(domain.announceDisciplinaryRemovals(state).disciplinaryRemovals?.[0]?.announcement).toBe(
      "announced",
    );
    expect(() => domain.beginNight(state)).toThrow();
  });
  it("does not accept skipping an already-underway sanctioned check", () => {
    let state = domain.completeMafiaShots(domain.resolveMafiaShots(domain.beginNight(day())).game);
    const don = state.players.find((p) => p.role === "don")!.seat;
    state = domain.observeDisciplinaryRemoval(state, {
      seat: don,
      stage: "don-check",
      rule: "6.2.3",
      reason: "Violation during existing check",
      checkInProgress: true,
    });
    expect(() => domain.skipDonCheck(state)).toThrow();
  });
  it("applies a legitimate accepted shot before termination caused by a count-stage removal", () => {
    const initial = day();
    const red = initial.players.filter((p) => p.team === "red").map((p) => p.seat);
    const activeRed = new Set(red.slice(0, 4));
    const state = {
      ...initial,
      players: initial.players.map((p) =>
        p.team === "red" && !activeRed.has(p.seat) ? { ...p, status: "eliminated" as const } : p,
      ),
    };
    const night = domain.toggleAllMafiaShotsForTarget(domain.beginNight(state), red[1]!);
    const removed = domain.observeDisciplinaryRemoval(night, {
      seat: red[0]!,
      stage: "shooting-count",
      rule: "6.2.3",
      reason: "Night violation",
      checkInProgress: false,
    });
    const accepted = domain.resolveMafiaShots(removed).game;
    const published = domain.announceDisciplinaryRemovals(accepted);
    expect(published.phase).toBe("night-mafia-result");
    const next = domain.completeMafiaShots(published);
    expect(next).toMatchObject({ phase: "finished", winner: "black" });
    expect(next.players.find((p) => p.seat === red[1])?.status).toBe("eliminated");
  });
  it("opens private checks after shot evaluation without a count-stage announcement acknowledgement", () => {
    const initial = day();
    const night = domain.beginNight(initial);
    const victim = night.players.find((p) => p.role === "citizen")!.seat;
    const removed = domain.observeDisciplinaryRemoval(
      domain.toggleAllMafiaShotsForTarget(night, victim),
      {
        seat: victim,
        stage: "shooting-count",
        rule: "6.2.3",
        reason: "Count-stage violation",
        checkInProgress: false,
      },
    );
    const result = domain.resolveMafiaShots(removed).game;
    const completed = domain.completeMafiaShots(result);
    expect(completed.phase).toBe("night-don");
    expect(completed.disciplinaryRemovals?.[0]).toMatchObject({
      announcement: "pending",
      departure: "departed",
      shotDeath: true,
    });
    expect(completed.ballotCancellationDay).toBeUndefined();
    expect(domain.completeMafiaShots(domain.announceDisciplinaryRemovals(result)).phase).toBe(
      "night-don",
    );
  });
  it("advances morning deliberately without inventing a pending night announcement", () => {
    const initial = day();
    const night = domain.beginNight(initial);
    const citizen = night.players.find((p) => p.role === "citizen")!.seat;
    let state = domain.observeDisciplinaryRemoval(
      domain.completeMafiaShots(domain.resolveMafiaShots(night).game),
      {
        seat: citizen,
        stage: "don-check",
        rule: "6.2.3",
        reason: "Night violation",
        checkInProgress: false,
      },
    );
    if (state.phase === "night-don") state = domain.skipDonCheck(state);
    if (state.phase === "night-sheriff") state = domain.skipSheriffCheck(state);
    const completed = domain.completeNight(state);
    expect(completed).toMatchObject({
      phase: "day",
      day: 2,
      ballotCancellationDay: 2,
      disciplinaryRemovals: [{ announcement: "pending", departure: "departed" }],
    });
    expect(domain.completeNight(domain.announceDisciplinaryRemovals(state)).phase).toBe("day");
  });
  it("continues after immediate removal without requiring the retained seat-only announcement event", () => {
    const state = domain.observeDisciplinaryRemoval(day(), {
      seat: 1,
      stage: "day-discussion",
      rule: "6.2.4",
      reason: "Unauthorized departure",
      checkInProgress: false,
    });
    expect(state.disciplinaryRemovals?.[0]?.announcement).toBe("pending");
    expect(domain.announceDisciplinaryRemovals(state).disciplinaryRemovals?.[0]?.announcement).toBe(
      "announced",
    );
    const continued = domain.applyGameEvent(state, {
      type: "turn.completed",
      payload: { seat: 2 },
    });
    expect(continued.turnOrder[continued.currentTurnIndex]).toBe(3);
    expect(continued.disciplinaryRemovals).toEqual(state.disciplinaryRemovals);
  });
  it("does not bypass an unsettled physical count by completing shots or morning", () => {
    const night = domain.beginNight(day());
    const seat = night.players.find((p) => p.role === "citizen")!.seat;
    const counting = domain.observeDisciplinaryRemoval(night, {
      seat,
      stage: "shooting-count",
      rule: "6.2.3",
      reason: "",
      checkInProgress: false,
    });
    expect(() => domain.completeMafiaShots(counting)).toThrow();
    // A restored boundary label cannot settle the physical departure itself.
    const premature = { ...counting, phase: "night-mafia-result" as const };
    expect(() => domain.completeMafiaShots(premature)).toThrow(/departure|count/i);
    expect(() => domain.completeNight({ ...counting, phase: "night-resolution" })).toThrow(
      /departure|count/i,
    );
    expect(counting.disciplinaryRemovals?.[0]?.departure).toBe("pending");
    expect(domain.resolveMafiaShots(counting).game.disciplinaryRemovals?.[0]).toMatchObject({
      departure: "departed",
      announcement: "pending",
    });
  });
  it.each(["don", "sheriff"] as const)(
    "preserves the underway %s check and departure without an announcement gate",
    (owner) => {
      let state = domain.completeMafiaShots(
        domain.resolveMafiaShots(domain.beginNight(day())).game,
      );
      if (owner === "sheriff") state = domain.skipDonCheck(state);
      const seat = state.players.find((p) => p.role === owner)!.seat;
      state = domain.observeDisciplinaryRemoval(state, {
        seat,
        stage: owner === "don" ? "don-check" : "sheriff-check",
        rule: "6.2.3",
        reason: "",
        checkInProgress: true,
      });
      const skip = owner === "don" ? domain.skipDonCheck : domain.skipSheriffCheck;
      expect(() => skip(state)).toThrow(/underway/i);
      expect(() => domain.completeNight({ ...state, phase: "night-resolution" })).toThrow(
        /departure|check/i,
      );
      expect(() =>
        domain.applyGameEvent(state, { type: "phase.changed", payload: { to: "day" } }),
      ).toThrow();
      const check = owner === "don" ? domain.performDonCheck : domain.performSheriffCheck;
      const proceed = owner === "don" ? domain.continueDonCheck : domain.continueSheriffCheck;
      state = check(state, 1).game;
      expect(state.disciplinaryRemovals?.[0]?.departure).toBe("pending");
      state = proceed(state);
      if (state.phase === "night-sheriff") state = domain.skipSheriffCheck(state);
      expect(domain.completeNight(state)).toMatchObject({
        phase: "day",
        disciplinaryRemovals: [
          {
            announcement: "pending",
            departure: "departed",
            checkCompletionPending: false,
          },
        ],
      });
    },
  );
  it("only accepts recorded timing facts consistent with the current phase", () => {
    expect(() =>
      domain.observeDisciplinaryRemoval(day(), {
        seat: 1,
        stage: "shooting-count",
        rule: "6.2.3",
        reason: "Wrong phase",
        checkInProgress: false,
      }),
    ).toThrow();
    const state = opening();
    const red = state.players.find((p) => p.team === "red")!.seat;
    const next = domain.observeDisciplinaryRemoval(state, {
      seat: red,
      stage: "agreement",
      rule: "6.2.3",
      reason: "Awakened red player",
      checkInProgress: false,
    });
    expect(next.disciplinaryRemovals?.[0]).toMatchObject({
      departure: "departed",
      announcement: "pending",
    });
    expect(domain.announceDisciplinaryRemovals(next).disciplinaryRemovals?.[0]?.announcement).toBe(
      "announced",
    );
    expect(next.ballotCancellationDay).toBe(1);
  });
});

describe("federation lifecycle", () => {
  it("identifies masked roles and free seating before the zero round", () => {
    let game = opening();
    for (const phase of [
      "mafia-sleep",
      "don-identification",
      "sheriff-identification",
      "free-seating",
      "day",
    ]) {
      game = domain.advanceSetupPhase(game);
      expect(game.phase).toBe(phase);
    }
    expect(game).toMatchObject({
      day: 1,
      completedGameNights: 1,
      cyclesWithoutElimination: 1,
      sheriffChecksPerformed: 0,
    });
  });
  it("draws automatically after planning plus two unchanged shooting nights", () => {
    const second = miss(day());
    expect(second.phase).toBe("day");
    const third = miss(second);
    expect(third).toMatchObject({
      phase: "draw",
      winner: null,
      completedGameNights: 3,
      rulesDrawReason: { rule: "6.5.6", consecutiveUnchangedNights: 3 },
    });
    expect(() => domain.completeNight(third)).toThrow();
  });
  it("resets the draw streak immediately on a daytime departure", () => {
    const changed = domain.markPlayerInactive(miss(day()), 1, "eliminated");
    expect(changed.cyclesWithoutElimination).toBe(0);
    expect(miss(changed).phase).toBe("day");
  });
  it("does not let a previously departed owner check but preserves same-night victim entitlement", () => {
    const state = day();
    const sheriff = state.players.find((p) => p.role === "sheriff")!;
    const prior = domain.beginNight(domain.markPlayerInactive(state, sheriff.seat, "eliminated"));
    expect(domain.isNightCheckEligible(prior, "sheriff")).toBe(false);
    let current = domain.completeMafiaShots(
      domain.resolveMafiaShots(
        domain.toggleAllMafiaShotsForTarget(domain.beginNight(state), sheriff.seat),
      ).game,
    );
    if (current.phase === "night-don") current = domain.skipDonCheck(current);
    expect(current.phase).toBe("night-sheriff");
    current = domain.performSheriffCheck(current, sheriff.seat).game;
    expect(current.sheriffChecksPerformed).toBe(1);
  });
  it("actual multiple shots miss while clerical correction still kills", () => {
    const night = domain.beginNight(day());
    const shooter = night.players.find((p) => p.team === "black")!.seat;
    const corrected = domain.toggleMafiaShot(
      domain.toggleAllMafiaShotsForTarget(night, 1),
      shooter,
      1,
    );
    const restored = domain.recordMafiaShot(corrected, shooter, 1);
    expect(domain.resolveMafiaShots(restored).result.kind).toBe("kill");
    expect(
      domain.resolveMafiaShots(domain.recordActualMultipleShot(restored, shooter)).result,
    ).toEqual({ kind: "miss" });
  });
});

describe("federation accepted ballot", () => {
  it("requires two announcements, second mention and stop; inspection never calls or fills", () => {
    let game = voting();
    expect(() => domain.assignVote(game, 1, 1)).toThrow();
    const inspected = domain.selectVotingCandidate(game, 2);
    expect(inspected.currentTurnIndex).toBe(0);
    expect(inspected.voteAssignments).toEqual({});
    game = call(domain.announceVotingOrder(domain.announceVotingOrder(inspected)));
    game = domain.assignVote(game, 1, 1);
    expect(() => domain.advanceVotingCandidate(game)).toThrow();
    game = domain.stopVotingCandidate(game);
    expect(() => domain.assignVote(game, 2, 1)).toThrow();
    game = domain.advanceVotingCandidate(game);
    game = call(game);
    expect(Object.values(game.voteAssignments).filter((v) => v === 2)).toHaveLength(9);
  });
  it("does not use transcription correction as a vote before the first accepted call", () => {
    expect(() => domain.correctAcceptedVote(voting(), 1, 1, "No physical call yet")).toThrow();
  });
  it("accepted votes cannot be recast; explicit correction is independent of the live cursor", () => {
    let game = domain.assignVote(call(ready()), 1, 1);
    expect(() => domain.toggleVote(game, 1, 1)).toThrow();
    game = domain.stopVotingCandidate(game);
    game = domain.correctAcceptedVote(game, 1, 2, "Transcription slip");
    expect(game.currentTurnIndex).toBe(0);
    expect(game.voteAssignments[1]).toBe(2);
  });
  it("pauses immediately for a dispute and requires a final human-reviewed ruling", () => {
    let game = domain.stopVotingCandidate(domain.assignVote(call(ready()), 1, 1));
    game = domain.disputeVotingCount(game, 1, "Missed hand");
    expect(() => domain.advanceVotingCandidate(game)).toThrow();
    expect(() => domain.resolveVote(game)).toThrow();
    expect(() => domain.ruleOnVotingDispute(game, { 1: 1 }, false, "Reviewed count")).toThrow();
    game = domain.ruleOnVotingDispute(game, { 1: 1 }, true, "Reviewed count");
    expect(() => domain.disputeVotingCount(game, 1, "Again")).toThrow();
    expect(domain.advanceVotingCandidate(game).currentTurnIndex).toBe(1);
  });
  it("finishes only a conclusively determined partial ballot, preserving actual assignments", () => {
    let game = call(ready());
    for (let voter = 1; voter <= 5; voter++) game = domain.assignVote(game, voter, 1);
    expect(() => domain.resolveVote(domain.stopVotingCandidate(game))).toThrow();
    game = domain.assignVote(game, 6, 1);
    game = domain.stopVotingCandidate(game);
    expect(domain.resolveVote(game)).toMatchObject({
      kind: "winner",
      seats: [1],
      totals: { 1: 6, 2: 0 },
    });
    expect(Object.keys(game.voteAssignments)).toHaveLength(6);
  });
  it("a later sole nominee leaves without an open ballot; arbitrary skipping is illegal", () => {
    const next = domain.startVoting({
      ...day(),
      day: 2,
      nominations: [{ nominatorSeat: 1, candidateSeat: 1, order: 1 }],
    });
    expect(next.phase).toBe("goodbye-speech");
    expect(Object.values(next.voteAssignments)).toHaveLength(10);
    expect(() => domain.skipFederationVoting(voting(), "no-nominees")).toThrow();
  });
  it.each([
    [2, 2, false],
    [3, 1, false],
    [3, 2, true],
  ])("nine/three lift requires nights=%i AND checks=%i", (nights, checks, permitted) => {
    const state = domain.markPlayerInactive(day(), 10, "eliminated");
    expect(
      domain.getCollectiveLiftEligibility(
        { ...state, completedGameNights: nights, sheriffChecksPerformed: checks },
        [1, 2, 3],
      ).permitted,
    ).toBe(permitted);
  });
  it("prohibits generic cancellation and consumes current-day debt after the final speaker is removed", () => {
    expect(() => domain.cancelVoting(voting(), { reason: "host-skipped" })).toThrow();
    const state = { ...day(), currentTurnIndex: 9 };
    const next = domain.observeDisciplinaryRemoval(state, {
      seat: 10,
      stage: "day-discussion",
      rule: "6.2.4",
      reason: "Unauthorized departure",
      checkInProgress: false,
    });
    expect(next).toMatchObject({
      phase: "voting-cancelled",
      ballotSkipReason: "disciplinary-cancellation",
      ballotCancellationDay: 1,
    });
    expect(domain.beginNight(next).ballotCancellationDay).toBeUndefined();
  });
  it("does not grant Best Move to a decisive shot victim", () => {
    const state = day();
    const black = state.players.filter((p) => p.team === "black");
    const victim = black[0]!.seat;
    const left = state.players.map((p) =>
      p.team === "black" && p.seat !== victim ? { ...p, status: "eliminated" as const } : p,
    );
    const night = domain.toggleAllMafiaShotsForTarget(
      domain.beginNight({ ...state, players: left }),
      victim,
    );
    const next = domain.completeMafiaShots(domain.resolveMafiaShots(night).game);
    expect(next).toMatchObject({ phase: "finished", winner: "red" });
    expect(next.bestMove).toBeUndefined();
  });
  it.each([3, 4, 5])(
    "nearest-turn entitlement with %i active players is phase-correct",
    (active) => {
      const state = day();
      let game: GameState = {
        ...state,
        players: state.players.map((p) => ({
          ...p,
          status: p.seat <= active ? ("active" as const) : ("eliminated" as const),
          fouls: p.seat === 2 ? 3 : 0,
          mutePending: p.seat === 2,
        })),
        turnOrder: Array.from({ length: active }, (_, i) => i + 1),
      };
      game = domain.completeCurrentTurn(game);
      expect(domain.getCurrentTurnDuration(game)).toBe(active <= 4 ? 30 : 0);
      expect(domain.getCurrentTurnDuration({ ...game, phase: "car-crash" })).toBe(30);
      const ordinaryPending = game.players.find((p) => p.seat === 2)?.mutePending;
      expect(ordinaryPending).toBe(true);
    },
  );
  it("finishes a conclusive collective ballot without filling absent decisions", () => {
    const state = {
      ...day(),
      phase: "car-crash-decision" as const,
      carCrashSeats: [1, 2],
      carCrashVotes: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true },
    };
    expect(domain.resolveCarCrashVote(state)).toMatchObject({
      eliminate: true,
      yesVotes: 6,
      eligibleVoters: 10,
    });
    expect(Object.keys(state.carCrashVotes)).toHaveLength(6);
    expect(() =>
      domain.resolveCarCrashVote({ ...state, carCrashVotes: { 1: true, 2: true } }),
    ).toThrow();
  });
  it.each([
    ["nine-three-restricted", 3],
    ["zero-round-five", 5],
  ])("resolves repeated %s ties through a named skipped result", (reason, count) => {
    const state =
      reason === "nine-three-restricted"
        ? domain.markPlayerInactive(day(), 10, "eliminated")
        : day();
    const seats = Array.from({ length: count }, (_, i) => i + 1);
    const round = (initial: GameState) => {
      let game = domain.announceVotingOrder(domain.announceVotingOrder(initial));
      const voters = game.players.filter((p) => p.status === "active").map((p) => p.seat);
      for (const candidate of seats) {
        game = call(game);
        if (candidate !== seats.at(-1))
          for (const voter of voters.slice(
            ((candidate - 1) * voters.length) / count,
            (candidate * voters.length) / count,
          ))
            game = domain.assignVote(game, voter, candidate);
        game = domain.stopVotingCandidate(game);
        if (candidate !== seats.at(-1)) game = domain.advanceVotingCandidate(game);
      }
      return game;
    };
    const nominations = seats.map((seat) => ({
      nominatorSeat: seat,
      candidateSeat: seat,
      order: seat,
    }));
    let game = round(domain.startVoting({ ...state, nominations }));
    const first = domain.resolveVote(game);
    expect(first.kind).toBe("car-crash");
    game = domain.beginCarCrash(game, first.seats);
    for (let i = 0; i < count; i++) game = domain.completeCurrentTurn(game);
    game = round(game);
    const result = domain.resolveVote(game);
    expect(result).toMatchObject({ kind: "eliminate-all-skipped", skipReason: reason });
    expect(domain.beginSkippedCarCrashDecision(game, result.seats).ballotSkipReason).toBe(reason);
  });
  it("zero-round five-way lift is prohibited and all-active is always prohibited", () => {
    expect(domain.getCollectiveLiftEligibility(day(), [1, 2, 3, 4, 5]).permitted).toBe(false);
    expect(
      domain.getCollectiveLiftEligibility(
        day(),
        Array.from({ length: 10 }, (_, i) => i + 1),
      ).permitted,
    ).toBe(false);
  });
});

describe("federation Best Move and sanctions", () => {
  it.each([0, 1, 2, 3])("accepts %i entries in order before morning", (count) => {
    const target = day().players.find((p) => p.team === "red")!.seat;
    let game = domain.prepareBestMove(kill(day(), target));
    expect(game).toMatchObject({ phase: "best-move", day: 1, completedGameNights: 1 });
    for (let i = 0; i < count; i++) game = domain.acceptBestMoveSeat(game, target);
    game = domain.finalizeBestMove(
      game,
      count === 0 ? "declined" : count === 3 ? "complete-list" : "time-expired",
      true,
    );
    expect(game.bestMove?.selectedSeats).toEqual(Array(count).fill(target));
    expect(game.phase).toBe("night-resolution");
    expect(() => domain.acceptBestMoveSeat(game, 2)).toThrow();
    expect(domain.completeNight(game)).toMatchObject({
      phase: "goodbye-speech",
      day: 2,
      completedGameNights: 2,
    });
  });
  it("supports only explicit obvious-slip correction; first-day two departures exclude Best Move", () => {
    const target = day().players.find((p) => p.team === "red")!.seat;
    let game = domain.acceptBestMoveSeat(domain.prepareBestMove(kill(day(), target)), 1);
    game = domain.correctBestMoveSlip(game, 0, 2, "Obvious spoken slip");
    game = domain.finalizeBestMove(game, "interrupted", true);
    expect(game.bestMove?.selectedSeats).toEqual([2]);
    const changed = domain.markPlayerInactive(
      domain.markPlayerInactive(day(), 1, "eliminated"),
      2,
      "eliminated",
    );
    const victim = changed.players.find((p) => p.status === "active" && p.team === "red")!.seat;
    expect(domain.prepareBestMove(kill(changed, victim)).phase).toBe("night-resolution");
  });
  it("carries the third-foul restriction across night; current speech is not shortened", () => {
    let game = day();
    for (let i = 0; i < 3; i++) game = domain.issueFoul(game, 1);
    expect(domain.getCurrentTurnDuration(game)).toBe(60);
    game = miss(game);
    expect(game.players.find((p) => p.seat === 1)?.mutePending).toBe(true);
    while (game.turnOrder[game.currentTurnIndex] !== 1) game = domain.completeCurrentTurn(game);
    expect(domain.getCurrentTurnDuration(game)).toBe(0);
    game = domain.completeCurrentTurn(game);
    expect(game.players.find((p) => p.seat === 1)?.mutePending).toBe(false);
  });
  it("ordinary farewell is not suppressed by pending third-foul restriction", () => {
    const state = day();
    const muted = {
      ...state,
      players: state.players.map((p) => (p.seat === 1 ? { ...p, fouls: 3, mutePending: true } : p)),
    };
    expect(domain.completeEliminations(muted, [1]).goodbyeSeats).toEqual([1]);
  });
  it("adjudicates an opposing win without fabricated deaths; committee cases require agreement", () => {
    const state = day();
    const ruling = {
      losingTeam: "red" as const,
      rule: "6.3.5",
      reason: "Committee disciplinary ruling",
      committeeApproved: false,
    };
    expect(() => domain.adjudicateOpponentVictory(state, ruling)).toThrow();
    const next = domain.adjudicateOpponentVictory(state, { ...ruling, committeeApproved: true });
    expect(next).toMatchObject({
      phase: "finished",
      winner: "black",
      adjudication: { rule: "6.3.5" },
    });
    expect(next.players).toEqual(state.players);
    expect(() => domain.issueFoul(next, 1)).toThrow();
  });
});
