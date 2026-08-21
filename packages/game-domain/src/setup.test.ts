import { describe, expect, it } from "vitest";
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
