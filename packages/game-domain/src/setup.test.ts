import { describe, expect, it } from "vitest";
import { CASPER_PLAYER_ID, CASPER_SEAT } from "./index.js";
import {
  assignRoleForSeat,
  beginRoleDraw,
  clearRoleForSeat,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  getRoleDrawPreview,
  rerollRoleForSeat,
  roleCounts,
} from "./setup.js";
import type { PlayerInput, Role, SetupState } from "./types.js";
const players = (): PlayerInput[] =>
  Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    seat: index + 1,
  }));
const withCasper = (): PlayerInput[] =>
  players().map((player) =>
    player.seat === CASPER_SEAT ? { id: CASPER_PLAYER_ID, seat: CASPER_SEAT } : player,
  );
describe("setup", () => {
  it("keeps canonical setup identity-only and refuses copied profile names", () => {
    const roster = players().map(({ id, seat }) => ({ id, seat }));
    expect(createSetup(roster).players).toEqual(roster);
    expect(() =>
      createSetup(players().map((player) => ({ ...player, name: "Copied name" }))),
    ).toThrow(/identity-only/i);
  });
  it("requires exactly ten distinct players and seats", () => {
    expect(() => createSetup(players().slice(0, 9))).toThrow(/exactly ten/i);
    const duplicatePlayer = players();
    duplicatePlayer[9] = { ...duplicatePlayer[9]!, id: duplicatePlayer[0]!.id };
    expect(() => createSetup(duplicatePlayer)).toThrow(/distinct players/i);
    const duplicateSeat = players();
    duplicateSeat[9] = { ...duplicateSeat[9]!, seat: duplicateSeat[0]!.seat };
    expect(() => createSetup(duplicateSeat)).toThrow(/distinct seats/i);
  });
  it("reserves the synthetic Casper identity for seat ten", () => {
    const misplaced = players();
    misplaced[0] = { id: "casper", seat: 1 };
    expect(() => createSetup(misplaced)).toThrow(/Casper.*seat 10/i);
    const named = players().map((player) => ({ ...player, name: "Not Casper" }));
    named[9] = { id: "casper", name: "Not Casper", seat: 10 };
    expect(() => createSetup(named)).toThrow(/identity-only/i);
  });
  it("uses the canonical ten-card role deck", () => {
    const setup = createSetup(players());
    expect(roleCounts(setup.remainingRoles)).toEqual({
      sheriff: 1,
      citizen: 6,
      mafia: 2,
      don: 1,
    });
    expect(setup.step).toBe("music");
  });
  it("preassigns Casper a citizen while leaving nine drawable canonical cards", () => {
    const initial = createSetup(withCasper());
    expect(initial.assignments).toEqual({});
    expect(roleCounts(initial.remainingRoles).citizen).toBe(6);
    const first = beginRoleDraw(initial, createSeededRandom(42));
    const second = beginRoleDraw(initial, createSeededRandom(42));
    expect(first).toEqual(second);
    expect(first.assignments).toEqual({ [CASPER_SEAT]: "citizen" });
    expect(first.roleDeck).toHaveLength(10);
    expect(first.remainingRoles).toHaveLength(9);
    expect(roleCounts(first.remainingRoles)).toEqual({ sheriff: 1, citizen: 5, mafia: 2, don: 1 });
    expect(() => drawRoleForSeat(first, CASPER_SEAT)).toThrow(/Casper.*role/i);
    expect(() => rerollRoleForSeat(first, CASPER_SEAT, () => 0)).toThrow(/Casper.*reroll/i);
    expect(() => assignRoleForSeat(first, CASPER_SEAT, "mafia")).toThrow(/Casper.*role/i);
    expect(() => assignRoleForSeat(first, CASPER_SEAT, "citizen")).toThrow(/Casper.*role/i);
    let drawing = first;
    for (let seat = 1; seat < CASPER_SEAT; seat += 1) drawing = drawRoleForSeat(drawing, seat);
    expect(
      roleCounts(
        Object.values(drawing.assignments).filter((role): role is Role => role !== undefined),
      ),
    ).toEqual({
      sheriff: 1,
      citizen: 6,
      mafia: 2,
      don: 1,
    });
    expect(completeRoleDraw(drawing).step).toBe("mafia-planning");
  });
  it("does not reserve a citizen for a real nonvirtual identity at seat ten", () => {
    const humans = players();
    const drawing = beginRoleDraw(createSetup(humans), createSeededRandom(42));
    expect(drawing.assignments).toEqual({});
    expect(drawing.remainingRoles).toHaveLength(10);
    expect(assignRoleForSeat(drawing, 10, "mafia").assignments[10]).toBe("mafia");
  });
  it("rejects forged Casper draw completions even when every role card is accounted for", () => {
    let drawing = beginRoleDraw(createSetup(withCasper()), createSeededRandom(42));
    for (let seat = 1; seat < CASPER_SEAT; seat += 1) drawing = drawRoleForSeat(drawing, seat);
    const mafiaSeat = Number(
      Object.keys(drawing.assignments).find(
        (seat) => drawing.assignments[Number(seat)] === "mafia",
      ),
    );
    const forged = {
      ...drawing,
      assignments: {
        ...drawing.assignments,
        [CASPER_SEAT]: "mafia" as const,
        [mafiaSeat]: "citizen" as const,
      },
    };
    expect(() => completeRoleDraw(forged)).toThrow(/Casper.*citizen/i);
  });
  it("keeps music playback state out of the durable setup", () => {
    const setup = createSetup(players());
    expect(setup).not.toHaveProperty("musicState");
  });
  it("draws one deterministic remaining role per tapped seat", () => {
    const setup = createSetup(players());
    const first = beginRoleDraw(setup, createSeededRandom(42));
    const second = beginRoleDraw(setup, createSeededRandom(42));
    expect(first.roleDeck).toEqual(second.roleDeck);
    const afterSeatOne = drawRoleForSeat(first, 1);
    expect(afterSeatOne.assignments[1]).toBe(first.roleDeck[0]);
    expect(afterSeatOne.remainingRoles).toHaveLength(9);
    expect(() => drawRoleForSeat(afterSeatOne, 1)).toThrow(/already has a role/i);
  });
  it("reveals the seat-bound card out of order without shifting other upcoming roles", () => {
    const drawing = beginRoleDraw(createSetup(players().reverse()), createSeededRandom(42));
    const before = structuredClone(drawing);
    const afterTen = drawRoleForSeat(drawing, 10);
    expect(afterTen.assignments[10]).toBe(drawing.remainingRoles[9]);
    expect(afterTen.remainingRoles).toEqual(drawing.remainingRoles.slice(0, 9));
    const afterFour = drawRoleForSeat(afterTen, 4);
    expect(afterFour.assignments[4]).toBe(drawing.remainingRoles[3]);
    expect(afterFour.remainingRoles).toEqual(
      drawing.remainingRoles.filter((_, index) => index !== 3 && index !== 9),
    );
    expect(afterFour.assignments[10]).toBe(afterTen.assignments[10]);
    expect(drawing).toEqual(before);
  });
  it("reshuffles the tapped role with every undealt card in ascending eligible-seat order", () => {
    let drawing = beginRoleDraw(createSetup(players()), createSeededRandom(42));
    for (const seat of [9, 1, 4]) drawing = drawRoleForSeat(drawing, seat);
    const before = structuredClone(drawing);
    const eligibleRoles = [...drawing.remainingRoles];
    eligibleRoles.splice(2, 0, drawing.assignments[4]!);
    // Fisher-Yates with zero samples rotates all eligible cards one slot left.
    const shuffled = [...eligibleRoles.slice(1), eligibleRoles[0]!];
    let samples = 0;
    const rerolled = rerollRoleForSeat(drawing, 4, () => {
      samples += 1;
      return 0;
    });
    expect(samples).toBe(eligibleRoles.length - 1);
    expect(rerolled.assignments).toEqual({ ...drawing.assignments, 4: shuffled[2] });
    expect(rerolled.remainingRoles).toEqual(shuffled.filter((_, index) => index !== 2));
    expect(rerolled.roleDeck).toEqual(drawing.roleDeck);
    expect(getRoleDrawPreview(rerolled)).toEqual({
      1: drawing.assignments[1],
      9: drawing.assignments[9],
      ...Object.fromEntries(
        [2, 3, 4, 5, 6, 7, 8, 10].map((seat, index) => [seat, shuffled[index]]),
      ),
    });
    expect(
      roleCounts([
        ...rerolled.remainingRoles,
        ...Object.values(rerolled.assignments).filter((role): role is Role => role !== undefined),
      ]),
    ).toEqual({ sheriff: 1, citizen: 6, mafia: 2, don: 1 });
    expect(() => completeRoleDraw(rerolled)).toThrow(/all ten seats/i);
    expect(drawing).toEqual(before);
  });
  it("allows the same tapped role while changing other undealt previews", () => {
    const drawing = drawRoleForSeat(
      beginRoleDraw(createSetup(players()), () => 0.999),
      4,
    );
    const rerolled = rerollRoleForSeat(drawing, 4, () => 0);
    expect(rerolled.assignments).toEqual(drawing.assignments);
    expect(rerolled.assignments[4]).toBe("citizen");
    expect(getRoleDrawPreview(rerolled)[1]).toBe("citizen");
    expect(getRoleDrawPreview(rerolled)[10]).toBe("sheriff");
    expect(rerolled.remainingRoles).not.toEqual(drawing.remainingRoles);
  });
  it("accepts unchanged arrangements and all-identical eligible roles without retrying", () => {
    let drawing = beginRoleDraw(createSetup(players()), () => 0.999);
    drawing = drawRoleForSeat(drawing, 4);
    let samples = 0;
    expect(
      rerollRoleForSeat(drawing, 4, () => {
        samples += 1;
        return 0.999;
      }),
    ).toEqual(drawing);
    expect(samples).toBe(9);
    for (const seat of [1, 8, 9, 10]) drawing = drawRoleForSeat(drawing, seat);
    samples = 0;
    expect(
      rerollRoleForSeat(drawing, 4, () => {
        samples += 1;
        return 0;
      }),
    ).toEqual(drawing);
    expect(samples).toBe(5);
  });
  it("shuffles a single remaining card with the tapped role, then does nothing after the full deal", () => {
    let drawing = beginRoleDraw(createSetup(players()), () => 0.999);
    for (const seat of [9, 2, 7, 4, 5, 6, 3, 8, 1]) drawing = drawRoleForSeat(drawing, seat);
    const before = structuredClone(drawing);
    let samples = 0;
    const rerolled = rerollRoleForSeat(drawing, 1, () => {
      samples += 1;
      return 0;
    });
    expect(samples).toBe(1);
    expect(rerolled.assignments).toEqual({ ...drawing.assignments, 1: "don" });
    expect(rerolled.remainingRoles).toEqual(["sheriff"]);
    const complete = drawRoleForSeat(rerolled, 10);
    expect(complete.assignments[10]).toBe("sheriff");
    expect(
      rerollRoleForSeat(complete, 1, () => {
        samples += 1;
        return 0;
      }),
    ).toBe(complete);
    expect(samples).toBe(1);
    expect(completeRoleDraw(complete).step).toBe("mafia-planning");
    expect(drawing).toEqual(before);
  });
  it("excludes fixed Casper and other dealt seats from a seeded reroll", () => {
    let drawing = beginRoleDraw(createSetup(withCasper()), createSeededRandom(42));
    for (const seat of [8, 3, 6]) drawing = drawRoleForSeat(drawing, seat);
    const first = rerollRoleForSeat(drawing, 6, createSeededRandom(19));
    expect(rerollRoleForSeat(drawing, 6, createSeededRandom(19))).toEqual(first);
    expect(first.assignments).toEqual({ ...drawing.assignments, 6: first.assignments[6] });
    expect(first.assignments[CASPER_SEAT]).toBe("citizen");
    expect(Object.keys(first.assignments)).toHaveLength(4);
    expect(first.remainingRoles).toHaveLength(6);
    const eligibleSeats = [1, 2, 4, 5, 6, 7, 9];
    const preview = getRoleDrawPreview(first);
    expect(roleCounts(eligibleSeats.map((seat) => preview[seat]!))).toEqual(
      roleCounts([...drawing.remainingRoles, drawing.assignments[6]!]),
    );
    for (const seat of [9, 2, 7, 1, 5, 4]) {
      const next = drawRoleForSeat(first, seat);
      expect(next.assignments[seat]).toBe(preview[seat]);
      expect(getRoleDrawPreview(next)).toEqual(preview);
    }
  });
  it("manually assigns only a role card that remains in the deck", () => {
    const drawing = beginRoleDraw(createSetup(players()), createSeededRandom(42));
    const assigned = assignRoleForSeat(drawing, 1, "sheriff");
    expect(assigned.assignments[1]).toBe("sheriff");
    expect(assigned.remainingRoles).toHaveLength(9);
    expect(() => assignRoleForSeat(assigned, 2, "sheriff")).toThrow(/not available/i);
  });
  it("clears and reassigns a full current deal without changing its deck", () => {
    let drawing = beginRoleDraw(createSetup(players()), createSeededRandom(19));
    for (let seat = 1; seat <= 10; seat += 1) drawing = drawRoleForSeat(drawing, seat);
    const before = structuredClone(drawing);
    const role = drawing.assignments[3]!;
    const cleared = clearRoleForSeat(drawing, 3);
    expect(drawing).toEqual(before);
    expect(cleared.assignments[3]).toBeUndefined();
    expect(cleared.remainingRoles).toEqual([role]);
    expect(cleared.roleDeck).toEqual(drawing.roleDeck);
    expect(cleared).not.toHaveProperty("rulesEdition");
    expect(clearRoleForSeat(cleared, 3)).toBe(cleared);
    expect(() => completeRoleDraw(cleared)).toThrow(/all ten seats/i);
    expect(assignRoleForSeat(cleared, 3, role)).toEqual(drawing);
    expect(() => assignRoleForSeat(cleared, 3, role === "don" ? "sheriff" : "don")).toThrow(
      /not available/i,
    );
  });
  it("clears into the seat's sorted pool slot without shifting other pre-rolled cards", () => {
    const initial = beginRoleDraw(createSetup(players()), () => 0.999);
    let drawing = initial;
    for (const seat of [9, 4, 1]) drawing = drawRoleForSeat(drawing, seat);
    const cleared = clearRoleForSeat(drawing, 4);
    expect(cleared.assignments).toEqual({ 1: "sheriff", 9: "mafia" });
    expect(cleared.remainingRoles).toEqual(
      initial.remainingRoles.filter((_, index) => index !== 0 && index !== 8),
    );
    expect(drawRoleForSeat(cleared, 4)).toEqual(drawing);
    expect(clearRoleForSeat(cleared, 4)).toBe(cleared);
  });
  it("exchanges only the target pre-roll and first available requested role on manual choice", () => {
    let drawing = beginRoleDraw(createSetup(players()), () => 0.999);
    drawing = drawRoleForSeat(drawing, 9);
    const chosenDon = assignRoleForSeat(drawing, 1, "don");
    expect(chosenDon.assignments).toEqual({ 1: "don", 9: "mafia" });
    expect(chosenDon.remainingRoles).toEqual([
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "mafia",
      "sheriff",
    ]);
    const assigned = assignRoleForSeat(drawing, 4, "mafia");
    expect(assigned.assignments).toEqual({ 4: "mafia", 9: "mafia" });
    // Seat 8 supplied the first available Mafia; its pre-roll becomes seat 4's Citizen.
    expect(assigned.remainingRoles).toEqual([
      "sheriff",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "don",
    ]);
    const corrected = assignRoleForSeat(assigned, 4, "don");
    expect(corrected.assignments).toEqual({ 4: "don", 9: "mafia" });
    expect(corrected.remainingRoles).toEqual([
      "sheriff",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "mafia",
    ]);
    expect(assignRoleForSeat(corrected, 4, "don")).toEqual(corrected);
    expect(() => assignRoleForSeat(corrected, 2, "don")).toThrow(/not available/i);
  });
  it("only clears real human seats during role draw", () => {
    const initial = createSetup(withCasper());
    const drawing = beginRoleDraw(initial, createSeededRandom(19));
    expect(() => clearRoleForSeat(initial, 1)).toThrow(/during role draw/i);
    expect(() => clearRoleForSeat({ ...drawing, step: "mafia-planning" }, 1)).toThrow(
      /during role draw/i,
    );
    expect(() => clearRoleForSeat(drawing, 0)).toThrow(/does not exist/i);
    expect(() => clearRoleForSeat(drawing, CASPER_SEAT)).toThrow(/Casper/i);
    const partial = drawRoleForSeat(drawing, 1);
    expect(clearRoleForSeat(partial, 1).remainingRoles).toEqual(drawing.remainingRoles);
    expect(clearRoleForSeat(partial, 1).assignments).toEqual({ [CASPER_SEAT]: "citizen" });
  });
  it("projects actual assigned and undealt roles without dealing or consuming randomness", () => {
    let samples = 0;
    const random = createSeededRandom(42);
    let drawing = beginRoleDraw(createSetup(withCasper().reverse()), () => {
      samples += 1;
      return random();
    });
    const before = structuredClone(drawing);
    const preview = getRoleDrawPreview(drawing);
    const expected = Object.fromEntries([
      ...drawing.remainingRoles.map((role, index) => [index + 1, role]),
      [CASPER_SEAT, "citizen"],
    ]);
    expect(preview).toEqual(expected);
    expect(getRoleDrawPreview(drawing)).toEqual(preview);
    expect(samples).toBe(9);
    expect(drawing).toEqual(before);
    expect(Object.keys(drawing.assignments)).toEqual([String(CASPER_SEAT)]);
    expect(() => completeRoleDraw(drawing)).toThrow(/all ten seats/i);
    for (const seat of [8, 3, 9, 1, 6, 2, 7, 4, 5]) {
      drawing = drawRoleForSeat(drawing, seat);
      expect(drawing.assignments[seat]).toBe(preview[seat]);
      expect(getRoleDrawPreview(drawing)).toEqual(preview);
    }
    expect(getRoleDrawPreview(completeRoleDraw(drawing))).toEqual(preview);
    expect(samples).toBe(9);
  });
  it("keeps a human named Casper in the live preview pool", () => {
    const drawing = beginRoleDraw(
      createSetup(
        players().map((player) =>
          player.seat === 10 ? { ...player, id: "human-casper" } : player,
        ),
      ),
      createSeededRandom(42),
    );
    const preview = getRoleDrawPreview(drawing);
    expect(preview[10]).toBe(drawing.remainingRoles[9]);
    expect(drawRoleForSeat(drawing, 10).assignments[10]).toBe(preview[10]);
  });
  it("restores partial JSON snapshots after draw, reroll, clear and manual correction", () => {
    const initial = beginRoleDraw(createSetup(withCasper()), createSeededRandom(42));
    let drawing = initial;
    const restore = (state: SetupState): SetupState => {
      const bytes = JSON.stringify(state);
      const restored = JSON.parse(bytes) as SetupState;
      expect(JSON.stringify(restored)).toBe(bytes);
      expect(Object.keys(restored).sort()).toEqual([
        "assignments",
        "players",
        "remainingRoles",
        "roleDeck",
        "step",
      ]);
      expect(restored).toEqual(state);
      expect(getRoleDrawPreview(restored)).toEqual(getRoleDrawPreview(state));
      expect(drawRoleForSeat(restored, 1)).toEqual(drawRoleForSeat(state, 1));
      expect(restored.roleDeck).toEqual(initial.roleDeck);
      return restored;
    };
    for (const seat of [8, 2, 5]) drawing = restore(drawRoleForSeat(drawing, seat));
    drawing = restore(rerollRoleForSeat(drawing, 5, createSeededRandom(19)));
    drawing = restore(clearRoleForSeat(drawing, 2));
    const available = drawing.remainingRoles.find(
      (role) => role !== getRoleDrawPreview(drawing)[9],
    )!;
    drawing = restore(assignRoleForSeat(drawing, 9, available));
    const preview = getRoleDrawPreview(drawing);
    for (const seat of [7, 3, 6, 1, 4, 2]) {
      drawing = drawRoleForSeat(drawing, seat);
      expect(drawing.assignments[seat]).toBe(preview[seat]);
    }
    const complete = JSON.parse(JSON.stringify(completeRoleDraw(drawing))) as SetupState;
    expect(getRoleDrawPreview(complete)).toEqual(preview);
    expect(complete.roleDeck).toEqual(initial.roleDeck);
  });
  it("projects existing partial-save remaining order without treating the initial deck as a live map", () => {
    const saved: SetupState = JSON.parse(
      JSON.stringify({
        ...beginRoleDraw(createSetup(players()), () => 0.999),
        assignments: { 2: "citizen", 9: "mafia" },
        remainingRoles: [
          "don",
          "citizen",
          "sheriff",
          "citizen",
          "mafia",
          "citizen",
          "citizen",
          "citizen",
        ],
      }),
    ) as SetupState;
    const preview = getRoleDrawPreview(saved);
    expect(preview).toEqual({
      1: "don",
      2: "citizen",
      3: "citizen",
      4: "sheriff",
      5: "citizen",
      6: "mafia",
      7: "citizen",
      8: "citizen",
      9: "mafia",
      10: "citizen",
    });
    let drawing = saved;
    for (const seat of [10, 4, 1]) {
      drawing = drawRoleForSeat(drawing, seat);
      expect(drawing.assignments[seat]).toBe(preview[seat]);
      expect(getRoleDrawPreview(drawing)).toEqual(preview);
    }
    expect(saved.assignments).toEqual({ 2: "citizen", 9: "mafia" });
  });
  it("refuses previews before role drawing starts", () => {
    expect(() => getRoleDrawPreview(createSetup(players()))).toThrow(/not started/i);
  });
  it.each([
    [
      "short initial deck",
      (state: SetupState) => ({ ...state, roleDeck: state.roleDeck.slice(1) }),
    ],
    [
      "wrong initial deck counts",
      (state: SetupState) => ({ ...state, roleDeck: Array<Role>(10).fill("citizen") }),
    ],
    [
      "short remaining pool",
      (state: SetupState) => ({ ...state, remainingRoles: state.remainingRoles.slice(1) }),
    ],
    [
      "wrong live pool counts",
      (state: SetupState) => ({ ...state, remainingRoles: Array<Role>(10).fill("citizen") }),
    ],
    [
      "unknown remaining role",
      (state: SetupState) => ({
        ...state,
        remainingRoles: ["doctor" as Role, ...state.remainingRoles.slice(1)],
      }),
    ],
    [
      "extra assignment seat",
      (state: SetupState) => ({ ...state, assignments: { 11: "citizen" as Role } }),
    ],
    ["undefined assignment", (state: SetupState) => ({ ...state, assignments: { 1: undefined } })],
    [
      "unknown assigned role",
      (state: SetupState) => ({ ...state, assignments: { 1: "doctor" as Role } }),
    ],
    [
      "aliased assignment seat",
      (state: SetupState) => ({ ...state, assignments: { "01": "citizen" as Role } }),
    ],
    [
      "null assignments",
      (state: SetupState) => ({
        ...state,
        assignments: null as unknown as SetupState["assignments"],
      }),
    ],
    [
      "null remaining pool",
      (state: SetupState) => ({ ...state, remainingRoles: null as unknown as Role[] }),
    ],
    [
      "sparse remaining pool",
      (state: SetupState) => {
        const remainingRoles = [...state.remainingRoles];
        delete remainingRoles[0];
        return { ...state, remainingRoles };
      },
    ],
    [
      "invalid seat range",
      (state: SetupState) => ({
        ...state,
        players: state.players.map((player, index) =>
          index === 1 ? { ...player, seat: 0 } : player,
        ),
      }),
    ],
    [
      "duplicate seat",
      (state: SetupState) => ({
        ...state,
        players: state.players.map((player, index) =>
          index === 1 ? { ...player, seat: 1 } : player,
        ),
      }),
    ],
    [
      "duplicate player",
      (state: SetupState) => ({
        ...state,
        players: state.players.map((player, index) =>
          index === 1 ? { ...player, id: "player-1" } : player,
        ),
      }),
    ],
  ])("rejects %s without consuming randomness or repairing the snapshot", (_, corrupt) => {
    const malformed = corrupt(beginRoleDraw(createSetup(players()), createSeededRandom(42)));
    const before = structuredClone(malformed);
    let samples = 0;
    const random = () => {
      samples += 1;
      return 0;
    };
    const setupError = /setup|role|seat|player/i;
    expect(() => getRoleDrawPreview(malformed)).toThrow(setupError);
    expect(() => drawRoleForSeat(malformed, 2)).toThrow(setupError);
    expect(() => rerollRoleForSeat(malformed, 1, random)).toThrow(setupError);
    expect(() => clearRoleForSeat(malformed, 2)).toThrow(setupError);
    expect(() => assignRoleForSeat(malformed, 2, "citizen")).toThrow(setupError);
    expect(() => beginRoleDraw(malformed, random)).toThrow(setupError);
    expect(() => completeRoleDraw(malformed)).toThrow(setupError);
    expect(samples).toBe(0);
    expect(malformed).toEqual(before);
  });
  it("rejects missing or wrong fixed Casper assignments even when the live pool counts are canonical", () => {
    const drawing = beginRoleDraw(createSetup(withCasper()), () => 0.999);
    const missing: SetupState = {
      ...drawing,
      assignments: {},
      remainingRoles: [...drawing.remainingRoles, "citizen"],
    };
    const mafiaIndex = drawing.remainingRoles.indexOf("mafia");
    const wrong: SetupState = {
      ...drawing,
      assignments: { [CASPER_SEAT]: "mafia" },
      remainingRoles: drawing.remainingRoles.map((role, index) =>
        index === mafiaIndex ? "citizen" : role,
      ),
    };
    for (const state of [missing, wrong]) {
      expect(() => getRoleDrawPreview(state)).toThrow(/Casper.*citizen/i);
      expect(() => drawRoleForSeat(state, 1)).toThrow(/Casper.*citizen/i);
      expect(() => clearRoleForSeat(state, 1)).toThrow(/Casper.*citizen/i);
    }
  });
  it("cannot finish role drawing until all ten seats are assigned", () => {
    let drawing = beginRoleDraw(createSetup(players()), createSeededRandom(19));
    drawing = drawRoleForSeat(drawing, 1);
    expect(() => completeRoleDraw(drawing)).toThrow(/all ten seats/i);
    for (let seat = 2; seat <= 10; seat += 1) {
      drawing = drawRoleForSeat(drawing, seat);
    }
    const complete = completeRoleDraw(drawing);
    expect(complete.step).toBe("mafia-planning");
    const assignedRoles = Object.values(complete.assignments).filter(
      (role): role is Role => role !== undefined,
    );
    expect(roleCounts(assignedRoles)).toEqual({
      sheriff: 1,
      citizen: 6,
      mafia: 2,
      don: 1,
    });
  });
});
