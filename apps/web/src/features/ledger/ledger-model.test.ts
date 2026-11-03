import { describe, expect, it } from "vitest";
import {
  createGameLogEntry,
  createInitialGameBaseline,
  replayGameLog,
  resolveVote,
  beginNight,
  resolveMafiaShots,
  type ShotAssignment,
  resolveCompletedCarCrashCount,
  toggleMafiaShot,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type GameState,
} from "@mafia/game-domain";
import { getActiveBranch } from "../game/game-history.js";
import { createSampleGameHistory } from "../timeline/sample-game-data.js";
import { ledgerHistoryMessages } from "../../i18n/messages/ledger-history.js";
import type { LedgerModel } from "./ledger-types.js";
import { projectLedger } from "./ledger-model.js";

const sample = createSampleGameHistory();
const zeroRound = sample.frames.find(({ after }) => after.phase === "day")!.after;
const history = (initial: GameState = zeroRound) => {
  const baseline = createInitialGameBaseline(initial);
  const entries: GameLogEntry[] = [];
  let game = initial;
  const h = {
    get game() {
      return game;
    },
    append(draft: CanonicalGameEventDraft) {
      const sequence = entries.length + 1;
      const result = createGameLogEntry({
        gameId: "ledger-test-game",
        id: `ledger-source-${sequence}`,
        sequence,
        parentEventId: entries.at(-1)?.id ?? null,
        createdAt: "2026-11-02T18:00:00.000Z",
        before: game,
        draft,
      });
      entries.push(result.entry);
      game = result.after;
      return result.entry.id;
    },
    input(privacyHidden = false) {
      const replayed = replayGameLog(
        baseline,
        getActiveBranch(entries, entries.at(-1)?.id ?? null),
      );
      expect(replayed.game).toEqual(game);
      return { frames: replayed.frames, game: replayed.game, privacyHidden };
    },
  };
  h.append({ type: "game.checkpointed", payload: {} });
  return h;
};
const facts = (model: LedgerModel, seat: number, day: number) =>
  model.rows.find((row) => row.seat === seat)!.cells.find((cell) => cell.day === day)!.facts;

const startBallot = (h: ReturnType<typeof history>) => {
  h.append({ type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: 6 } });
  h.append({ type: "player.nominated", payload: { nominatorSeat: 2, candidateSeat: 7 } });
  h.append({ type: "phase.changed", payload: { to: "voting" } });
};
type History = ReturnType<typeof history>;
const recordedVotes = (game: GameState): Record<number, number> =>
  Object.fromEntries(
    Object.entries(game.voteAssignments).filter(
      (entry): entry is [string, number] => entry[1] !== undefined,
    ),
  );
const closeBallot = (h: History) =>
  h.append({
    type: "voting.resolved",
    payload: { voteAssignments: recordedVotes(h.game), result: resolveVote(h.game) },
  });
const tiedBallot = (h: ReturnType<typeof history>) => {
  h.append({ type: "voting.candidate-selected", payload: { candidateSeat: 6 } });
  for (const voterSeat of [1, 2, 3, 4, 5])
    h.append({ type: "vote.recorded", payload: { voterSeat, candidateSeat: 6 } });
  h.append({ type: "voting.candidate-selected", payload: { candidateSeat: 7 } });
  return closeBallot(h);
};

const ordinaryNight = beginNight({
  ...zeroRound,
  firstDayDepartureSeats: [6],
  players: zeroRound.players.map((player) => {
    const role =
      player.seat === 1
        ? "don"
        : player.seat <= 3
          ? "mafia"
          : player.seat === 10
            ? "sheriff"
            : "citizen";
    return {
      ...player,
      role,
      team: role === "don" || role === "mafia" ? "black" : "red",
      status: player.seat === 6 ? "eliminated" : "active",
    };
  }),
});
const shoot = (h: History, targets: Readonly<Record<number, number>>) => {
  const shots: ShotAssignment[] = Object.entries(targets).map(([shooter, targetSeat]) => ({
    shooterSeat: Number(shooter),
    targetSeat,
    secret: true,
  }));
  const resolved = resolveMafiaShots({ ...h.game, shotAssignments: targets });
  h.append({ type: "mafia.shots-resolved", payload: { shots, result: resolved.result } });
};
const finishChecks = (h: History) => {
  h.append({ type: "phase.changed", payload: { to: "night-don" } });
  if (h.game.phase === "night-don") h.append({ type: "don.check-skipped", payload: {} });
  if (h.game.phase === "night-sheriff") h.append({ type: "sheriff.check-skipped", payload: {} });
};
const allFacts = (model: LedgerModel) =>
  model.rows.flatMap(({ cells }) => cells.flatMap(({ facts }) => facts));

describe("pure admitted-history ledger projection", () => {
  it("retains accepted nominations after the current game has cleared them", () => {
    expect(sample.game.nominations).toEqual([]);
    const model = projectLedger({ ...sample, privacyHidden: false });
    expect(facts(model, 1, 1)).toContainEqual(
      expect.objectContaining({
        kind: "nomination",
        period: "day",
        values: { seat: 7 },
      }),
    );
    expect(facts(model, 2, 1)).toContainEqual(
      expect.objectContaining({
        kind: "nomination",
        values: { seat: 6 },
      }),
    );
    expect(model.columns.map(({ day }) => day)).toEqual([0, 1, 2, 3]);
  });

  it("keeps ordered real ballot attempts and a completed zero-support collective count", () => {
    const h = history();
    startBallot(h);
    const first = tiedBallot(h);
    h.append({ type: "phase.changed", payload: { to: "voting" } });
    const second = tiedBallot(h);
    expect(h.game.phase).toBe("car-crash-decision");
    const collective = h.append({
      type: "car-crash.count-completed",
      payload: {
        votes: {},
        result: resolveCompletedCarCrashCount(h.game),
      },
    });
    const model = projectLedger(h.input());
    const row = facts(model, 1, 1);
    expect(row.filter(({ kind }) => kind === "vote").map(({ values }) => values)).toEqual([
      { seat: 6, attempt: 1 },
      { seat: 6, attempt: 2 },
    ]);
    expect(
      row.filter(({ kind }) => kind === "ballotClosed").map(({ values }) => values?.attempt),
    ).toEqual([1, 2, 3]);
    expect(row.some(({ id }) => id.includes(first))).toBe(true);
    expect(row.some(({ id }) => id.includes(second))).toBe(true);
    expect(row.some(({ id }) => id.includes(collective))).toBe(true);
    expect(row).toContainEqual(
      expect.objectContaining({
        kind: "ballotClosed",
        values: { attempt: 3, count: 0, total: 10 },
      }),
    );
    expect(row).toContainEqual(
      expect.objectContaining({ kind: "collectiveUnobserved", values: { attempt: 3 } }),
    );
    expect(
      model.rows
        .flatMap(({ cells }) => cells.flatMap(({ facts }) => facts))
        .some(({ kind }) => kind === "collectiveNo"),
    ).toBe(false);
  });

  it("does not turn conclusive partial counts into unrecorded individual votes", () => {
    const h = history();
    startBallot(h);
    h.append({ type: "voting.candidate-selected", payload: { candidateSeat: 6 } });
    for (const voterSeat of [1, 2, 3, 4, 5, 6])
      h.append({ type: "vote.recorded", payload: { voterSeat, candidateSeat: 6 } });
    closeBallot(h);
    const model = projectLedger(h.input());
    expect(facts(model, 10, 1).filter(({ kind }) => kind === "vote")).toEqual([]);
    expect(facts(model, 10, 1)).toContainEqual(
      expect.objectContaining({ kind: "voteUnassigned", values: { attempt: 1 } }),
    );
    expect(facts(model, 1, 1)).toContainEqual(
      expect.objectContaining({ kind: "vote", values: { seat: 6, attempt: 1 } }),
    );
  });

  it("separates repeated physical observations from corrected primary shot assignments", () => {
    const h = history(ordinaryNight);
    h.append({
      type: "mafia.shots-observed",
      payload: {
        shotAssignments: { 1: 7 },
        observations: [
          { shooterSeat: 1, targetSeat: 8 },
          { shooterSeat: 1, targetSeat: 8 },
        ],
      },
    });
    shoot(h, { 1: 9, 2: 9, 3: 9 });
    const row = facts(projectLedger(h.input()), 1, 1);
    expect(
      row.filter(({ kind }) => kind === "shotObserved").map(({ values }) => values?.seat),
    ).toEqual([8, 8]);
    expect(row.filter(({ kind }) => kind === "shot").map(({ values }) => values?.seat)).toEqual([
      9,
    ]);
    expect(new Set(row.map(({ id }) => id)).size).toBe(row.length);
    expect(row.some(({ kind }) => kind === "miss")).toBe(true);
  });

  it.each([
    { targets: { 1: 8, 2: 8, 3: 8 }, kind: "killed" },
    { targets: { 1: 6, 2: 6, 3: 6 }, kind: "noEffect" },
    { targets: { 1: 8, 2: 9, 3: 8 }, kind: "miss" },
  ])("preserves the accepted $kind shot outcome", ({ targets, kind }) => {
    const h = history(ordinaryNight);
    shoot(h, targets);
    expect(facts(projectLedger(h.input()), 1, 1)).toContainEqual(
      expect.objectContaining({ kind, period: "night" }),
    );
  });

  it("uses actual Don/Sheriff result semantics and suppresses all private occurrences", () => {
    const h = history(ordinaryNight);
    shoot(h, { 1: 8, 2: 8, 3: 8 });
    h.append({ type: "phase.changed", payload: { to: "night-don" } });
    h.append({ type: "don.checked", payload: { targetSeat: 10, match: true } });
    h.append({ type: "phase.changed", payload: { to: "night-sheriff" } });
    h.append({ type: "sheriff.checked", payload: { targetSeat: 1, match: true } });
    const revealed = projectLedger(h.input());
    expect(facts(revealed, 1, 1)).toContainEqual(
      expect.objectContaining({ kind: "donMatch", values: { seat: 10 } }),
    );
    expect(facts(revealed, 10, 1)).toContainEqual(
      expect.objectContaining({ kind: "sheriffMatch", values: { seat: 1 } }),
    );
    const hidden = projectLedger(h.input(true));
    expect(allFacts(hidden)).toEqual([]);
    expect(hidden).toEqual(projectLedger({ frames: [], game: h.game, privacyHidden: true }));
  });

  it("withholds night and morning-goodbye departure until its public release, retaining the originating night column", () => {
    const h = history({ ...ordinaryNight, bestMoveEnabled: false });
    shoot(h, { 1: 8, 2: 8, 3: 8 });
    finishChecks(h);
    expect(allFacts(projectLedger(h.input(true))).some(({ kind }) => kind === "eliminated")).toBe(
      false,
    );
    h.append({ type: "phase.changed", payload: { to: "goodbye-speech" } });
    expect(h.game.day).toBe(2);
    expect(h.game.phase).toBe("goodbye-speech");
    expect(allFacts(projectLedger(h.input(true))).some(({ kind }) => kind === "eliminated")).toBe(
      false,
    );
    h.append({ type: "phase.changed", payload: { to: "day" } });
    const model = projectLedger(h.input(true));
    expect(facts(model, 8, 1)).toContainEqual(
      expect.objectContaining({ kind: "eliminated", period: "night" }),
    );
    expect(facts(model, 8, 2)).toEqual([]);
  });

  it("keeps finalized partial and repeated Best Move entries, not an invented complete list", () => {
    const h = history({ ...ordinaryNight, bestMoveEnabled: true });
    shoot(h, { 1: 8, 2: 8, 3: 8 });
    finishChecks(h);
    h.append({ type: "phase.changed", payload: { to: "best-move" } });
    h.append({ type: "best-move.number-accepted", payload: { seat: 1 } });
    h.append({ type: "best-move.number-accepted", payload: { seat: 1 } });
    h.append({
      type: "best-move.finalized",
      payload: { reason: "finished-early", readbackAcknowledged: true },
    });
    expect(
      facts(projectLedger(h.input()), 8, 1)
        .filter(({ kind }) => kind === "bestMove")
        .map(({ values }) => values?.seat),
    ).toEqual([1, 1]);
    expect(allFacts(projectLedger(h.input(true)))).toEqual([]);
  });

  it("distinguishes unavailable history, valid empty history and a checkpoint without inventing old actions", () => {
    const unavailable = projectLedger({
      game: sample.game,
      frames: undefined,
      privacyHidden: false,
    });
    const empty = projectLedger({ game: sample.game, frames: [], privacyHidden: false });
    expect(unavailable.historyAvailable).toBe(false);
    expect(empty.historyAvailable).toBe(true);
    expect(unavailable.rows[0]!.cells.at(-1)!.state).toBe("unknown");
    expect(empty.rows[0]!.cells.at(-1)!.state).toBe("pending");
    const h = history(sample.game);
    expect(allFacts(projectLedger(h.input()))).toEqual([]);
    expect(allFacts(unavailable)).toEqual([]);
    expect(allFacts(empty)).toEqual([]);
  });

  it("shows a current shot draft as provisional without manufacturing accepted history", () => {
    const h = history(ordinaryNight);
    const input = h.input();
    const draft = toggleMafiaShot(input.game, 1, 8);
    const model = projectLedger({ ...input, game: draft });
    expect(facts(model, 1, 1)).toContainEqual(
      expect.objectContaining({ kind: "shot", provisional: true, values: { seat: 8 } }),
    );
    expect(model.rows[0]!.cells[1]!.state).toBe("pending");
    expect(allFacts(projectLedger({ ...input, game: draft, privacyHidden: true }))).toEqual([]);
    expect(input.game.shotAssignments).toEqual({});
  });

  it("projects surviving nomination and unique-support relations, including observed corrected zero", () => {
    const h = history();
    h.append({
      type: "nomination.selection-set",
      payload: { nominatorSeat: 1, candidateSeat: 6, selected: true },
    });
    h.append({
      type: "nomination.selection-set",
      payload: { nominatorSeat: 2, candidateSeat: 6, selected: true },
    });
    h.append({
      type: "nomination.selection-set",
      payload: { nominatorSeat: 2, candidateSeat: 6, selected: false },
    });
    h.append({
      type: "nomination.selection-set",
      payload: { nominatorSeat: 2, candidateSeat: 6, selected: true },
    });
    expect(facts(projectLedger(h.input(true)), 6, 1)).toContainEqual(
      expect.objectContaining({ kind: "support", values: { count: 1, seats: "2" } }),
    );
    h.append({
      type: "nomination.selection-set",
      payload: { nominatorSeat: 2, candidateSeat: 6, selected: false },
    });
    const model = projectLedger(h.input(true));
    expect(allFacts(model).filter(({ kind }) => kind === "nomination")).toHaveLength(1);
    expect(facts(model, 6, 1)).toContainEqual(
      expect.objectContaining({ kind: "support", values: { count: 0, seats: "—" } }),
    );
    expect(facts(model, 2, 1).some(({ kind }) => kind === "nomination")).toBe(false);
  });

  it("does not promote checkpoint nominations or a no-op deselection into observed actions or support", () => {
    const before = history();
    before.append({ type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: 6 } });
    const h = history(before.game);
    expect(() =>
      h.append({
        type: "nomination.selection-set",
        payload: { nominatorSeat: 2, candidateSeat: 6, selected: false },
      }),
    ).toThrow("Nomination selection must change");
    h.append({ type: "player.nominated", payload: { nominatorSeat: 2, candidateSeat: 7 } });
    const model = projectLedger(h.input());
    expect(
      allFacts(model)
        .filter(({ kind }) => kind === "nomination")
        .map(({ values }) => values?.seat),
    ).toEqual([7]);
    expect(allFacts(model).some(({ kind }) => kind === "support")).toBe(false);
  });

  it.each([1, 2])("handles a sole nominee at internal day %i without fabricating a vote", (day) => {
    const h = history({
      ...zeroRound,
      day,
      completedGameNights: day,
      currentTurnIndex: zeroRound.turnOrder.length - 1,
    });
    h.append({ type: "player.nominated", payload: { nominatorSeat: 10, candidateSeat: 6 } });
    const source = h.append({ type: "turn.completed", payload: { seat: 10 } });
    const model = projectLedger(h.input());
    expect(facts(model, 1, day)).toContainEqual(
      expect.objectContaining({ kind: day === 1 ? "ballotSkipped" : "ballotClosed" }),
    );
    expect(allFacts(model).some(({ kind }) => kind === "vote" || kind === "voteUnassigned")).toBe(
      false,
    );
    expect(allFacts(model).some(({ id }) => id.includes(source))).toBe(true);
  });

  it("retains a public dispute and final corrected ballot, not clerical tap history or private reasons", () => {
    const h = history();
    startBallot(h);
    h.append({ type: "voting.candidate-selected", payload: { candidateSeat: 6 } });
    h.append({ type: "vote.recorded", payload: { voterSeat: 1, candidateSeat: 6 } });
    h.append({
      type: "voting.count-disputed",
      payload: { candidateSeat: 6, reason: "private judge detail" },
    });
    const voteAssignments = Object.fromEntries(h.game.players.map(({ seat }) => [seat, 7]));
    h.append({
      type: "voting.count-ruled",
      payload: {
        voteAssignments,
        externalReviewAcknowledged: true,
        reason: "private judge detail",
      },
    });
    closeBallot(h);
    const model = projectLedger(h.input(true));
    expect(
      facts(model, 1, 1)
        .filter(({ kind }) => kind === "vote")
        .map(({ values }) => values?.seat),
    ).toEqual([7]);
    expect(facts(model, 1, 1).some(({ kind }) => kind === "ballotDisputed")).toBe(true);
    expect(JSON.stringify(model)).not.toContain("private judge detail");
  });

  it("supplements accepted ballot choices with distinguishable current drafts", () => {
    const h = history();
    startBallot(h);
    h.append({ type: "voting.candidate-selected", payload: { candidateSeat: 6 } });
    h.append({ type: "vote.recorded", payload: { voterSeat: 1, candidateSeat: 6 } });
    const input = h.input();
    const model = projectLedger({ ...input, game: { ...input.game, voteAssignments: { 1: 7 } } });
    const votes = facts(model, 1, 1).filter(({ kind }) => kind === "vote");
    expect(votes.map(({ values, provisional }) => [values?.seat, provisional === true])).toEqual([
      [6, false],
      [7, true],
    ]);
    expect(input.game.voteAssignments[1]).toBe(6);
  });

  it("records public foul/removal facts and disciplinary ballot cancellation without secret context", () => {
    const h = history();
    startBallot(h);
    for (const foulNumber of [1, 2, 3, 4])
      h.append({
        type: "foul.issued",
        payload: { seat: 4, foulNumber, redCarded: foulNumber === 4 },
      });
    const model = projectLedger(h.input(true));
    expect(
      facts(model, 4, 1)
        .filter(({ kind }) => kind === "foul")
        .map(({ values }) => values?.count),
    ).toEqual([1, 2, 3, 4]);
    expect(facts(model, 4, 1).some(({ kind }) => kind === "removed")).toBe(true);
    expect(facts(model, 1, 1).some(({ kind }) => kind === "ballotCancelled")).toBe(true);
  });

  it("allows an observed Sheriff check after the owner's death when entitlement survives", () => {
    const h = history(ordinaryNight);
    shoot(h, { 1: 10, 2: 10, 3: 10 });
    h.append({ type: "phase.changed", payload: { to: "night-don" } });
    expect(h.game.players.find(({ seat }) => seat === 10)!.status).toBe("eliminated");
    h.append({ type: "don.check-skipped", payload: {} });
    h.append({ type: "sheriff.checked", payload: { targetSeat: 1, match: true } });
    const row = facts(projectLedger(h.input()), 10, 1);
    expect(row.some(({ kind }) => kind === "sheriffMatch")).toBe(true);
    expect(row.some(({ kind }) => kind === "checkUnavailable")).toBe(false);
  });

  it.each(["full history", "checkpoint"])(
    "does not label reopened post-death checks unavailable with %s",
    (source) => {
      const full = history();
      const don = full.game.players.find((player) => player.role === "don")!;
      const sheriff = full.game.players.find((player) => player.role === "sheriff")!;
      full.append({ type: "phase.changed", payload: { to: "night-mafia" } });
      shoot(
        full,
        Object.fromEntries(
          full.game.players
            .filter((player) => player.team === "black")
            .map((player) => [player.seat, don.seat]),
        ),
      );
      full.append({ type: "don.check-skipped", payload: {} });
      full.append({ type: "sheriff.check-skipped", payload: {} });
      full.append({ type: "phase.changed", payload: { to: "best-move" } });
      full.append({ type: "best-move.skipped", payload: {} });
      full.append({ type: "phase.changed", payload: { to: "goodbye-speech" } });
      full.append({ type: "phase.changed", payload: { to: "day" } });
      full.append({
        type: "player.nominated",
        payload: { nominatorSeat: full.game.turnOrder[0]!, candidateSeat: sheriff.seat },
      });
      full.append({ type: "phase.changed", payload: { to: "goodbye-speech" } });
      full.append({ type: "phase.changed", payload: { to: "night-mafia" } });
      shoot(full, {});
      expect(full.game.nightCheckEligibility).toEqual({ don: false, sheriff: false });
      const h = source === "checkpoint" ? history(full.game) : full;
      const day = h.game.day;
      h.append({ type: "night.check-windows-opened", payload: { roles: ["don", "sheriff"] } });
      expect(h.game.nightCheckEligibility).toEqual({ don: true, sheriff: true });
      h.append({ type: "don.checked", payload: { targetSeat: sheriff.seat, match: true } });
      h.append({ type: "phase.changed", payload: { to: "night-sheriff" } });
      h.append({ type: "sheriff.checked", payload: { targetSeat: don.seat, match: true } });
      const model = projectLedger(h.input());
      for (const [seat, kind] of [
        [don.seat, "donMatch"],
        [sheriff.seat, "sheriffMatch"],
      ] as const) {
        expect(facts(model, seat, day).some((fact) => fact.kind === kind)).toBe(true);
        expect(facts(model, seat, day).some((fact) => fact.kind === "checkUnavailable")).toBe(
          false,
        );
      }
      expect(
        allFacts(projectLedger(h.input(true))).some((fact) =>
          ["donMatch", "sheriffMatch", "checkUnavailable"].includes(fact.kind),
        ),
      ).toBe(false);
    },
  );

  it("replaces an earlier unavailable Sheriff observation only in the prefix that opens its window", () => {
    const h = history(
      beginNight({
        ...ordinaryNight,
        phase: "day",
        players: ordinaryNight.players.map((player) =>
          player.role === "sheriff" ? { ...player, status: "eliminated" } : player,
        ),
        firstDayDepartureSeats: [6, 10],
      }),
    );
    shoot(h, { 1: 8, 2: 8, 3: 8 });
    h.append({ type: "phase.changed", payload: { to: "night-don" } });
    const earlier = h.input();
    expect(
      facts(projectLedger(earlier), 10, 1).some((fact) => fact.kind === "checkUnavailable"),
    ).toBe(true);
    h.append({ type: "night.check-windows-opened", payload: { roles: ["sheriff"] } });
    h.append({ type: "sheriff.checked", payload: { targetSeat: 1, match: true } });
    const current = facts(projectLedger(h.input()), 10, 1);
    expect(current.some((fact) => fact.kind === "sheriffMatch")).toBe(true);
    expect(current.some((fact) => fact.kind === "checkUnavailable")).toBe(false);
    expect(
      facts(projectLedger(earlier), 10, 1).some((fact) => fact.kind === "checkUnavailable"),
    ).toBe(true);
  });

  it("does not leak future accepted actions into an Undo prefix and never mutates the frozen sample", () => {
    const end = sample.frames.findIndex(({ entry }) => entry.type === "player.nominated");
    const prefix = sample.frames.slice(0, end);
    const input = { frames: prefix, game: prefix.at(-1)!.after, privacyHidden: false };
    const before = JSON.stringify(input);
    const projected = projectLedger(input);
    expect(allFacts(projected).some(({ kind }) => kind === "nomination")).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
    expect(projectLedger(input)).toEqual(projected);
    expect(
      allFacts(projectLedger({ ...sample, privacyHidden: false })).some(
        ({ kind }) => kind === "nomination",
      ),
    ).toBe(true);
  });

  it("distinguishes explicit skipped/unavailable checks and preserves negative match semantics", () => {
    const negative = history(ordinaryNight);
    shoot(negative, { 1: 8, 2: 8, 3: 8 });
    negative.append({ type: "phase.changed", payload: { to: "night-don" } });
    negative.append({ type: "don.checked", payload: { targetSeat: 2, match: false } });
    negative.append({ type: "phase.changed", payload: { to: "night-sheriff" } });
    negative.append({ type: "sheriff.checked", payload: { targetSeat: 7, match: false } });
    const checked = projectLedger(negative.input());
    expect(facts(checked, 1, 1).some(({ kind }) => kind === "donNoMatch")).toBe(true);
    expect(facts(checked, 10, 1).some(({ kind }) => kind === "sheriffNoMatch")).toBe(true);
    const initial = beginNight({
      ...ordinaryNight,
      phase: "day",
      players: ordinaryNight.players.map((player) =>
        player.seat === 10 ? { ...player, status: "eliminated" } : player,
      ),
      firstDayDepartureSeats: [6, 10],
    });
    const h = history(initial);
    shoot(h, { 1: 8, 2: 8, 3: 8 });
    h.append({ type: "phase.changed", payload: { to: "night-don" } });
    h.append({ type: "don.check-skipped", payload: {} });
    const model = projectLedger(h.input());
    expect(facts(model, 1, 1).some(({ kind }) => kind === "checkSkipped")).toBe(true);
    expect(facts(model, 10, 1).some(({ kind }) => kind === "checkUnavailable")).toBe(true);
    expect(allFacts(projectLedger(h.input(true)))).toEqual([]);
  });

  it("keeps explicit collective yes/no distinct from unobserved responses", () => {
    const h = history();
    startBallot(h);
    tiedBallot(h);
    h.append({ type: "phase.changed", payload: { to: "voting" } });
    tiedBallot(h);
    const votes = { 1: true, 2: false };
    h.append({
      type: "car-crash.count-completed",
      payload: {
        votes,
        result: resolveCompletedCarCrashCount({ ...h.game, carCrashVotes: votes }),
      },
    });
    const model = projectLedger(h.input());
    expect(facts(model, 1, 1).some(({ kind }) => kind === "collectiveYes")).toBe(true);
    expect(facts(model, 2, 1).some(({ kind }) => kind === "collectiveNo")).toBe(true);
    expect(facts(model, 3, 1).some(({ kind }) => kind === "collectiveUnobserved")).toBe(true);
  });

  it("does not carry observed zero support into a replacement unobserved nomination relation", () => {
    const h = history();
    h.append({
      type: "nomination.selection-set",
      payload: { nominatorSeat: 1, candidateSeat: 6, selected: true },
    });
    h.append({
      type: "nomination.selection-set",
      payload: { nominatorSeat: 1, candidateSeat: 6, selected: false },
    });
    h.append({ type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: 6 } });
    expect(
      allFacts(projectLedger(h.input())).filter(({ kind }) => kind === "nomination"),
    ).toHaveLength(1);
    expect(allFacts(projectLedger(h.input())).some(({ kind }) => kind === "support")).toBe(false);
  });

  it("shows a cleared shot as a provisional unknown target, without erasing the accepted assignment", () => {
    const h = history(ordinaryNight);
    h.append({
      type: "mafia.shots-observed",
      payload: { shotAssignments: {}, observations: [{ shooterSeat: 1, targetSeat: 8 }] },
    });
    const input = h.input();
    const draft = toggleMafiaShot(input.game, 1, 8);
    const row = facts(projectLedger({ ...input, game: draft }), 1, 1);
    expect(
      row
        .filter(({ kind }) => kind === "shot")
        .map(({ values, provisional }) => [values?.seat, provisional === true]),
    ).toEqual([
      [8, false],
      ["?", true],
    ]);
  });

  it("provides complete EN/RU messages whose projected parameters interpolate without raw enums", () => {
    const inputs = [
      { ...sample, privacyHidden: false },
      { frames: sample.frames, game: sample.game, privacyHidden: true },
    ];
    for (const input of inputs)
      for (const fact of allFacts(projectLedger(input))) {
        for (const locale of ["en", "ru"] as const) {
          const template = ledgerHistoryMessages[locale][fact.kind];
          expect(typeof template).toBe("string");
          if (typeof template !== "string") continue;
          const text = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key: string) =>
            String(fact.values?.[key] ?? `{${key}}`),
          );
          expect(text).not.toMatch(/\{[A-Za-z]/);
          expect(text).not.toMatch(/night-|red-carded|citizen|don-check|sheriff-check/);
        }
        expect(
          Object.values(fact.values ?? {}).every(
            (value) => typeof value === "string" || typeof value === "number",
          ),
        ).toBe(true);
      }
    expect(Object.keys(ledgerHistoryMessages.en).sort()).toEqual(
      Object.keys(ledgerHistoryMessages.ru).sort(),
    );
  });
});
