import { describe, expect, it } from "vitest";
import * as domain from "./index.js";
import type { CanonicalGameEventDraft, GameLogEntry, GameState } from "./index.js";

const phase = (to: GameState["phase"]): CanonicalGameEventDraft => ({
  type: "phase.changed",
  payload: { to },
});
const open = (roles: readonly ("don" | "sheriff")[]): CanonicalGameEventDraft => ({
  type: "night.check-windows-opened",
  payload: { roles },
});
const miss: CanonicalGameEventDraft = {
  type: "mafia.shots-resolved",
  payload: { shots: [], result: { kind: "miss" } },
};
const history = (initial?: GameState) => {
  let setup = domain.beginRoleDraw(
    domain.createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, seat: i + 1 }))),
    domain.createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  let game = initial ?? domain.createGame(domain.completeRoleDraw(setup));
  const baseline = domain.createInitialGameBaseline(game);
  const entries: GameLogEntry[] = [];
  const accept = (draft: CanonicalGameEventDraft) => {
    const accepted = domain.createGameLogEntry({
      gameId: "prior-death-checks",
      id: `e${entries.length + 1}`,
      sequence: entries.length + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: "2026-11-01T20:00:00Z",
      before: game,
      draft,
    });
    game = accepted.after;
    entries.push(accepted.entry);
    expect(
      domain.replayGameLog(
        JSON.parse(JSON.stringify(baseline)),
        JSON.parse(JSON.stringify(entries)),
      ).game,
    ).toEqual(JSON.parse(JSON.stringify(game)));
    return game;
  };
  accept({ type: "game.checkpointed", payload: {} });
  return {
    get game() {
      return game;
    },
    baseline,
    entries,
    accept,
  };
};
const kill = (game: GameState, targetSeat: number): CanonicalGameEventDraft => ({
  type: "mafia.shots-resolved",
  payload: {
    shots: game.players
      .filter((p) => p.team === "black" && p.status === "active")
      .map((p) => ({ shooterSeat: p.seat, targetSeat, secret: true })),
    result: { kind: "kill", targetSeat },
  },
});
// The Don dies by a night shot; Sheriff leaves by the following day's single-nominee vote.
const priorDeaths = () => {
  const h = history();
  const don = h.game.players.find((p) => p.role === "don")!.seat;
  const sheriff = h.game.players.find((p) => p.role === "sheriff")!.seat;
  h.accept(phase("mafia-sleep"));
  h.accept(phase("sheriff-identification"));
  h.accept(phase("day"));
  h.accept(phase("night-mafia"));
  h.accept(kill(h.game, don));
  h.accept({ type: "don.check-skipped", payload: {} });
  h.accept({ type: "sheriff.check-skipped", payload: {} });
  h.accept(phase("best-move"));
  h.accept({ type: "best-move.skipped", payload: {} });
  h.accept(phase("goodbye-speech"));
  h.accept(phase("day"));
  h.accept({
    type: "player.nominated",
    payload: { nominatorSeat: h.game.turnOrder[0]!, candidateSeat: sheriff },
  });
  h.accept(phase("goodbye-speech"));
  h.accept(phase("night-mafia"));
  h.accept(miss);
  return { h, don, sheriff };
};

const priorSheriffDeath = () => {
  const h = history();
  const don = h.game.players.find((p) => p.role === "don")!.seat;
  const sheriff = h.game.players.find((p) => p.role === "sheriff")!.seat;
  h.accept(phase("mafia-sleep"));
  h.accept(phase("sheriff-identification"));
  h.accept(phase("day"));
  h.accept(phase("night-mafia"));
  h.accept(kill(h.game, sheriff));
  h.accept({ type: "don.check-skipped", payload: {} });
  h.accept({ type: "sheriff.check-skipped", payload: {} });
  h.accept(phase("best-move"));
  h.accept({ type: "best-move.skipped", payload: {} });
  h.accept(phase("goodbye-speech"));
  h.accept(phase("day"));
  h.accept(phase("night-mafia"));
  h.accept(miss);
  return { h, don, sheriff };
};

describe("explicit night check windows after prior elimination", () => {
  it("preserves the historical prior-death prefix byte for byte", async () => {
    const { h } = priorDeaths();
    const replay = domain.replayGameLog(h.baseline, h.entries);
    const bytes = JSON.stringify({
      baseline: h.baseline,
      entries: h.entries,
      frames: replay.frames,
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
    expect({
      bytesHash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      stateHash: domain.hashGameState(h.game),
    }).toEqual({
      bytesHash: "e5a46a57d8abdb4d2dc38773d14da1e14cdde97fdffe0cfadf96810d19b2cf42",
      stateHash: "sha256:b04e76e35bccbc709f37fab1ad9ee06ef8361a9ba42d51b12549a128cd61fc1f",
    });
    expect(h.game.nightCheckEligibility).toEqual({ don: false, sheriff: false });
    expect(domain.completeMafiaShots(h.game).phase).toBe("night-resolution");
  });

  it("accepts both deceased owners' private checks without rewriting the prefix", () => {
    const { h, don, sheriff } = priorDeaths();
    const prefix = JSON.stringify(h.entries);
    const before = JSON.stringify(h.game);
    expect(domain.getNightCheckWindowsToOpen(h.game)).toEqual(["don", "sheriff"]);
    expect(JSON.stringify(h.game)).toBe(before);
    h.accept(open(["don", "sheriff"]));
    expect(h.game.phase).toBe("night-don");
    expect(
      h.game.players.filter((p) => p.seat === don || p.seat === sheriff).map((p) => p.status),
    ).toEqual(["eliminated", "eliminated"]);
    h.accept({ type: "don.checked", payload: { targetSeat: sheriff, match: true } });
    expect(h.game.checkResult).toMatchObject({ kind: "don-check", secret: true, match: true });
    h.accept(phase("night-sheriff"));
    h.accept({ type: "sheriff.checked", payload: { targetSeat: don, match: true } });
    expect(h.game.checkResult).toMatchObject({ kind: "sheriff-check", secret: true, match: true });
    expect(h.game.sheriffChecksPerformed).toBe(1);
    h.accept(phase("night-resolution"));
    expect(JSON.stringify(h.entries.slice(0, -5))).toBe(prefix);
    expect(JSON.stringify(domain.replayGameLog(h.baseline, JSON.parse(prefix)).game)).toBe(before);
    expect(domain.isSecretGameEventType("night.check-windows-opened")).toBe(true);
    h.accept(phase("day"));
    h.accept(phase("night-mafia"));
    h.accept(miss);
    h.accept(open(["don", "sheriff"]));
    h.accept({ type: "don.check-skipped", payload: {} });
    h.accept({ type: "sheriff.check-skipped", payload: {} });
    expect(h.game.sheriffChecksPerformed).toBe(1);
  });

  it("opens exactly one fresh window per deceased owner on consecutive later nights", () => {
    const { h } = priorDeaths();
    const firstNightPrefix = JSON.stringify(h.entries);
    const completedFirstNightPrefix = h.entries.length;
    h.accept(open(["don", "sheriff"]));
    h.accept({ type: "don.check-skipped", payload: {} });
    h.accept({ type: "sheriff.check-skipped", payload: {} });
    expect(() => h.accept(open(["don", "sheriff"]))).toThrow();
    h.accept(phase("day"));
    h.accept(phase("night-mafia"));
    h.accept(miss);

    expect(h.game.nightCheckEligibility).toEqual({ don: false, sheriff: false });
    expect(domain.getNightCheckWindowsToOpen(h.game)).toEqual(["don", "sheriff"]);
    h.accept(open(["don", "sheriff"]));
    expect(h.game.phase).toBe("night-don");
    expect(h.game.nightCheckEligibility).toEqual({ don: true, sheriff: true });
    expect(() => h.accept(open(["don", "sheriff"]))).toThrow();
    expect(JSON.stringify(h.entries.slice(0, completedFirstNightPrefix))).toBe(firstNightPrefix);
  });

  it.each([false, true])(
    "continues a deceased Sheriff after Don sanction (underway=%s)",
    (underway) => {
      const { h: original, sheriff } = priorDeaths();
      const game = original.game;
      const don = game.players.find((p) => p.role === "don")!;
      // A resumed current-format night with only Sheriff previously eliminated.
      const h = history({
        ...game,
        players: game.players.map((p) => (p.seat === don.seat ? { ...p, status: "active" } : p)),
        nightCheckEligibility: { don: true, sheriff: false },
      });
      h.accept(phase("night-don"));
      h.accept({
        type: "discipline.removal-observed",
        payload: {
          seat: don.seat,
          stage: "don-check",
          rule: "6.2.3",
          reason: "",
          checkInProgress: underway,
        },
      });
      if (underway) {
        expect(() => h.accept(open(["sheriff"]))).toThrow();
        expect(() => h.accept({ type: "don.check-skipped", payload: {} })).toThrow();
        h.accept({ type: "don.checked", payload: { targetSeat: sheriff, match: true } });
      } else expect(h.game.phase).toBe("night-resolution");
      const prefix = JSON.stringify(h.entries);
      h.accept(open(["sheriff"]));
      expect(h.game.phase).toBe("night-sheriff");
      expect(h.game.disciplinaryRemovals?.at(-1)).toMatchObject({
        departure: "departed",
        checkCompletionPending: false,
        announcement: "pending",
      });
      h.accept({ type: "sheriff.checked", payload: { targetSeat: don.seat, match: true } });
      h.accept(phase("night-resolution"));
      expect(() => h.accept(open(["sheriff"]))).toThrow();
      expect(JSON.stringify(h.entries.slice(0, -3))).toBe(prefix);
      h.accept({ type: "discipline.removals-announced", payload: { seats: [don.seat] } });
    },
  );

  it("continues an ordinary Don result into the still-unopened deceased Sheriff window", () => {
    const { h: original, don, sheriff } = priorDeaths();
    const h = history({
      ...original.game,
      players: original.game.players.map((p) => (p.seat === don ? { ...p, status: "active" } : p)),
      nightCheckEligibility: { don: true, sheriff: false },
    });
    h.accept({ type: "don.checked", payload: { targetSeat: sheriff, match: true } });
    h.accept(open(["sheriff"]));
    expect(h.game.phase).toBe("night-sheriff");
    expect(h.game.checkResult).toBeUndefined();
  });

  it.each(["checked", "skipped"] as const)(
    "retains an already-opened Sheriff window after Don removal, then consumes it when %s",
    (completion) => {
      const { h, don, sheriff } = priorSheriffDeath();
      h.accept(open(["sheriff"]));
      expect(h.game.phase).toBe("night-don");
      expect(h.game.nightCheckEligibility).toEqual({ don: true, sheriff: true });
      h.accept({
        type: "discipline.removal-observed",
        payload: {
          seat: don,
          stage: "don-check",
          rule: "6.2.3",
          reason: "",
          checkInProgress: false,
        },
      });
      expect(h.game.phase).toBe("night-resolution");
      const prefix = JSON.stringify(h.entries);
      const prefixLength = h.entries.length;
      expect(domain.getNightCheckWindowsToOpen(h.game)).toEqual(["sheriff"]);
      h.accept(open(["sheriff"]));
      expect(h.game.phase).toBe("night-sheriff");
      expect(h.game.players.find((p) => p.seat === sheriff)?.status).toBe("eliminated");
      if (completion === "checked") {
        h.accept({ type: "sheriff.checked", payload: { targetSeat: don, match: true } });
        h.accept(phase("night-resolution"));
      } else h.accept({ type: "sheriff.check-skipped", payload: {} });
      expect(h.game.sheriffChecksPerformed).toBe(completion === "checked" ? 1 : 0);
      expect(domain.getNightCheckWindowsToOpen(h.game)).toEqual([]);
      expect(() => h.accept(open(["sheriff"]))).toThrow();
      expect(JSON.stringify(h.entries.slice(0, prefixLength))).toBe(prefix);
      h.accept(phase("day"));
      expect(h.game.day).toBe(3);
    },
  );

  it("rejects malformed, forged, repeated and already consumed openings", () => {
    const { h } = priorDeaths();
    for (const payload of [
      {},
      { roles: [] },
      { roles: ["don", "don"] },
      { roles: ["sheriff", "don"] },
      { roles: ["citizen"] },
      { roles: "don" },
      { roles: ["don"], extra: true },
    ]) {
      expect(() =>
        domain.assertCanonicalGameEventDraft({ type: "night.check-windows-opened", payload }),
      ).toThrow();
    }
    expect(() => h.accept(open(["don"]))).toThrow();
    expect(() => h.accept(open(["sheriff"]))).toThrow();
    const skipped = domain.completeMafiaShots(h.game);
    expect(() => domain.applyGameEvent(skipped, open(["don", "sheriff"]))).toThrow();
    h.accept(open(["don", "sheriff"]));
    expect(() => h.accept(open(["don", "sheriff"]))).toThrow();
    h.accept({ type: "don.check-skipped", payload: {} });
    h.accept({ type: "sheriff.check-skipped", payload: {} });
    expect(() => h.accept(open(["sheriff"]))).toThrow();
  });

  it("skips Don into a deceased Sheriff window from a restored historical night", () => {
    const { h } = priorSheriffDeath();
    h.accept(phase("night-don"));
    const restored = JSON.parse(JSON.stringify(h.game)) as GameState;
    const prefix = JSON.stringify(h.entries);
    const prefixLength = h.entries.length;
    const historicalSkip = domain.applyGameEvent(restored, {
      type: "don.check-skipped",
      payload: {},
    });
    expect(historicalSkip.phase).toBe("night-resolution");
    expect(historicalSkip.pendingSheriffCheckDay).toBeUndefined();
    expect(domain.getNightCheckWindowsToOpen(restored)).toEqual(["sheriff"]);
    expect(h.accept(open(["sheriff"]))).toEqual(domain.applyGameEvent(restored, open(["sheriff"])));
    expect(h.game.phase).toBe("night-sheriff");
    expect(h.game.checkResult).toBeUndefined();
    h.accept({ type: "sheriff.check-skipped", payload: {} });
    expect(h.game.sheriffChecksPerformed).toBe(0);
    expect(domain.getNightCheckWindowsToOpen(h.game)).toEqual([]);
    expect(JSON.stringify(h.entries.slice(0, prefixLength))).toBe(prefix);
    h.accept(phase("day"));
  });

  it("requires same-night unconsumed removal evidence and settled physical departures", () => {
    const { h: original, don, sheriff } = priorDeaths();
    const h = history({
      ...original.game,
      players: original.game.players.map((p) => (p.seat === don ? { ...p, status: "active" } : p)),
      nightCheckEligibility: { don: true, sheriff: false },
    });
    h.accept(phase("night-don"));
    h.accept({
      type: "discipline.removal-observed",
      payload: { seat: don, stage: "don-check", rule: "6.2.3", reason: "", checkInProgress: false },
    });
    expect(domain.getNightCheckWindowsToOpen(h.game)).toEqual(["sheriff"]);
    const removal = h.game.disciplinaryRemovals![0]!;
    const invalid: GameState[] = [
      { ...h.game, disciplinaryRemovals: [] },
      { ...h.game, disciplinaryRemovals: [{ ...removal, day: removal.day - 1 }] },
      { ...h.game, disciplinaryRemovals: [{ ...removal, departure: "pending" }] },
      { ...h.game, disciplinaryRemovals: [{ ...removal, checkCompletionPending: true }] },
      { ...h.game, nightCheckEligibility: undefined },
      { ...h.game, nightCheckEligibility: { don: true, sheriff: true } },
      {
        ...h.game,
        players: h.game.players.map((p) =>
          p.seat === sheriff ? { ...p, status: "red-carded" } : p,
        ),
      },
    ];
    for (const game of invalid) {
      expect(domain.getNightCheckWindowsToOpen(game)).toEqual([]);
      expect(() => domain.applyGameEvent(game, open(["sheriff"]))).toThrow();
    }
    const pendingAtShots: GameState = {
      ...original.game,
      disciplinaryRemovals: [{ ...removal, departure: "pending" }],
    };
    expect(domain.getNightCheckWindowsToOpen(pendingAtShots)).toEqual([]);
    expect(() => domain.applyGameEvent(pendingAtShots, open(["don", "sheriff"]))).toThrow();
    // A recorded announcement is preserved too; no acknowledgement is invented.
    h.accept({ type: "discipline.removals-announced", payload: { seats: [don] } });
    h.accept(open(["sheriff"]));
    expect(h.game.disciplinaryRemovals![0]!.announcement).toBe("announced");
  });

  it("excludes prior red cards and same-night pending owners, and rejects decisive results", () => {
    const { h, don, sheriff } = priorDeaths();
    const redCarded = {
      ...h.game,
      players: h.game.players.map((p) =>
        p.seat === don ? { ...p, status: "red-carded" as const } : p,
      ),
    };
    expect(domain.getNightCheckWindowsToOpen(redCarded)).toEqual(["sheriff"]);
    expect(() => domain.applyGameEvent(redCarded, open(["don", "sheriff"]))).toThrow();
    const sameNight = {
      ...h.game,
      players: h.game.players.map((p) =>
        p.seat === sheriff ? { ...p, status: "active" as const } : p,
      ),
      nightResult: { kind: "kill" as const, targetSeat: sheriff },
      nightCheckEligibility: { don: false, sheriff: true },
    };
    expect(domain.getNightCheckWindowsToOpen(sameNight)).toEqual(["don"]);
    const opened = domain.applyGameEvent(sameNight, open(["don"]));
    expect(opened.nightCheckEligibility).toEqual({ don: true, sheriff: true });
    expect(domain.skipDonCheck(opened).phase).toBe("night-sheriff");
    const redSeats = h.game.players
      .filter((p) => p.status === "active" && p.team === "red")
      .map((p) => p.seat);
    const decisive = {
      ...h.game,
      players: h.game.players.map((p) =>
        redSeats.slice(3).includes(p.seat) ? { ...p, status: "eliminated" as const } : p,
      ),
      nightResult: { kind: "kill" as const, targetSeat: redSeats[0]! },
    };
    expect(domain.completeMafiaShots(decisive).phase).toBe("finished");
    expect(domain.getNightCheckWindowsToOpen(decisive)).toEqual([]);
    expect(() => domain.applyGameEvent(decisive, open(["don", "sheriff"]))).toThrow();
    expect(() =>
      domain.applyGameEvent(domain.completeMafiaShots(decisive), open(["don", "sheriff"])),
    ).toThrow();
  });
});
