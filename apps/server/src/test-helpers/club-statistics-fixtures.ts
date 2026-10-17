import type { ClubStatisticsSource, Role, StatisticsGame } from "@mafia/game-domain";

export const playerIds = Array.from(
  { length: 11 },
  (_, index) => `abcdef00-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
export const tournamentA = "abcdef01-0000-4000-8000-000000000001";
export const tournamentB = "abcdef01-0000-4000-8000-000000000002";
const roles: readonly Role[] = [
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "sheriff",
  "mafia",
  "mafia",
  "don",
];
export const statisticsGame = (
  index: number,
  overrides: Partial<StatisticsGame> = {},
): StatisticsGame => ({
  gameId: `abcdef02-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name: `Game ${index}`,
  revision: 1,
  status: "completed",
  hasCasper: false,
  rosterComplete: true,
  timelineAvailable: true,
  playedAt: new Date(Date.UTC(2026, 0, index)).toISOString(),
  hostPlayerId: playerIds[10]!,
  outcome: "red",
  reason: null,
  tournamentId: null,
  participants: roles.map((role, seat) => ({
    playerId: playerIds[seat]!,
    seat: seat + 1,
    role,
    team: role === "mafia" || role === "don" ? "black" : "red",
    status: seat === 0 ? "red-carded" : seat === 1 ? "eliminated" : "active",
    fouls: seat === 0 ? 4 : 0,
    bestMoveHits: seat === 0 ? 2 : null,
  })),
  ...overrides,
});
export const statisticsSource = (games: readonly StatisticsGame[]): ClubStatisticsSource => ({
  players: playerIds.map((id, index) => ({ id, nickname: `Player ${index + 1}` })),
  games,
  tournaments: [
    { id: tournamentA, name: "Event A" },
    { id: tournamentB, name: "Event B" },
  ],
});
