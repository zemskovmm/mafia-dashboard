import { describe, expect, it } from "vitest";
import {
  beginRoleDraw,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  roleCounts,
  setMusicState,
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

  it("blocks role drawing until music is actually playing", () => {
    const setup = createSetup(players());

    expect(() => beginRoleDraw(setup, createSeededRandom(7))).toThrow(/music must be playing/i);

    const blocked = setMusicState(setup, "blocked");
    expect(() => beginRoleDraw(blocked, createSeededRandom(7))).toThrow(/music must be playing/i);
  });

  it("draws one deterministic remaining role per tapped seat", () => {
    const playing = setMusicState(createSetup(players()), "playing");
    const first = beginRoleDraw(playing, createSeededRandom(42));
    const second = beginRoleDraw(playing, createSeededRandom(42));

    expect(first.roleDeck).toEqual(second.roleDeck);

    const afterSeatOne = drawRoleForSeat(first, 1);
    expect(afterSeatOne.assignments[1]).toBe(first.roleDeck[0]);
    expect(afterSeatOne.remainingRoles).toHaveLength(9);
    expect(() => drawRoleForSeat(afterSeatOne, 1)).toThrow(/already has a role/i);
  });

  it("cannot finish role drawing until all ten seats are assigned", () => {
    const playing = setMusicState(createSetup(players()), "playing");
    let drawing = beginRoleDraw(playing, createSeededRandom(19));

    drawing = drawRoleForSeat(drawing, 1);
    expect(() => completeRoleDraw(drawing)).toThrow(/all ten seats/i);

    for (let seat = 2; seat <= 10; seat += 1) {
      drawing = drawRoleForSeat(drawing, seat);
    }

    const complete = completeRoleDraw(drawing);
    expect(complete.step).toBe("mafia-negotiation");
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
