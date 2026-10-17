import { randomUUID } from "node:crypto";
import { createCanonicalHistory } from "./canonical-history.js";

/** Generated with the one current engine; transport preserves every canonical byte. */
export const federationRecord = (losingTeam: "red" | "black") => {
  const hostPlayerId = randomUUID();
  const history = createCanonicalHistory(
    randomUUID(),
    hostPlayerId,
    Array.from({ length: 10 }, () => randomUUID()),
  );
  history.append({ type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: 1 } });
  history.append({ type: "player.nominated", payload: { nominatorSeat: 2, candidateSeat: 2 } });
  history.append({ type: "phase.changed", payload: { to: "voting" } });
  const state = history.snapshot();
  const players = state.game.players;
  const adjudication = {
    losingTeam,
    offenderSeat: players.find((player) => player.team === losingTeam)!.seat,
    rule: "6.3.5",
    reason: "Referee ruling: ППК — committee agreement recorded",
    committeeApproved: true,
  };
  history.append({ type: "game.adjudicated", payload: adjudication });
  const winner = losingTeam === "red" ? "black" : "red";
  history.append({ type: "game.completed", payload: { winner } });
  const completedState = history.snapshot();
  const results = {
    hostPlayerId,
    outcome: winner,
    winner,
    reason: null,
    playedAt: "2026-10-14T08:01:00.000Z",
    adjudication,
    players: players.map(({ id, seat, role, team, status, fouls }) => ({
      playerId: id,
      seat,
      role,
      team,
      status,
      fouls,
      bestMoveHits: null,
    })),
  };
  return { state, completedState, results, hostPlayerId, players, winner };
};
