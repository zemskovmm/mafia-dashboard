import * as domain from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState, ReplayFrame } from "@mafia/game-domain";
import { describe, expect, it } from "vitest";
import { projectPlayerActions } from "./player-action-presentation.js";

const day = (): GameState => {
  let setup = domain.beginRoleDraw(
    domain.createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `p-${i + 1}`, seat: i + 1 }))),
    domain.createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  let game = domain.createGame(domain.completeRoleDraw(setup), { bestMoveEnabled: false });
  while (game.phase !== "day") game = domain.advanceSetupPhase(game);
  return game;
};
const history = (initial: GameState) => {
  const frames: ReplayFrame[] = [];
  return {
    frames,
    get game() {
      return frames.at(-1)?.after ?? initial;
    },
    accept(draft: CanonicalGameEventDraft) {
      const before = this.game;
      const result = domain.createGameLogEntry({
        gameId: "fixture",
        id: `event-${frames.length + 1}`,
        sequence: frames.length + 1,
        parentEventId: frames.at(-1)?.entry.id ?? null,
        createdAt: "2026-10-28T12:00:00.000Z",
        before,
        draft,
      });
      frames.push({ before, ...result });
      return this.game;
    },
  };
};

describe("history-derived player presentation", () => {
  it("keeps accepted night kills private through checks/goodbye, restores holes only at public release", () => {
    const night = domain.beginNight(day());
    const victim = night.players.find((p) => p.role === "citizen")!.seat;
    const assigned = domain.toggleAllMafiaShotsForTarget(night, victim);
    const resolved = domain.resolveMafiaShots(assigned);
    const h = history(night);
    h.accept({
      type: "mafia.shots-resolved",
      payload: { shots: resolved.secretShots, result: resolved.result },
    });
    expect(projectPlayerActions(h.frames, h.game).endpoints[victim]).toBeUndefined();
    h.accept({ type: "phase.changed", payload: { to: domain.completeMafiaShots(h.game).phase } });
    expect(projectPlayerActions(h.frames, h.game).endpoints[victim]).toBeUndefined();
    if (h.game.phase === "night-don") h.accept({ type: "don.check-skipped", payload: {} });
    if (h.game.phase === "night-sheriff") h.accept({ type: "sheriff.check-skipped", payload: {} });
    h.accept({ type: "phase.changed", payload: { to: domain.completeNight(h.game).phase } });
    expect(projectPlayerActions(h.frames, h.game).endpoints[victim]).toBeUndefined();
    const beforeRelease = h.frames.length;
    h.accept({
      type: "phase.changed",
      payload: { to: domain.completeGoodbyeSpeech(h.game).phase },
    });
    const bytes = JSON.stringify(h.frames);
    expect(projectPlayerActions(h.frames, h.game).endpoints[victim]).toBe("mafia");
    expect(
      projectPlayerActions(h.frames.slice(0, beforeRelease), h.frames[beforeRelease - 1]!.after)
        .endpoints[victim],
    ).toBeUndefined();
    expect(projectPlayerActions([], h.game).endpoints[victim]).toBe("unknown");
    expect(JSON.stringify(h.frames)).toBe(bytes);
  });

  it("recognizes the later sole nominee without a ballot and does not leak future tears into prefixes", () => {
    let initial = domain.completeMafiaShots(
      domain.resolveMafiaShots(domain.beginNight(day())).game,
    );
    if (initial.phase === "night-don") initial = domain.skipDonCheck(initial);
    if (initial.phase === "night-sheriff") initial = domain.skipSheriffCheck(initial);
    initial = domain.completeNight(initial);
    const victim = initial.players.find((p) => p.role === "citizen")!.seat;
    const nominated = domain.setNominationSelection(initial, initial.turnOrder[0]!, victim, true);
    const h = history({ ...nominated, currentTurnIndex: nominated.turnOrder.length - 1 });
    h.accept({ type: "turn.completed", payload: { seat: h.game.turnOrder.at(-1)! } });
    expect(h.game.phase).toBe("goodbye-speech");
    expect(projectPlayerActions(h.frames, h.game).endpoints[victim]).toBeUndefined();
    h.accept({ type: "phase.changed", payload: { to: "night-mafia" } });
    expect(projectPlayerActions(h.frames, h.game).endpoints[victim]).toBe("vote");
    expect(projectPlayerActions([], initial).endpoints).toEqual({});
    expect(projectPlayerActions([], h.game).endpoints[victim]).toBe("unknown");
  });

  it("exclusion overrides a shot without erasing it, announcements do not create another action", () => {
    const night = domain.beginNight(day());
    const victim = night.players.find((p) => p.role === "citizen")!.seat;
    const assigned = domain.toggleAllMafiaShotsForTarget(night, victim);
    const resolved = domain.resolveMafiaShots(assigned);
    const h = history(night);
    h.accept({
      type: "mafia.shots-resolved",
      payload: { shots: resolved.secretShots, result: resolved.result },
    });
    h.accept({
      type: "discipline.removal-observed",
      payload: {
        seat: victim,
        stage: "after-shooting-result",
        rule: "6.2.3",
        reason: "Fixture",
        checkInProgress: false,
      },
    });
    const bytes = JSON.stringify(h.game);
    expect(projectPlayerActions(h.frames, h.game).endpoints[victim]).toBe("discipline");
    expect(JSON.stringify(h.game)).toBe(bytes);
    expect(h.game.nightResult).toEqual({ kind: "kill", targetSeat: victim });
    expect(projectPlayerActions([], h.game).endpoints[victim]).toBe("discipline");
  });

  it("projects accepted foul and adjudication identities independently of departure endpoints", () => {
    const h = history(day());
    const seat = h.game.players.find((p) => p.role === "citizen")!.seat;
    for (let count = 1; count <= 3; count++) {
      h.accept({ type: "foul.issued", payload: { seat, foulNumber: count, redCarded: false } });
      expect(projectPlayerActions(h.frames, h.game).action).toMatchObject({
        id: h.frames.at(-1)!.entry.id,
        fouls: { [seat]: count },
        adjudication: false,
      });
      expect(projectPlayerActions(h.frames, h.game).endpoints).toEqual({});
    }
    h.accept({
      type: "game.adjudicated",
      payload: { losingTeam: "red", rule: "6.3.1", reason: "Fixture", committeeApproved: false },
    });
    expect(projectPlayerActions(h.frames, h.game).action).toMatchObject({
      adjudication: true,
      fouls: {},
    });
    expect(projectPlayerActions(h.frames, h.game).endpoints).toEqual({});
  });
});
