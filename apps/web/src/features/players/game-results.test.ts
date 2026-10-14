import { describe, expect, it } from "vitest";
import {
  beginRoleDraw,
  cancelGame,
  completeRoleDraw,
  confirmDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { buildFinalGameResults } from "./game-results.js";

const createAssignedGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(13));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return createGame(completeRoleDraw(setup));
};

describe("buildFinalGameResults", () => {
  it.each(["red", "black"] as const)(
    "preserves a %s-team adjudication without invented departures",
    (losingTeam) => {
      const game = createAssignedGame();
      const winner = losingTeam === "red" ? "black" : "red";
      const adjudication = {
        losingTeam,
        offenderSeat: game.players.find(({ team }) => team === losingTeam)!.seat,
        rule: "6.3.5",
        reason: "Committee confirmed the referee ruling",
        committeeApproved: true,
      };
      const results = buildFinalGameResults(
        { ...game, phase: "finished", winner, adjudication },
        new Date("2026-10-14T08:00:00.000Z"),
        "host-player-id",
      );
      expect(results).toMatchObject({ outcome: winner, winner, reason: null, adjudication });
      expect(results?.players.map(({ status }) => status)).toEqual(
        game.players.map(({ status }) => status),
      );
    },
  );

  it("retains the deterministic rules-draw basis without requiring a manual reason", () => {
    const results = buildFinalGameResults(
      {
        ...createAssignedGame(),
        phase: "draw",
        winner: null,
        rulesDrawReason: { rule: "6.5.6", completedGameNights: 3, consecutiveUnchangedNights: 3 },
      },
      new Date("2026-10-14T08:00:00.000Z"),
      "host-player-id",
    );
    expect(results).toMatchObject({
      outcome: "draw",
      winner: null,
      reason: "MAFGAME 6.5.6: three consecutive game nights without a departure",
    });
  });

  it("returns null until victory has finalized the game", () => {
    expect(buildFinalGameResults(createAssignedGame(), new Date(), "host-player-id")).toBeNull();
  });

  it("captures every player's role, team, status, fouls, and winner", () => {
    const game = createAssignedGame();
    const finished: GameState = {
      ...game,
      phase: "finished",
      winner: "red",
      bestMove: { playerSeat: 1, selectedSeats: [2, 3, 4], mafiaHits: 2 },
      players: game.players.map((player) =>
        player.seat === 1
          ? { ...player, status: "eliminated", fouls: 2 }
          : player.seat === 2
            ? { ...player, status: "red-carded" }
            : player,
      ),
    };

    const results = buildFinalGameResults(
      finished,
      new Date("2026-08-17T22:00:00.000Z"),
      "00000000-0000-4000-8000-000000000011",
    );
    expect(results).toMatchObject({
      hostPlayerId: "00000000-0000-4000-8000-000000000011",
      outcome: "red",
      winner: "red",
      reason: null,
      playedAt: "2026-08-17T22:00:00.000Z",
    });
    expect(results?.players).toHaveLength(10);
    expect(results?.players[0]).toMatchObject({
      playerId: finished.players[0]!.id,
      seat: 1,
      role: finished.players[0]!.role,
      team:
        finished.players[0]!.role === "mafia" || finished.players[0]!.role === "don"
          ? "black"
          : "red",
      status: "eliminated",
      fouls: 2,
      bestMoveHits: 2,
    });
    expect(results?.players[1]).toMatchObject({ status: "red-carded", bestMoveHits: null });
  });

  it.each([
    ["draw", "Three quiet cycles", confirmDraw],
    ["cancelled", "Venue closed", cancelGame],
  ] as const)(
    "captures a %s terminal record with its canonical reason",
    (outcome, reason, endGame) => {
      const terminal = endGame({ ...createAssignedGame(), day: 1 }, reason);

      expect(
        buildFinalGameResults(
          terminal,
          new Date("2026-08-17T22:00:00.000Z"),
          "00000000-0000-4000-8000-000000000011",
          reason,
        ),
      ).toMatchObject({
        outcome,
        winner: null,
        reason,
        playedAt: "2026-08-17T22:00:00.000Z",
        players: expect.arrayContaining([expect.objectContaining({ seat: 1 })]),
      });
    },
  );

  it("rejects terminal results whose reason is not the canonical event reason", () => {
    expect(
      buildFinalGameResults(
        confirmDraw({ ...createAssignedGame(), day: 1 }, "Three quiet cycles"),
        new Date("2026-08-17T22:00:00.000Z"),
        "00000000-0000-4000-8000-000000000011",
      ),
    ).toBeNull();
  });
});
