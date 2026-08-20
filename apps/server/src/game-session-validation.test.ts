import { describe, expect, it } from "vitest";
import { gameSessionMutationSchema } from "./game-session-validation.js";

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const clubRoles = [
  "sheriff",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "mafia",
  "mafia",
  "don",
] as const;

const liveGame = (day: number) => ({
  phase: "day" as const,
  day,
  players: clubRoles.map((role, index) => ({
    id: uuid(index + 1),
    name: `Player ${index + 1}`,
    seat: index + 1,
    role,
    team: role === "mafia" || role === "don" ? ("black" as const) : ("red" as const),
    status: "active" as const,
    fouls: 0,
    mutePending: false,
  })),
  turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
  currentTurnIndex: 0,
  nominations: [],
  voteAssignments: {},
  shotAssignments: {},
  winner: null,
});

describe("game session validation", () => {
  it("rejects non-canonical car-crash voter keys", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Aliased car-crash voter",
      mutationId: uuid(98),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...liveGame(1),
          phase: "car-crash-decision",
          carCrashSeats: [4, 6],
          carCrashVotes: { "1": true, "01": true },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map(({ message }) => message)).toContain(
        "Car-crash vote keys must use canonical seat numbers",
      );
    }
  });

  it("rejects car-crash decision votes from non-active seats", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Invalid car-crash voter",
      mutationId: uuid(99),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...liveGame(1),
          phase: "car-crash-decision",
          carCrashSeats: [4, 6],
          carCrashVotes: { "11": true },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map(({ message }) => message)).toContain(
        "Only active players may vote in a car crash decision",
      );
    }
  });

  it("rejects a setup whose visible players do not match the selected roster", () => {
    const roles = [
      "sheriff",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "mafia",
      "mafia",
      "don",
    ] as const;
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Mismatched setup roster",
      mutationId: uuid(99),
      baseRevision: 0,
      state: {
        setup: {
          step: "roles",
          hostPlayerId: uuid(11),
          selectedPlayerIds: Array.from({ length: 10 }, () => ""),
          setup: {
            step: "role-draw",
            players: roles.map((_, index) => ({
              id: uuid(index + 1),
              name: `Player ${index + 1}`,
              seat: index + 1,
            })),
            musicState: "paused",
            roleDeck: roles,
            remainingRoles: roles,
            assignments: {},
          },
        },
        game: null,
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "playlist",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "Setup players must match the selected roster" }),
        ]),
      );
    }
  });

  it("rejects a live snapshot whose role distribution is not Club Mafia", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Invalid roles",
      mutationId: uuid(99),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          phase: "day",
          day: 1,
          players: Array.from({ length: 10 }, (_, index) => ({
            id: uuid(index + 1),
            name: `Player ${index + 1}`,
            seat: index + 1,
            role: "citizen",
            team: "red",
            status: "active",
            fouls: 0,
            mutePending: false,
          })),
          turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
          currentTurnIndex: 0,
          nominations: [],
          voteAssignments: {},
          shotAssignments: {},
          winner: null,
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: "Expected 1 sheriff" })]),
      );
    }
  });

  it("rejects undo history across a day checkpoint or outside the retained log prefix", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Invalid undo checkpoint",
      mutationId: uuid(99),
      baseRevision: 2,
      state: {
        setup: null,
        game: liveGame(2),
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [
          {
            id: uuid(50),
            sequence: 1,
            type: "day.started",
            phase: "day",
            payload: { day: 2 },
            secret: false,
            createdAt: "2026-08-18T10:00:00.000Z",
          },
        ],
        undoHistory: [{ game: liveGame(1), logLength: 2, sequence: 3 }],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "Undo history cannot cross a day checkpoint" }),
          expect.objectContaining({
            message: "Undo snapshot must reference a retained log prefix",
          }),
        ]),
      );
    }
  });

  it("rejects a day snapshot with no legal current turn and phase-inappropriate actions", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Impossible game",
      mutationId: uuid(71),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...liveGame(1),
          turnOrder: [],
          currentTurnIndex: 10,
          nominations: [{ nominatorSeat: 1, candidateSeat: 1, order: 1 }],
          voteAssignments: { "1": 10 },
          shotAssignments: { "1": 10 },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map(({ message }) => message)).toEqual(
        expect.arrayContaining([
          "Day turn order must contain every active player",
          "The current day turn must reference an active player",
          "A player cannot nominate themself",
          "Votes are not valid during the day phase",
          "Night shots are not valid during the day phase",
        ]),
      );
    }
  });

  it("rejects a setup host that differs from the authoritative session host", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Mismatched host",
      mutationId: uuid(72),
      baseRevision: 0,
      state: {
        setup: {
          step: "players",
          hostPlayerId: uuid(12),
          selectedPlayerIds: Array.from({ length: 10 }, () => ""),
          setup: null,
        },
        game: null,
        hostPlayerId: uuid(11),
        hostName: "Host Eleven",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map(({ message }) => message)).toContain(
        "Setup host must match the authoritative session host",
      );
    }
  });

  it("rejects action collections outside the phases that can create them", () => {
    const setupPhase = gameSessionMutationSchema.safeParse({
      name: "Invalid setup actions",
      mutationId: uuid(73),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...liveGame(1),
          phase: "mafia-negotiation",
          day: 0,
          turnOrder: [],
          currentTurnIndex: 0,
          nominations: [{ nominatorSeat: 1, candidateSeat: 2, order: 1 }],
          voteAssignments: { "1": 2 },
          shotAssignments: { "8": 2 },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });
    const votingPhase = gameSessionMutationSchema.safeParse({
      name: "Invalid voting shots",
      mutationId: uuid(74),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...liveGame(1),
          phase: "voting",
          nominations: [{ nominatorSeat: 1, candidateSeat: 2, order: 1 }],
          shotAssignments: { "8": 2 },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(setupPhase.success).toBe(false);
    expect(votingPhase.success).toBe(false);
    if (!setupPhase.success) {
      expect(setupPhase.error.issues.map(({ message }) => message)).toEqual(
        expect.arrayContaining([
          "Nominations are not valid during setup phases",
          "Votes are not valid during setup phases",
          "Night shots are not valid before night",
        ]),
      );
    }
    if (!votingPhase.success) {
      expect(votingPhase.error.issues.map(({ message }) => message)).toContain(
        "Night shots are not valid before night",
      );
    }
  });
});
