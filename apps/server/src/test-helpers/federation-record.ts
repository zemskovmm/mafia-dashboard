import { randomUUID } from "node:crypto";

/** Browser-supplied JSON fixture; storage must not replay or rewrite its history. */
export const federationRecord = (losingTeam: "red" | "black") => {
  const rulesEdition = "mafgame-2026-07-01";
  const hostPlayerId = randomUUID();
  const players = Array.from({ length: 10 }, (_, index) => ({
    id: randomUUID(),
    seat: index + 1,
    role: index === 0 ? "don" : index < 3 ? "mafia" : index === 3 ? "sheriff" : "citizen",
    team: index < 3 ? "black" : "red",
    status: "active",
    fouls: index === 4 ? 2 : 0,
    mutePending: index === 4,
  }));
  const game = {
    rulesEdition,
    phase: "voting",
    day: 4,
    winner: null,
    players,
    turnOrder: [4, 5],
    currentTurnIndex: 0,
    nominations: [{ nominatorSeat: 6, candidateSeat: 4, order: 1 }],
    voteAssignments: { 1: 4, 2: 4 },
    shotAssignments: {},
    completedGameNights: 3,
    sheriffChecksPerformed: 2,
    firstDayDepartureSeats: [],
    actualMultipleShotSeats: [1],
    currentSpeechRestricted: true,
    ballot: {
      orderAnnouncements: 2,
      mention: 2,
      stopped: true,
      selectedCandidateSeat: 5,
      acceptedCandidateSeats: [4],
      reviewedCandidateSeats: [],
      dispute: { candidateSeat: 4, reason: "Recording review pending" },
    },
    bestMove: {
      playerSeat: 7,
      selectedSeats: [1, 1],
      completionReason: "finished-early",
      readbackAcknowledged: true,
      mafiaHits: 1,
    },
  };
  const rootId = randomUUID();
  const event = {
    id: rootId,
    sequence: 1,
    replayVersion: 2,
    rulesEdition,
    type: "game.checkpointed",
    phaseBefore: "voting",
    payload: {},
    parentEventId: null,
    stateHashAfter: "browser-supplied-root-hash",
    createdAt: "2026-10-14T08:00:00.000Z",
  };
  const state = {
    setup: { rulesEdition, step: "mafia-planning", selectedPlayerIds: players.map(({ id }) => id) },
    game,
    hostPlayerId,
    playlistId: "playlist-ref",
    initialGame: { replayVersion: 2, rulesEdition, game },
    events: [event],
    headEventId: rootId,
    resetReturnEventId: null,
    undoHistory: [game],
    undoBudget: 2,
    log: [],
    legacyLog: [],
  };
  const adjudication = {
    losingTeam,
    offenderSeat: losingTeam === "black" ? 1 : 5,
    rule: "6.3.5",
    reason: "Referee ruling: ППК — committee agreement recorded",
    committeeApproved: true,
  };
  const winner = losingTeam === "red" ? "black" : "red";
  const completedGame = { ...game, phase: "finished", winner, adjudication };
  const finalEvent = {
    ...event,
    id: randomUUID(),
    sequence: 2,
    type: "game.adjudicated",
    payload: adjudication,
    parentEventId: rootId,
    stateHashAfter: "browser-supplied-terminal-hash",
    createdAt: "2026-10-14T08:01:00.000Z",
  };
  const completedState = {
    ...state,
    game: completedGame,
    events: [event, finalEvent],
    headEventId: finalEvent.id,
    resetReturnEventId: rootId,
    undoHistory: [game, completedGame],
  };
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
      bestMoveHits: seat === 7 ? 1 : null,
    })),
  };
  return { state, completedState, results, hostPlayerId, players, winner };
};
