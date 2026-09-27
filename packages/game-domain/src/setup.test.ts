import { describe, expect, it } from "vitest";
import { CASPER_NAME, CASPER_PLAYER_ID, CASPER_SEAT } from "./index.js";
import {
  assignRoleForSeat,
  beginRoleDraw,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  rerollRoleForSeat,
  roleCounts,
} from "./setup.js";
import type { PlayerInput, Role } from "./types.js";

const players = (): PlayerInput[] =>
  Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));

const withCasper = (): PlayerInput[] =>
  players().map((player) =>
    player.seat === CASPER_SEAT
      ? { id: CASPER_PLAYER_ID, name: CASPER_NAME, seat: CASPER_SEAT }
      : player,
  );

describe("setup", () => {
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
    misplaced[0] = { id: "casper", name: "Casper", seat: 1 };
    expect(() => createSetup(misplaced)).toThrow(/Casper.*seat 10/i);

    const renamed = players();
    renamed[9] = { id: "casper", name: "Not Casper", seat: 10 };
    expect(() => createSetup(renamed)).toThrow(/Casper.*name/i);
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

  it("does not reserve a citizen for a real player named Casper", () => {
    const humans = players();
    humans[9] = { ...humans[9]!, name: CASPER_NAME };
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

  it("rerolls an assigned seat only from roles that are still available", () => {
    let drawing = beginRoleDraw(createSetup(players()), createSeededRandom(42));
    drawing = drawRoleForSeat(drawing, 1);
    const previousRole = drawing.assignments[1];

    const rerolled = rerollRoleForSeat(drawing, 1, () => 0);
    expect(rerolled.remainingRoles).toHaveLength(9);
    expect(rerolled.remainingRoles).toContain(previousRole);
    expect(
      roleCounts([
        ...rerolled.remainingRoles,
        ...Object.values(rerolled.assignments).filter((role): role is Role => role !== undefined),
      ]),
    ).toEqual({ sheriff: 1, citizen: 6, mafia: 2, don: 1 });

    for (let seat = 2; seat <= 10; seat += 1) drawing = drawRoleForSeat(drawing, seat);
    expect(rerollRoleForSeat(drawing, 1, () => 0)).toBe(drawing);
  });

  it("manually assigns only a role card that remains in the deck", () => {
    const drawing = beginRoleDraw(createSetup(players()), createSeededRandom(42));
    const assigned = assignRoleForSeat(drawing, 1, "sheriff");

    expect(assigned.assignments[1]).toBe("sheriff");
    expect(assigned.remainingRoles).toHaveLength(9);
    expect(() => assignRoleForSeat(assigned, 2, "sheriff")).toThrow(/not available/i);
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
