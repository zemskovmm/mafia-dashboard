import { describe, expect, it } from "vitest";
import * as domain from "./index.js";
import type { CanonicalGameEventDraft, GameLogEntry, GameState } from "./index.js";

const bestMoveGame = (): GameState => {
  let setup = domain.beginRoleDraw(
    domain.createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, seat: i + 1 }))),
    domain.createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  let game = domain.advanceOpeningPhase(
    domain.advanceOpeningPhase(domain.createGame(domain.completeRoleDraw(setup))),
  );
  const victim = game.players.find((player) => player.team === "red")!.seat;
  game = domain.completeMafiaShots(
    domain.resolveMafiaShots(domain.toggleAllMafiaShotsForTarget(domain.beginNight(game), victim))
      .game,
  );
  if (game.phase === "night-don") game = domain.skipDonCheck(game);
  if (game.phase === "night-sheriff") game = domain.skipSheriffCheck(game);
  return domain.completeNight(game);
};
const targets = (game: GameState) =>
  game.players.filter((player) => player.seat !== game.bestMove!.playerSeat).map((p) => p.seat);
const select = (game: GameState, seats: readonly number[]) =>
  seats.reduce(domain.toggleBestMoveSelection, game);
const recordHistory = (initial: GameState, drafts: readonly CanonicalGameEventDraft[]) => {
  let game = initial;
  const entries: GameLogEntry[] = [];
  const rooted: readonly CanonicalGameEventDraft[] = [
    { type: "game.checkpointed", payload: {} },
    ...drafts,
  ];
  for (const [index, draft] of rooted.entries()) {
    const result = domain.createGameLogEntry({
      gameId: "best-move-selection",
      id: `event-${index + 1}`,
      sequence: index + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: "2026-10-26T10:00:00Z",
      before: game,
      draft,
    });
    game = result.after;
    entries.push(result.entry);
  }
  return { game, entries };
};

describe("Best Move card selection", () => {
  it("toggles distinct other players, permits inactive targets and removal at the limit", () => {
    const initial = bestMoveGame();
    const [a, b, c, d] = targets(initial) as [number, number, number, number];
    const inactive: GameState = {
      ...initial,
      players: initial.players.map((p) => (p.seat === a ? { ...p, status: "eliminated" } : p)),
    };
    const selected = select(inactive, [a, b, c]);
    expect(selected.bestMove).toEqual({
      playerSeat: initial.bestMove!.playerSeat,
      selectedSeats: [a, b, c],
    });
    expect(() => domain.toggleBestMoveSelection(selected, d)).toThrow(/three/);
    const removed = domain.toggleBestMoveSelection(selected, b);
    expect(removed.bestMove?.selectedSeats).toEqual([a, c]);
    expect(domain.toggleBestMoveSelection(removed, d).bestMove?.selectedSeats).toEqual([a, c, d]);
    expect(inactive.bestMove?.selectedSeats).toEqual([]);
  });
  it.each([0, 11, 1.5, NaN])("rejects invalid selection %s", (seat) => {
    expect(() => domain.toggleBestMoveSelection(bestMoveGame(), seat)).toThrow();
  });
  it("rejects the owner's card without recording a selection", () => {
    const game = bestMoveGame();
    expect(() => domain.toggleBestMoveSelection(game, game.bestMove!.playerSeat)).toThrow(/other/);
    expect(game.bestMove?.selectedSeats).toEqual([]);
  });
  it.each(["self", "other"])(
    "explicitly deselects a restored duplicate %s card without rewriting the retained prefix",
    (kind) => {
      const initial = bestMoveGame();
      const [a, b] = targets(initial) as [number, number];
      const seat = kind === "self" ? initial.bestMove!.playerSeat : a;
      const { entries, game } = recordHistory(
        initial,
        [seat, seat, b].map((accepted) => ({
          type: "best-move.number-accepted",
          payload: { seat: accepted },
        })),
      );
      const baseline = domain.createInitialGameBaseline(initial);
      const saved = JSON.stringify(entries);
      const restored = domain.replayGameLog(baseline, JSON.parse(saved)).game;
      expect(restored).toEqual(game);
      expect(restored.bestMove?.selectedSeats).toEqual([seat, seat, b]);
      expect(() => domain.recordBestMove(restored)).toThrow(/distinct other/);
      const { after, entry } = domain.createGameLogEntry({
        before: restored,
        gameId: entries[0]!.gameId,
        id: "explicit-deselection",
        sequence: entries.length + 1,
        parentEventId: entries.at(-1)!.id,
        createdAt: "2026-10-26T10:01:00Z",
        draft: { type: "best-move.selection-toggled", payload: { seat } },
      });
      expect(after.bestMove?.selectedSeats).toEqual([b]);
      expect(after.bestMove).not.toHaveProperty("mafiaHits");
      expect(restored.bestMove?.selectedSeats).toEqual([seat, seat, b]);
      expect(JSON.stringify(entries)).toBe(saved);
      expect(domain.replayGameLog(baseline, [...entries, entry]).game).toEqual(after);
      expect(domain.replayGameLog(baseline, entries).game).toEqual(restored);
      if (kind === "self")
        expect(() => domain.toggleBestMoveSelection(after, seat)).toThrow(/other/);
    },
  );
  it.each([0, 1, 2])("cannot record %i tentative selections", (count) => {
    const game = bestMoveGame();
    const draft = select(game, targets(game).slice(0, count));
    expect(() => domain.recordBestMove(draft)).toThrow(/three/);
    expect(draft.bestMove).not.toHaveProperty("mafiaHits");
    expect(draft.bestMove).not.toHaveProperty("completionReason");
  });
  it("records exactly three selections immediately without an invented observation", () => {
    const initial = bestMoveGame();
    const seats = initial.players
      .filter((p) => p.team === "black")
      .slice(0, 2)
      .map((p) => p.seat);
    seats.push(
      initial.players.find((p) => p.team === "red" && p.seat !== initial.bestMove!.playerSeat)!
        .seat,
    );
    const game = domain.recordBestMove(select(initial, seats));
    expect(game.phase).toBe("night-resolution");
    expect(game.bestMove).toEqual({
      playerSeat: initial.bestMove!.playerSeat,
      selectedSeats: seats,
      completionReason: "complete-list",
      mafiaHits: 2,
    });
    expect(game.bestMoveEnabled).toBe(initial.bestMoveEnabled);
    expect(domain.prepareBestMove(game)).toBe(game);
    expect(domain.completeNight(game).phase).toBe("goodbye-speech");
    for (const action of [domain.recordBestMove, domain.skipBestMove])
      expect(() => action(game)).toThrow(/unfinished/);
    expect(() => domain.toggleBestMoveSelection(game, seats[0]!)).toThrow(/unfinished/);
  });
  it("preserves a real zero-hit recorded list as a result, unlike a skip", () => {
    const initial = bestMoveGame();
    const seats = initial.players
      .filter((p) => p.team === "red" && p.seat !== initial.bestMove!.playerSeat)
      .slice(0, 3)
      .map((p) => p.seat);
    const { entries, game } = recordHistory(initial, [
      ...seats.map((seat) => ({ type: "best-move.selection-toggled", payload: { seat } }) as const),
      { type: "best-move.recorded", payload: {} },
    ]);
    expect(game.bestMove).toMatchObject({ completionReason: "complete-list", mafiaHits: 0 });
    expect(domain.replayGameLog(domain.createInitialGameBaseline(initial), entries).game).toEqual(
      game,
    );
  });
  it.each(["duplicate", "owner", "invalid"])("rejects a forged three-seat %s draft", (kind) => {
    const initial = bestMoveGame();
    const [a, b] = targets(initial) as [number, number];
    const selectedSeats = [
      a,
      b,
      kind === "duplicate" ? a : kind === "owner" ? initial.bestMove!.playerSeat : 11,
    ];
    const game = { ...initial, bestMove: { ...initial.bestMove!, selectedSeats } };
    expect(() => domain.recordBestMove(game)).toThrow();
  });
  it.each([0, 1, 2, 3])(
    "skips %i selections without a result and still permits morning/farewell",
    (count) => {
      const initial = bestMoveGame();
      const game = domain.skipBestMove(select(initial, targets(initial).slice(0, count)));
      expect(game.bestMove).toEqual({
        playerSeat: initial.bestMove!.playerSeat,
        selectedSeats: [],
        completionReason: "declined",
      });
      expect(game.phase).toBe("night-resolution");
      expect(game.bestMoveEnabled).toBe(initial.bestMoveEnabled);
      expect(domain.prepareBestMove(game)).toBe(game);
      const morning = domain.completeNight(game);
      expect(morning.phase).toBe("goodbye-speech");
      expect(morning.bestMove).not.toHaveProperty("mafiaHits");
      expect(domain.completeGoodbyeSpeech(morning).phase).toBe("day");
    },
  );
});

describe("Best Move selection canonical history", () => {
  // Captured by executing the unmodified source from commit 4810d1ebbc69a0a879627dba160bf74147702c60.
  it.each([
    [
      "declined",
      "8a21c2631b2710d036cd656b4d445671cac07a708a87ca0d47a409e00c8a1c99",
      "0fcc24356590f3fb5c54121ec92680841e70979c014731c3e1ec9dfd81b77743",
    ],
    [
      "finished-early",
      "75961e70eaaa290e5555cc6956295f745e1c4e6bf713b3bf25a23966565d44eb",
      "f86c28a08f2e1a9f7b5efd2b044b0a95ddab385454587f2c16094e580a49b401",
    ],
    [
      "interrupted",
      "d5fbc6ec85bc8139297f48b885cb4553f51576877b1b778873438fd085e3cb6e",
      "a7034472ccb7bb72ee5e1621ca33f87d2e42873a5d30f0a58fd39ae9bc005cf5",
    ],
    [
      "time-expired",
      "7b924a77aafc8cc5e0c178065a10a4bdb9bdaef37156322e34efff613ed75ba1",
      "cdda0d46d4ae65053dda555f87b5edd39fce388842abed7cac0f728b9f0176a8",
    ],
    [
      "complete-list",
      "d18bfcb3feab60b67673fa075f27bce60752f8297bd343eb07e8a099a7035be4",
      "73b85320119ff85a187f30d52f85d7d3bae8115ef03857e6afee8e4fd9cb5208",
    ],
  ] as const)(
    "preserves pre-change %s history bytes and hashes, including self/duplicate entries and slips",
    async (reason, finalHash, bytesHash) => {
      const initial = bestMoveGame();
      expect(domain.hashGameState(initial)).toBe(
        "sha256:913497a125c3ddd3226bf28b8edd21752853562fd505bb1b2b5feed2282ea27f",
      );
      const owner = initial.bestMove!.playerSeat;
      const black = initial.players.find((p) => p.team === "black")!.seat;
      const red = initial.players.find((p) => p.team === "red" && p.seat !== owner)!.seat;
      const seats =
        reason === "declined"
          ? []
          : reason === "complete-list"
            ? [owner, owner, black]
            : reason === "time-expired"
              ? [owner, owner]
              : [owner];
      const drafts: CanonicalGameEventDraft[] = seats.map((seat) => ({
        type: "best-move.number-accepted",
        payload: { seat },
      }));
      if (reason === "complete-list")
        drafts.push({
          type: "best-move.slip-corrected",
          payload: { index: 1, seat: black, reason: "Correct transcription" },
        });
      drafts.push({ type: "best-move.finalized", payload: { reason, readbackAcknowledged: true } });
      if (reason === "complete-list")
        drafts.push({
          type: "best-move.slip-corrected",
          payload: { index: 2, seat: red, reason: "Correct final transcription" },
        });
      const { entries, game } = recordHistory(initial, drafts);
      expect(domain.hashGameState(game)).toBe(`sha256:${finalHash}`);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(entries)),
      );
      expect(
        [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      ).toBe(bytesHash);
      const restored = domain.replayGameLog(domain.createInitialGameBaseline(initial), entries);
      expect(restored.game).toEqual(game);
      expect(restored.frames.map(({ after }) => domain.hashGameState(after))).toEqual(
        entries.map(({ stateHashAfter }) => stateHashAfter),
      );
    },
  );
  it.each(["best-move.recorded", "best-move.skipped"] as const)(
    "replays and truncates private %s and tentative selections exactly",
    (type) => {
      const initial = bestMoveGame();
      const seats = targets(initial).slice(0, 3);
      const drafts: CanonicalGameEventDraft[] = [
        ...[...seats, seats[1]!, seats[1]!].map(
          (seat) => ({ type: "best-move.selection-toggled", payload: { seat } }) as const,
        ),
        { type, payload: {} },
      ];
      const { entries, game } = recordHistory(initial, drafts);
      const baseline = domain.createInitialGameBaseline(initial);
      const restored = domain.replayGameLog(
        JSON.parse(JSON.stringify(baseline)),
        JSON.parse(JSON.stringify(entries)),
      );
      expect(restored.game).toEqual(game);
      const draft = domain.replayGameLog(baseline, entries.slice(0, -1)).game;
      expect(draft.bestMove?.selectedSeats).toEqual([seats[0], seats[2], seats[1]]);
      expect(draft.bestMove).not.toHaveProperty("mafiaHits");
      expect(draft.bestMove).not.toHaveProperty("readbackAcknowledged");
      expect(
        domain.replayGameLog(baseline, entries.slice(0, 2)).game.bestMove?.selectedSeats,
      ).toEqual([seats[0]]);
      expect(domain.hashGameState(game)).toBe(entries.at(-1)?.stateHashAfter);
      expect(entries.every((entry) => domain.isSecretGameEventType(entry.type))).toBe(true);
      expect(entries.every((entry) => domain.isMeaningfulGameEventDraft(entry))).toBe(true);
      expect(entries.every((entry) => !domain.isProvisionalInteractionType(entry.type))).toBe(true);
    },
  );
  it.each([
    { type: "best-move.selection-toggled", payload: { seat: 0 } },
    { type: "best-move.selection-toggled", payload: { seat: 2, accepted: true } },
    { type: "best-move.recorded", payload: { readbackAcknowledged: true } },
    { type: "best-move.skipped", payload: { mafiaHits: 0 } },
    { type: "best-move.finalized", payload: { reason: "complete-list" } },
    { type: "best-move.finalized", payload: { reason: "declined", readbackAcknowledged: false } },
  ])("retains exact payload validation for $type", (draft) => {
    expect(() => domain.assertCanonicalGameEventDraft(draft)).toThrow();
  });
  it.each(["duplicate", "owner", "wrong-hits", "skip-hits", "readback-false", "old-cutoff"])(
    "rejects a malformed %s completion without readback",
    (kind) => {
      const initial = bestMoveGame();
      const seats = targets(initial).slice(0, 3);
      const recorded = domain.recordBestMove(select(initial, seats));
      const bestMove =
        kind === "skip-hits"
          ? {
              playerSeat: initial.bestMove!.playerSeat,
              selectedSeats: [],
              completionReason: "declined",
              mafiaHits: 0,
            }
          : {
              ...recorded.bestMove!,
              ...(kind === "duplicate" ? { selectedSeats: [seats[0], seats[0], seats[1]] } : {}),
              ...(kind === "owner"
                ? { selectedSeats: [seats[0], seats[1], initial.bestMove!.playerSeat] }
                : {}),
              ...(kind === "wrong-hits" ? { mafiaHits: 99 } : {}),
              ...(kind === "readback-false" ? { readbackAcknowledged: false } : {}),
              ...(kind === "old-cutoff" ? { completionReason: "time-expired" } : {}),
            };
      expect(() =>
        domain.replayGameLog(
          { replayVersion: 3, game: { ...recorded, bestMove } } as domain.InitialGameBaseline,
          [],
        ),
      ).toThrow();
    },
  );
  it("retains historical declined zero-hit facts with acknowledged readback", () => {
    const initial = bestMoveGame();
    const { entries, game } = recordHistory(initial, [
      { type: "best-move.finalized", payload: { reason: "declined", readbackAcknowledged: true } },
    ]);
    expect(game.bestMove).toMatchObject({
      completionReason: "declined",
      mafiaHits: 0,
      readbackAcknowledged: true,
    });
    expect(domain.replayGameLog(domain.createInitialGameBaseline(initial), entries).game).toEqual(
      game,
    );
  });
});
