import { describe, expect, it } from "vitest";
import {
  advanceSetupPhase,
  applyGameEvent,
  assertCanonicalGameEventDraft,
  beginRoleDraw,
  completeCurrentTurn,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createInitialGameBaseline,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  hashGameState,
  isMeaningfulGameEventDraft,
  isSecretGameEventType,
  nominate,
  replayGameLog,
  setNominationSelection,
} from "./index.js";
import type { CanonicalGameEventDraft, GameLogEntry, GameState } from "./index.js";
const day = (): GameState => {
  let setup = beginRoleDraw(
    createSetup(
      Array.from({ length: 10 }, (_, index) => ({ id: `p${index + 1}`, seat: index + 1 })),
    ),
    createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  let game = createGame(completeRoleDraw(setup));
  while (game.phase !== "day") game = advanceSetupPhase(game);
  return game;
};
const selection = (
  nominatorSeat: number,
  candidateSeat: number,
  selected: boolean,
): CanonicalGameEventDraft => ({
  type: "nomination.selection-set",
  payload: { nominatorSeat, candidateSeat, selected },
});
const chain = (initial: GameState, drafts: readonly CanonicalGameEventDraft[]) => {
  const baseline = createInitialGameBaseline(initial);
  const entries: GameLogEntry[] = [];
  let game = initial;
  for (const draft of [{ type: "game.checkpointed", payload: {} } as const, ...drafts]) {
    const accepted = createGameLogEntry({
      before: game,
      draft,
      id: `e${entries.length + 1}`,
      gameId: "nomination-selection",
      sequence: entries.length + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: "2026-10-15T12:00:00Z",
    });
    game = accepted.after;
    entries.push(accepted.entry);
    expect(
      replayGameLog(JSON.parse(JSON.stringify(baseline)), JSON.parse(JSON.stringify(entries))).game,
    ).toEqual(JSON.parse(JSON.stringify(game)));
  }
  return { game, baseline, entries };
};
describe("reversible current nomination selections", () => {
  it("ignores a second new nominee, restores the allowance on removal, and excludes own support", () => {
    const initial = day();
    let game = setNominationSelection(initial, 1, 1, true);
    expect(game.nominations).toEqual([{ nominatorSeat: 1, candidateSeat: 1, order: 1 }]);
    expect(setNominationSelection(game, 1, 1, true)).toBe(game);
    expect(setNominationSelection(game, 1, 8, true)).toBe(game);
    expect(() => applyGameEvent(game, selection(1, 8, true))).toThrow(
      expect.objectContaining({
        code: "duplicate-action",
        message: "Nomination selection must change the actor's relation",
      }),
    );
    game = setNominationSelection(game, 1, 1, false);
    expect(game).toEqual(initial);
    expect(setNominationSelection(game, 1, 1, false)).toBe(game);
    expect(setNominationSelection(game, 1, 8, true).nominations).toEqual([
      { nominatorSeat: 1, candidateSeat: 8, order: 1 },
    ]);
  });
  it("supports every existing target independently of the speaker's one new nomination", () => {
    let game = day();
    for (let actor = 1; actor <= 8; actor += 1) {
      game = setNominationSelection(game, actor, actor, true);
      game = completeCurrentTurn(game);
    }
    for (let target = 1; target <= 8; target += 1)
      game = setNominationSelection(game, 9, target, true);
    game = setNominationSelection(game, 9, 9, true);
    expect(game.nominations).toHaveLength(9);
    expect(
      game.nominations.slice(0, 8).every((entry) => entry.supporterSeats?.join() === "9"),
    ).toBe(true);
    expect(game.nominations[8]).not.toHaveProperty("supporterSeats");
    expect(setNominationSelection(game, 9, 10, true)).toBe(game);
    for (let target = 1; target <= 8; target += 1) {
      const unchanged = game;
      expect(setNominationSelection(game, 9, target, true)).toBe(unchanged);
      game = setNominationSelection(game, 9, target, false);
    }
    expect(game.nominations.every((entry) => !Object.hasOwn(entry, "supporterSeats"))).toBe(true);
    expect(game.voteAssignments).toEqual({});
  });
  it("removes only the actor's relation and leaves previous speakers' surviving supports intact", () => {
    const { game: supported } = chain(day(), [
      selection(1, 7, true),
      selection(2, 7, true),
      selection(2, 8, true),
      selection(3, 7, true),
      selection(3, 8, true),
    ]);
    expect(setNominationSelection(supported, 3, 7, true)).toBe(supported);
    expect(() => applyGameEvent(supported, selection(3, 7, true))).toThrow(/must change/i);
    const removed = setNominationSelection(supported, 3, 7, false);
    expect(removed.nominations[0]).toEqual({
      nominatorSeat: 1,
      candidateSeat: 7,
      order: 1,
      supporterSeats: [2],
    });
    expect(removed.nominations[1]).toEqual(supported.nominations[1]);
    expect(setNominationSelection(removed, 3, 7, false)).toBe(removed);
    expect(() => applyGameEvent(removed, selection(3, 7, false))).toThrow(/must change/i);
    const fourth = completeCurrentTurn(removed);
    expect(setNominationSelection(fourth, 4, 7, false)).toBe(fourth);
    expect(() => setNominationSelection(fourth, 3, 7, false)).toThrow(/current speaker/i);
    expect(() => applyGameEvent(fourth, selection(3, 7, false))).toThrow(/upcoming day speaker/i);
    expect(removed.nominations[0]?.supporterSeats).toEqual([2]);
  });
  it("returns to the original hash when the last observed support is removed", () => {
    const nominated = completeCurrentTurn(nominate(day(), 1, 7));
    const supported = setNominationSelection(nominated, 2, 7, true);
    expect(hashGameState(supported)).not.toBe(hashGameState(nominated));
    const removed = setNominationSelection(supported, 2, 7, false);
    expect(removed.nominations[0]).not.toHaveProperty("supporterSeats");
    expect(hashGameState(removed)).toBe(hashGameState(nominated));
    const selfSupport = applyGameEvent(nominated, selection(7, 7, true));
    expect(selfSupport.nominations[0]?.supporterSeats).toEqual([7]);
  });
  it("normalizes provisional turns exactly like the original canonical nomination", () => {
    const initial = day();
    const old = applyGameEvent(initial, {
      type: "player.nominated",
      payload: { nominatorSeat: 3, candidateSeat: 7 },
    });
    expect(applyGameEvent(initial, selection(3, 7, true))).toEqual(old);
    expect(() => setNominationSelection(initial, 3, 7, true)).toThrow(/current speaker/i);
    expect(() => applyGameEvent(old, selection(1, 7, true))).toThrow(/upcoming day speaker/i);
    expect(isMeaningfulGameEventDraft(selection(3, 7, true))).toBe(true);
    expect(isSecretGameEventType("nomination.selection-set")).toBe(true);
  });
  it("clears current-round relations on rollover without rewriting earlier replay frames", () => {
    const { baseline, entries, game } = chain(day(), [
      selection(1, 7, true),
      selection(2, 7, true),
      { type: "phase.changed", payload: { to: "night-mafia" } },
      { type: "mafia.shots-resolved", payload: { shots: [], result: { kind: "miss" } } },
      { type: "don.check-skipped", payload: {} },
      { type: "sheriff.check-skipped", payload: {} },
      { type: "phase.changed", payload: { to: "day" } },
    ]);
    expect(game.day).toBe(2);
    expect(game.nominations).toEqual([]);
    const replay = replayGameLog(baseline, entries);
    expect(replay.frames[2]?.after.nominations).toEqual([
      { nominatorSeat: 1, candidateSeat: 7, order: 1, supporterSeats: [2] },
    ]);
    const next = applyGameEvent(game, selection(2, 8, true));
    expect(next.nominations).toEqual([{ nominatorSeat: 2, candidateSeat: 8, order: 1 }]);
  });
  it("prunes a removed candidate, renumbers survivors, and retains inactive contributors' attribution", () => {
    const removal = (seat: number): CanonicalGameEventDraft[] => [
      {
        type: "discipline.removal-observed",
        payload: {
          seat,
          stage: "day-discussion",
          rule: "6.2.4",
          reason: "",
          checkInProgress: false,
        },
      },
      { type: "discipline.removals-announced", payload: { seats: [seat] } },
    ];
    const { game } = chain(day(), [
      selection(1, 7, true),
      selection(2, 7, true),
      selection(2, 8, true),
      selection(3, 7, true),
      selection(3, 8, true),
      ...removal(7),
      ...removal(3),
    ]);
    expect(game.nominations).toEqual([
      { nominatorSeat: 2, candidateSeat: 8, order: 1, supporterSeats: [3] },
    ]);
    expect(game.turnOrder[game.currentTurnIndex]).toBe(4);
    expect(() => applyGameEvent(game, selection(3, 8, false))).toThrow();
    expect(() => applyGameEvent(game, selection(4, 7, true))).toThrow(/active player/i);
    expect(setNominationSelection(game, 4, 8, false)).toBe(game);
    expect(game.voteAssignments).toEqual({});
  });
  it("preserves support through tie rounds and the existing late-result removal boundary", () => {
    const assignments = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [index + 1, index < 5 ? 7 : 8]),
    );
    const round = (repeat: boolean): CanonicalGameEventDraft[] => [
      ...[
        { type: "voting.candidate-selected" as const, payload: { candidateSeat: 7 } },
        ...Array.from({ length: 5 }, (_, index) => ({
          type: "vote.recorded" as const,
          payload: { voterSeat: index + 1, candidateSeat: 7 },
        })),
        { type: "voting.candidate-selected" as const, payload: { candidateSeat: 8 } },
      ],
      {
        type: "voting.resolved",
        payload: {
          voteAssignments: assignments,
          result: {
            kind: repeat ? "eliminate-both-vote" : "car-crash",
            seats: [7, 8],
            totals: { 7: 5, 8: 5 },
          },
        },
      },
    ];
    const { game: result } = chain(day(), [
      selection(1, 7, true),
      selection(2, 7, true),
      selection(2, 8, true),
      selection(3, 7, true),
      selection(3, 8, true),
      { type: "phase.changed", payload: { to: "voting" } },
      ...round(false),
      { type: "phase.changed", payload: { to: "voting" } },
      ...round(true),
      {
        type: "car-crash.ballot-resolved",
        payload: {
          votes: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index + 1, false])),
          result: { eliminate: false, seats: [7, 8], yesVotes: 0, eligibleVoters: 10 },
        },
      },
    ]);
    expect(result.phase).toBe("car-crash-result");
    expect(result.nominations[1]?.supporterSeats).toEqual([3]);
    const removal: CanonicalGameEventDraft = {
      type: "discipline.removal-observed",
      payload: {
        seat: 7,
        stage: "after-voting-result",
        rule: "6.2.4",
        reason: "",
        checkInProgress: false,
      },
    };
    const { game } = chain(result, [removal]);
    expect(game.nominations).toEqual([
      { nominatorSeat: 2, candidateSeat: 8, order: 1, supporterSeats: [3] },
    ]);
    expect(game.phase).toBe("car-crash-result");
    expect(game.carCrashResult).toEqual(result.carCrashResult);
    expect(game.ballotCancellationDay).toBe(2);
  });
  it.each([
    { nominatorSeat: 0, candidateSeat: 7, selected: true },
    { nominatorSeat: 11, candidateSeat: 7, selected: true },
    { nominatorSeat: 1.5, candidateSeat: 7, selected: true },
    { nominatorSeat: "1", candidateSeat: 7, selected: true },
    { nominatorSeat: 1, candidateSeat: 0, selected: true },
    { nominatorSeat: 1, candidateSeat: 11, selected: true },
    { nominatorSeat: 1, candidateSeat: 7.5, selected: true },
    { nominatorSeat: 1, candidateSeat: "7", selected: true },
    { nominatorSeat: 1, candidateSeat: 7, selected: 1 },
    { nominatorSeat: 1, candidateSeat: 7, selected: null },
    { nominatorSeat: 1, candidateSeat: 7 },
    { nominatorSeat: 1, candidateSeat: 7, selected: true, supporterSeats: [2] },
  ])("rejects malformed/forged selection payload %j", (payload) => {
    const draft = { type: "nomination.selection-set", payload };
    expect(() => assertCanonicalGameEventDraft(draft)).toThrow();
    expect(() => applyGameEvent(day(), draft as CanonicalGameEventDraft)).toThrow();
  });
  it("rejects inactive targets and actors without changing prior attribution", () => {
    const initial = day();
    const inactiveTarget: GameState = {
      ...initial,
      players: initial.players.map((player) =>
        player.seat === 7 ? { ...player, status: "eliminated" } : player,
      ),
    };
    expect(() => setNominationSelection(inactiveTarget, 1, 7, true)).toThrow(/active player/i);
    expect(() => applyGameEvent(inactiveTarget, selection(1, 7, true))).toThrow();
    const inactiveActor = {
      ...initial,
      players: initial.players.map((player) =>
        player.seat === 1 ? { ...player, status: "eliminated" as const } : player,
      ),
    };
    expect(() => setNominationSelection(inactiveActor, 1, 7, true)).toThrow(
      /active current speaker/i,
    );
    expect(() => applyGameEvent(inactiveActor, selection(1, 7, true))).toThrow();
    expect(() => setNominationSelection(initial, 2, 7, true)).toThrow(/current speaker/i);
    expect(initial.nominations).toEqual([]);
  });
  it.each([
    "voting",
    "car-crash",
    "night-mafia",
    "best-move",
    "finished",
    "draw",
    "cancelled",
  ] as const)("does not reinterpret %s card actions as nominations", (phase) => {
    const initial = { ...day(), phase };
    expect(() => setNominationSelection(initial, 1, 7, true)).toThrow(/during the day/i);
    expect(() => applyGameEvent(initial, selection(1, 7, true))).toThrow();
  });
  it.each(
    [[2, 2], [1], [0], [11], [2.5], ["2"], null, undefined, { seat: 2 }].map((supporterSeats) => ({
      supporterSeats,
    })),
  )("strictly rejects malformed snapshot supporters %j", ({ supporterSeats }) => {
    const initial = day();
    const malformed = {
      ...initial,
      nominations: [{ nominatorSeat: 1, candidateSeat: 7, order: 1, supporterSeats }],
    } as unknown as GameState;
    expect(() => createInitialGameBaseline(malformed)).toThrow();
    expect(() =>
      replayGameLog({ ...createInitialGameBaseline(initial), game: malformed }, []),
    ).toThrow();
  });
  it("preserves current player.nominated meaning, shapes and pinned hashes", () => {
    const { game, entries } = chain(day(), [
      { type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: 7 } },
      { type: "player.nominated", payload: { nominatorSeat: 2, candidateSeat: 8 } },
      { type: "foul.issued", payload: { seat: 4, foulNumber: 1, redCarded: false } },
    ]);
    expect(entries.slice(1).map((entry) => entry.stateHashAfter)).toEqual([
      "sha256:0286104cf8b62e91c761bc4acc5ab8dff5812d2e0ed80471a3f7878d3d6e47b4",
      "sha256:688bc5892bcf02cbe83ddf29f022a43153ace5d2801ce4c4172c843c59b3e3eb",
      "sha256:8dc10b9d3e2407f965333458d56009ce65f78757b328df98697277404eade460",
    ]);
    expect(game.nominations.every((entry) => !Object.hasOwn(entry, "supporterSeats"))).toBe(true);
    expect(() =>
      applyGameEvent(game, {
        type: "player.nominated",
        payload: { nominatorSeat: 3, candidateSeat: 7 },
      }),
    ).toThrow(/already nominated/i);
  });
  it("rejects forged replay attribution, duplicate accepted events, and serialization version relabeling", () => {
    const { baseline, entries } = chain(day(), [selection(1, 7, true), selection(2, 7, true)]);
    const forged = structuredClone(entries);
    forged[2] = {
      ...forged[2]!,
      type: "nomination.selection-set",
      payload: { nominatorSeat: 3, candidateSeat: 7, selected: true },
    };
    expect(() => replayGameLog(baseline, forged)).toThrow(/hash mismatch/i);
    expect(() => replayGameLog(baseline, [...entries, entries[2]!])).toThrow(/duplicate event/i);
    const relabeled = entries.map((entry) => ({
      ...entry,
      replayVersion: 1,
    })) as unknown as GameLogEntry[];
    expect(() => replayGameLog(baseline, relabeled)).toThrow();
  });
  it("retains independent support and correction through canonical JSON replay without losing fouls", () => {
    const initial = day();
    const { game, entries } = chain(initial, [
      { type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: 7 } },
      selection(2, 7, true),
      { type: "foul.issued", payload: { seat: 4, foulNumber: 1, redCarded: false } },
      selection(2, 7, false),
      selection(2, 7, true),
      selection(2, 8, true),
      selection(3, 7, true),
      selection(3, 8, true),
      selection(3, 9, true),
    ]);
    expect(game.nominations).toEqual([
      { nominatorSeat: 1, candidateSeat: 7, order: 1, supporterSeats: [2, 3] },
      { nominatorSeat: 2, candidateSeat: 8, order: 2, supporterSeats: [3] },
      { nominatorSeat: 3, candidateSeat: 9, order: 3 },
    ]);
    expect(game.players.find(({ seat }) => seat === 4)?.fouls).toBe(1);
    expect(game.voteAssignments).toEqual({});
    expect(entries).toHaveLength(10);
    expect(entries[3]?.type).toBe("foul.issued");
    expect(entries.every((entry) => entry.replayVersion === 3)).toBe(true);
    expect(
      applyGameEvent(game, { type: "turn.completed", payload: { seat: 3 } }).nominations,
    ).toEqual(game.nominations);
  });
});
