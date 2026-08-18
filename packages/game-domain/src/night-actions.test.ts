import { describe, expect, it } from "vitest";
import { advanceSetupPhase, createGame, markPlayerInactive } from "./game.js";
import {
  beginNight,
  completeNight,
  performDonCheck,
  performSheriffCheck,
  recordMafiaShot,
  resolveMafiaShots,
} from "./night-actions.js";
import {
  beginRoleDraw,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "./setup.js";
import type { GameState, PlayerInput, SetupState } from "./types.js";

const players = (): PlayerInput[] =>
  Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));

const completedSetup = (): SetupState => {
  let setup = beginRoleDraw(createSetup(players()), createSeededRandom(71));
  for (let seat = 1; seat <= 10; seat += 1) {
    setup = drawRoleForSeat(setup, seat);
  }
  return completeRoleDraw(setup);
};

const dayOne = (): GameState => advanceSetupPhase(advanceSetupPhase(createGame(completedSetup())));

describe("night actions", () => {
  it("kills only when every active Mafia-aligned shooter selects the same active target", () => {
    let game = beginNight(dayOne());
    const shooters = game.players.filter(({ team }) => team === "black").map(({ seat }) => seat);
    const target = game.players.find(({ team }) => team === "red")!.seat;

    for (const shooter of shooters) {
      game = recordMafiaShot(game, shooter, target);
    }

    const resolution = resolveMafiaShots(game);
    expect(resolution.result).toEqual({ kind: "kill", targetSeat: target });
    expect(resolution.game.players.find(({ seat }) => seat === target)?.status).toBe("eliminated");
    expect(resolution.game.phase).toBe("night-don");
    expect(resolution.secretShots).toHaveLength(3);
    expect(resolution.secretShots.every(({ secret }) => secret)).toBe(true);
  });

  it("records a miss for conflicting shots and rejects missing or duplicate shots", () => {
    let game = beginNight(dayOne());
    const shooters = game.players.filter(({ team }) => team === "black").map(({ seat }) => seat);
    const targets = game.players.filter(({ team }) => team === "red").map(({ seat }) => seat);

    game = recordMafiaShot(game, shooters[0]!, targets[0]!);
    expect(() => recordMafiaShot(game, shooters[0]!, targets[1]!)).toThrow(/already recorded/i);
    expect(() => resolveMafiaShots(game)).toThrow(/every active mafia/i);

    game = recordMafiaShot(game, shooters[1]!, targets[1]!);
    game = recordMafiaShot(game, shooters[2]!, targets[0]!);
    const resolution = resolveMafiaShots(game);

    expect(resolution.result).toEqual({ kind: "miss" });
    expect(resolution.game.players.filter(({ status }) => status === "active")).toHaveLength(10);
  });

  it("rejects non-Mafia shooters and inactive targets", () => {
    const day = dayOne();
    const redSeat = day.players.find(({ team }) => team === "red")!.seat;
    const blackSeat = day.players.find(({ team }) => team === "black")!.seat;
    const inactiveTarget = day.players.find(
      ({ team, seat }) => team === "red" && seat !== redSeat,
    )!.seat;
    const game = beginNight(markPlayerInactive(day, inactiveTarget, "eliminated"));

    expect(() => recordMafiaShot(game, redSeat, blackSeat)).toThrow(/mafia-aligned/i);
    expect(() => recordMafiaShot(game, blackSeat, inactiveTarget)).toThrow(/active target/i);
  });

  it("returns private Don and Sheriff results and advances in order", () => {
    let game = beginNight(dayOne());
    const shooters = game.players.filter(({ team }) => team === "black").map(({ seat }) => seat);
    const citizen = game.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!.seat;
    for (const shooter of shooters) {
      game = recordMafiaShot(game, shooter, citizen);
    }
    game = resolveMafiaShots(game).game;

    const sheriffSeat = game.players.find(({ role }) => role === "sheriff")!.seat;
    const donResult = performDonCheck(game, sheriffSeat);
    expect(donResult.result).toEqual({
      kind: "don-check",
      targetSeat: sheriffSeat,
      match: true,
      secret: true,
    });
    expect(donResult.game.phase).toBe("night-sheriff");

    const mafiaSeat = game.players.find(({ role }) => role === "mafia")!.seat;
    const sheriffResult = performSheriffCheck(donResult.game, mafiaSeat);
    expect(sheriffResult.result).toEqual({
      kind: "sheriff-check",
      targetSeat: mafiaSeat,
      match: true,
      secret: true,
    });
    expect(sheriffResult.game.phase).toBe("night-resolution");

    const nextDay = completeNight(sheriffResult.game);
    expect(nextDay.phase).toBe("day");
    expect(nextDay.day).toBe(2);
    expect(nextDay.turnOrder[0]).toBe(2);
  });
});
