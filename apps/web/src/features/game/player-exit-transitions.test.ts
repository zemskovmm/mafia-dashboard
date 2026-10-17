import { describe, expect, it } from "vitest";
import * as domain from "@mafia/game-domain";
import type { GameState } from "@mafia/game-domain";
import { pendingGoodbyeSeats, playerExitSeats } from "./player-exit-transitions.js";

const day = (): GameState => {
  let setup = domain.beginRoleDraw(
    domain.createSetup(
      Array.from({ length: 10 }, (_, index) => ({ id: `player-${index + 1}`, seat: index + 1 })),
    ),
    domain.createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  let game = domain.createGame(domain.completeRoleDraw(setup), {
    bestMoveEnabled: false,
  });
  for (let index = 0; index < 8 && game.phase !== "day"; index++)
    game = domain.advanceSetupPhase(game);
  return game;
};
const citizens = (game: GameState) =>
  game.players.filter((p) => p.role === "citizen" && p.status === "active").map((p) => p.seat);

describe("accepted player exit transitions", () => {
  it("waits for the entire ordinary goodbye list", () => {
    const before = day();
    const seats = citizens(before).slice(0, 2);
    const goodbye = domain.completeEliminations(before, seats);
    expect(goodbye.phase).toBe("goodbye-speech");
    expect(playerExitSeats(before, goodbye)).toEqual([]);
    expect(pendingGoodbyeSeats(goodbye)).toEqual(seats);
    const night = domain.completeGoodbyeSpeech(goodbye);
    expect(night.phase).toBe("night-mafia");
    expect(playerExitSeats(goodbye, night)).toEqual(seats);
    expect(playerExitSeats(night, { ...night })).toEqual([]);
    const replaced = {
      ...night,
      players: night.players.map((p) => ({ ...p, id: `new-${p.id}` })),
    };
    expect(playerExitSeats(goodbye, replaced)).toEqual([]);
  });

  it("retains current first-day goodbye eligibility for a three-foul victim", () => {
    let before = day();
    const [muted, speaking] = citizens(before);
    for (let index = 0; index < 3; index++) before = domain.issueFoul(before, muted!);
    const goodbye = domain.completeEliminations(before, [muted!, speaking!]);
    expect(playerExitSeats(before, goodbye)).toEqual([]);
    expect(pendingGoodbyeSeats(goodbye)).toEqual([muted, speaking]);
    expect(playerExitSeats(goodbye, domain.completeGoodbyeSpeech(goodbye))).toEqual([
      muted,
      speaking,
    ]);
  });

  it("keeps private night results still, then animates goodbye into day", () => {
    const night = domain.beginNight(day());
    const victim = citizens(night)[0]!;
    const result = domain.resolveMafiaShots(
      domain.toggleAllMafiaShotsForTarget(night, victim),
    ).game;
    expect(playerExitSeats(night, result)).toEqual([]);
    const applied = domain.completeMafiaShots(result);
    expect(playerExitSeats(result, applied)).toEqual([]);
    let checks = applied;
    if (checks.phase === "night-don") checks = domain.skipDonCheck(checks);
    if (checks.phase === "night-sheriff") checks = domain.skipSheriffCheck(checks);
    const goodbye = domain.completeNight(checks);
    expect(goodbye.phase).toBe("goodbye-speech");
    expect(playerExitSeats(checks, goodbye)).toEqual([]);
    expect(playerExitSeats(goodbye, domain.completeGoodbyeSpeech(goodbye))).toEqual([victim]);
  });

  it("animates decisive public vote and night departures without a goodbye", () => {
    const initial = day();
    const reds = citizens(initial);
    const goodbye = domain.completeEliminations(initial, reds.slice(0, 3));
    const night = domain.completeGoodbyeSpeech(goodbye);
    const result = domain.resolveMafiaShots(
      domain.toggleAllMafiaShotsForTarget(night, reds[3]!),
    ).game;
    const finished = domain.completeMafiaShots(result);
    expect(finished.phase).toBe("finished");
    expect(playerExitSeats(result, finished)).toEqual([reds[3]]);
    const publicResult = domain.completeEliminations(initial, reds.slice(0, 4));
    expect(publicResult.phase).toBe("finished");
    expect(playerExitSeats(initial, publicResult)).toEqual(reds.slice(0, 4));
  });

  it("animates all pending departures when a sanction ends a pending farewell", () => {
    const initial = day();
    const reds = citizens(initial);
    const pending = reds.slice(0, 3);
    const removed = reds[3]!;
    const goodbye = domain.completeEliminations(initial, pending);
    expect(goodbye.phase).toBe("goodbye-speech");
    const finished = domain.redCard(goodbye, removed, {
      seat: removed,
      stage: "farewell",
      rule: "6.2.3",
      reason: "Farewell misconduct",
      checkInProgress: false,
    });
    expect(finished.phase).toBe("finished");
    expect(playerExitSeats(goodbye, finished)).toEqual([removed, ...pending]);
    expect(playerExitSeats(finished, { ...finished })).toEqual([]);
  });

  it("reveals a previously applied private kill with a decisive exclusion", () => {
    const initial = day();
    const reds = citizens(initial);
    const shot = reds[2]!;
    const removed = reds[3]!;
    const night = domain.completeGoodbyeSpeech(
      domain.completeEliminations(initial, reds.slice(0, 2)),
    );
    const result = domain.resolveMafiaShots(domain.toggleAllMafiaShotsForTarget(night, shot)).game;
    const applied = domain.completeMafiaShots(result);
    expect(applied.phase).toBe("night-don");
    expect(playerExitSeats(result, applied)).toEqual([]);
    const finished = domain.redCard(applied, removed, {
      seat: removed,
      stage: "don-check",
      rule: "6.2.3",
      reason: "Night misconduct",
      checkInProgress: false,
    });
    expect(finished.phase).toBe("finished");
    expect(playerExitSeats(applied, finished)).toEqual([removed, shot]);
    expect(playerExitSeats(finished, { ...finished })).toEqual([]);
  });

  it("animates fourth-foul and farewell sanctions once, not their later announcements", () => {
    let before = day();
    const [seat, other] = citizens(before);
    for (let index = 0; index < 3; index++) before = domain.issueFoul(before, seat!);
    const removed = domain.issueFoul(before, seat!);
    expect(playerExitSeats(before, removed)).toEqual([seat]);
    const announced = domain.announceDisciplinaryRemovals(removed);
    expect(playerExitSeats(removed, announced)).toEqual([]);
    const goodbye = domain.completeEliminations(day(), [seat!, other!]);
    const interrupted = domain.observeDisciplinaryRemoval(goodbye, {
      seat: seat!,
      stage: "farewell",
      rule: "6.2.3",
      reason: "Farewell misconduct",
      checkInProgress: false,
    });
    expect(playerExitSeats(goodbye, interrupted)).toEqual([seat]);
    expect(playerExitSeats(interrupted, domain.completeGoodbyeSpeech(interrupted))).toEqual([
      other,
    ]);
    const awarded = domain.adjudicateOpponentVictory(goodbye, {
      losingTeam: "red",
      rule: "6.3.1",
      reason: "Referee decision",
      committeeApproved: false,
    });
    expect(playerExitSeats(goodbye, awarded)).toEqual([]);
    expect(
      playerExitSeats(goodbye, { ...goodbye, phase: "draw", goodbyeSeats: undefined }),
    ).toEqual([]);
  });
});
