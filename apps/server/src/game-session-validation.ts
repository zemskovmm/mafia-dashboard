import {
  replayGameLog,
  type GameLogEntry,
  type GameState,
  type InitialGameBaseline,
} from "@mafia/game-domain";
import { z } from "zod";

const uuidOrEmpty = z.union([z.uuid(), z.literal("")]);
const role = z.enum(["sheriff", "citizen", "mafia", "don"]);
const team = z.enum(["red", "black"]);
const playerStatus = z.enum(["active", "eliminated", "red-carded"]);
const expectedRoleCounts = { sheriff: 1, citizen: 6, mafia: 2, don: 1 } as const;
const gamePhase = z.enum([
  "mafia-planning",
  "sheriff-wake",
  "day",
  "voting",
  "voting-cancelled",
  "car-crash",
  "car-crash-decision",
  "car-crash-result",
  "car-crash-skipped",
  "goodbye-speech",
  "best-move",
  "night-mafia",
  "night-mafia-result",
  "night-don",
  "night-don-result",
  "night-sheriff",
  "night-sheriff-result",
  "night-resolution",
  "finished",
  "draw",
  "cancelled",
]);

const playerInput = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  seat: z.number().int().min(1).max(10),
});

const setupState = z.object({
  step: z.enum(["music", "role-draw", "mafia-planning"]),
  players: z.array(playerInput).length(10),
  roleDeck: z.array(role).length(10),
  remainingRoles: z.array(role).max(10),
  assignments: z.record(z.string(), role),
});

export const setupSessionStateSchema = z
  .object({
    step: z.enum(["players", "music", "roles"]),
    hostPlayerId: uuidOrEmpty.optional(),
    selectedPlayerIds: z.array(uuidOrEmpty).length(10),
    setup: setupState.nullable(),
  })
  .superRefine(({ hostPlayerId, selectedPlayerIds, setup }, context) => {
    const selected = selectedPlayerIds.filter((id) => id !== "");
    if (new Set(selected).size !== selected.length) {
      context.addIssue({
        code: "custom",
        path: ["selectedPlayerIds"],
        message: "Players must be unique",
      });
    }
    if (hostPlayerId !== undefined && hostPlayerId !== "" && selected.includes(hostPlayerId)) {
      context.addIssue({
        code: "custom",
        path: ["hostPlayerId"],
        message: "Host cannot occupy a seat",
      });
    }
    if (setup !== null) {
      const visiblePlayers = [...setup.players].sort((left, right) => left.seat - right.seat);
      const visibleIds = visiblePlayers.map(({ id }) => id);
      const visibleSeats = visiblePlayers.map(({ seat }) => seat);
      const visibleSeatSet = new Set(visibleSeats);
      if (
        new Set(visibleIds).size !== visibleIds.length ||
        new Set(visibleSeats).size !== visibleSeats.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["setup", "players"],
          message: "Setup players and seats must be unique",
        });
      }
      if (
        selectedPlayerIds.some((id) => id === "") ||
        visibleIds.some((id, index) => id !== selectedPlayerIds[index])
      ) {
        context.addIssue({
          code: "custom",
          path: ["selectedPlayerIds"],
          message: "Setup players must match the selected players",
        });
      }
      const assignmentEntries = Object.entries(setup.assignments);
      if (
        assignmentEntries.some(([seatText]) => {
          const seat = Number(seatText);
          return String(seat) !== seatText || !visibleSeatSet.has(seat);
        })
      ) {
        context.addIssue({
          code: "custom",
          path: ["setup", "assignments"],
          message: "Role assignment keys must use canonical seated player numbers",
        });
      }
      const countRoles = (roles: readonly string[]) =>
        Object.fromEntries(
          Object.keys(expectedRoleCounts).map((expectedRole) => [
            expectedRole,
            roles.filter((candidate) => candidate === expectedRole).length,
          ]),
        );
      const deckCounts = countRoles(setup.roleDeck);
      const conservedCounts = countRoles([
        ...setup.remainingRoles,
        ...assignmentEntries.map(([, assignedRole]) => assignedRole),
      ]);
      if (
        assignmentEntries.length + setup.remainingRoles.length !== 10 ||
        Object.entries(expectedRoleCounts).some(
          ([expectedRole, count]) =>
            deckCounts[expectedRole] !== count || conservedCounts[expectedRole] !== count,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["setup"],
          message: "Setup roles must conserve the canonical ten-card role deck",
        });
      }
    }
  });

const playerState = playerInput.extend({
  role,
  team,
  status: playerStatus,
  fouls: z.number().int().min(0),
  mutePending: z.boolean(),
});

const gameStateSchema = z
  .object({
    phase: gamePhase,
    day: z.number().int().min(0),
    bestMoveEnabled: z.boolean().optional(),
    cyclesWithoutElimination: z.number().int().min(0).optional(),
    eliminationOccurredThisCycle: z.boolean().optional(),
    players: z.array(playerState).length(10),
    turnOrder: z.array(z.number().int().min(1).max(10)).max(10),
    currentTurnIndex: z.number().int().min(0).max(10),
    nominations: z.array(
      z.object({
        nominatorSeat: z.number().int().min(1).max(10),
        candidateSeat: z.number().int().min(1).max(10),
        order: z.number().int().positive(),
      }),
    ),
    voteAssignments: z.record(z.string(), z.number().int().min(1).max(10)),
    votingCancellation: z
      .discriminatedUnion("reason", [
        z.object({ reason: z.literal("red-card") }),
        z.object({ reason: z.literal("host-skipped") }),
      ])
      .optional(),
    votingRound: z.enum(["initial", "repeat"]).optional(),
    carCrashSeats: z.array(z.number().int().min(1).max(10)).optional(),
    carCrashVotes: z.record(z.string(), z.boolean()).optional(),
    carCrashResult: z
      .object({
        eliminate: z.boolean(),
        seats: z.array(z.number().int().min(1).max(10)),
        yesVotes: z.number().int().min(0),
        eligibleVoters: z.number().int().min(0),
      })
      .optional(),
    goodbyeSeats: z.array(z.number().int().min(1).max(10)).optional(),
    goodbyeNext: z.enum(["day", "night"]).optional(),
    shotAssignments: z.record(z.string(), z.number().int().min(1).max(10)),
    checkResult: z
      .object({
        kind: z.enum(["don-check", "sheriff-check"]),
        targetSeat: z.number().int().min(1).max(10),
        match: z.boolean(),
        secret: z.literal(true),
      })
      .optional(),
    nightResult: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("kill"), targetSeat: z.number().int().min(1).max(10) }),
        z.object({ kind: z.literal("no-effect"), targetSeat: z.number().int().min(1).max(10) }),
        z.object({ kind: z.literal("miss") }),
      ])
      .optional(),
    dayNotice: z.literal("happy").optional(),
    redCardIssuedThisDay: z.boolean().optional(),
    bestMove: z
      .object({
        playerSeat: z.number().int().min(1).max(10),
        selectedSeats: z.array(z.number().int().min(1).max(10)).max(3),
        mafiaHits: z.number().int().min(0).max(3).optional(),
      })
      .optional(),
    winner: team.nullable(),
  })
  .superRefine(
    (
      {
        players,
        turnOrder,
        currentTurnIndex,
        phase,
        day,
        nominations,
        voteAssignments,
        votingCancellation,
        votingRound,
        carCrashSeats = [],
        carCrashVotes = {},
        carCrashResult,
        goodbyeSeats = [],
        shotAssignments,
        checkResult,
        bestMove,
        winner,
      },
      context,
    ) => {
      if (new Set(players.map(({ id }) => id)).size !== players.length) {
        context.addIssue({
          code: "custom",
          path: ["players"],
          message: "Player IDs must be unique",
        });
      }
      if (new Set(players.map(({ seat }) => seat)).size !== players.length) {
        context.addIssue({
          code: "custom",
          path: ["players"],
          message: "Player seats must be unique",
        });
      }
      if (new Set(turnOrder).size !== turnOrder.length) {
        context.addIssue({
          code: "custom",
          path: ["turnOrder"],
          message: "Turn order seats must be unique",
        });
      }
      const playerSeats = new Set(players.map(({ seat }) => seat));
      const activeSeats = new Set(
        players.filter(({ status }) => status === "active").map(({ seat }) => seat),
      );
      if (turnOrder.some((seat) => !playerSeats.has(seat))) {
        context.addIssue({
          code: "custom",
          path: ["turnOrder"],
          message: "Turn order must reference seated players",
        });
      }
      if (currentTurnIndex > turnOrder.length) {
        context.addIssue({
          code: "custom",
          path: ["currentTurnIndex"],
          message: "Current turn index cannot exceed the turn order",
        });
      }
      if (phase === "day") {
        const requestedStart = ((day - 1) % 10) + 1;
        const expectedTurnOrder = Array.from(
          { length: 10 },
          (_, offset) => ((requestedStart - 1 + offset) % 10) + 1,
        ).filter((seat) => activeSeats.has(seat));
        if (
          day < 1 ||
          turnOrder.length !== expectedTurnOrder.length ||
          turnOrder.some((seat, index) => seat !== expectedTurnOrder[index])
        ) {
          context.addIssue({
            code: "custom",
            path: ["turnOrder"],
            message: "Day turn order must contain every active player",
          });
        }
        const currentSeat = turnOrder[currentTurnIndex];
        if (currentSeat === undefined || !activeSeats.has(currentSeat)) {
          context.addIssue({
            code: "custom",
            path: ["currentTurnIndex"],
            message: "The current day turn must reference an active player",
          });
        }
      }

      const nominationNominators = new Set<number>();
      const nominationCandidates = new Set<number>();
      for (const [index, nomination] of nominations.entries()) {
        if (nomination.order !== index + 1) {
          context.addIssue({
            code: "custom",
            path: ["nominations", index, "order"],
            message: "Nomination order must be contiguous",
          });
        }
        if (nominationNominators.has(nomination.nominatorSeat)) {
          context.addIssue({
            code: "custom",
            path: ["nominations", index, "nominatorSeat"],
            message: "A player may nominate only once",
          });
        }
        if (nominationCandidates.has(nomination.candidateSeat)) {
          context.addIssue({
            code: "custom",
            path: ["nominations", index, "candidateSeat"],
            message: "A player may be nominated only once",
          });
        }
        nominationNominators.add(nomination.nominatorSeat);
        nominationCandidates.add(nomination.candidateSeat);
      }

      const setupPhase = phase === "mafia-planning" || phase === "sheriff-wake";
      if (setupPhase && nominations.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["nominations"],
          message: "Nominations are not valid during setup phases",
        });
      }

      const voteEntries = Object.entries(voteAssignments);
      if (setupPhase && voteEntries.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["voteAssignments"],
          message: "Votes are not valid during setup phases",
        });
      }
      if (phase === "day" && voteEntries.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["voteAssignments"],
          message: "Votes are not valid during the day phase",
        });
      }
      if (phase === "voting") {
        const votingOrder = nominations.map(({ candidateSeat }) => candidateSeat);
        if (
          turnOrder.length !== votingOrder.length ||
          turnOrder.some((seat, index) => seat !== votingOrder[index])
        ) {
          context.addIssue({
            code: "custom",
            path: ["turnOrder"],
            message: "Voting order must exactly match nomination order",
          });
        }
        if (currentTurnIndex < 0 || currentTurnIndex >= votingOrder.length) {
          context.addIssue({
            code: "custom",
            path: ["currentTurnIndex"],
            message: "Voting candidate index must reference a nomination",
          });
        }
        const availableCandidates = new Set(votingOrder.slice(0, currentTurnIndex + 1));
        const assignedVoterSeats = new Set<number>();
        for (const [voterSeatText, candidateSeat] of voteEntries) {
          const voterSeat = Number(voterSeatText);
          assignedVoterSeats.add(voterSeat);
          if (String(voterSeat) !== voterSeatText) {
            context.addIssue({
              code: "custom",
              path: ["voteAssignments", voterSeatText],
              message: "Voter keys must use canonical seat numbers",
            });
          }
          if (!activeSeats.has(voterSeat)) {
            context.addIssue({
              code: "custom",
              path: ["voteAssignments", voterSeatText],
              message: "Only active players may vote",
            });
          }
          if (!nominationCandidates.has(candidateSeat) || !availableCandidates.has(candidateSeat)) {
            context.addIssue({
              code: "custom",
              path: ["voteAssignments", voterSeatText],
              message: "Votes must target the current or an earlier nominated player",
            });
          }
        }
        if (
          currentTurnIndex === votingOrder.length - 1 &&
          (assignedVoterSeats.size !== activeSeats.size ||
            [...activeSeats].some((seat) => !assignedVoterSeats.has(seat)))
        ) {
          context.addIssue({
            code: "custom",
            path: ["voteAssignments"],
            message: "The final voting candidate must receive every remaining active vote",
          });
        }
      }

      if ((phase === "voting-cancelled") !== (votingCancellation !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["votingCancellation"],
          message: "A voting cancellation reason must exist only in the cancelled voting phase",
        });
      }

      const carCrashPhase =
        phase === "car-crash" || phase === "car-crash-decision" || phase === "car-crash-result";
      if (carCrashPhase) {
        if (carCrashSeats.length < 2 || new Set(carCrashSeats).size !== carCrashSeats.length) {
          context.addIssue({
            code: "custom",
            path: ["carCrashSeats"],
            message: "A car crash requires at least two unique nominees",
          });
        }
        if (
          carCrashSeats.some((seat) => !activeSeats.has(seat) || !nominationCandidates.has(seat))
        ) {
          context.addIssue({
            code: "custom",
            path: ["carCrashSeats"],
            message: "Car-crash seats must be active nominated players",
          });
        }
        if (votingRound !== "repeat") {
          context.addIssue({
            code: "custom",
            path: ["votingRound"],
            message: "Car-crash phases require the repeat voting round",
          });
        }
        if (voteEntries.length > 0) {
          context.addIssue({
            code: "custom",
            path: ["voteAssignments"],
            message: "Normal votes must be cleared during car-crash phases",
          });
        }
      }
      if (
        phase === "car-crash" &&
        (turnOrder.length !== carCrashSeats.length ||
          turnOrder.some((seat, index) => seat !== carCrashSeats[index]) ||
          currentTurnIndex >= turnOrder.length)
      ) {
        context.addIssue({
          code: "custom",
          path: ["turnOrder"],
          message: "Car-crash turn order must contain the tied nominees",
        });
      }
      if (phase === "car-crash-decision" || phase === "car-crash-result") {
        for (const voterSeatText of Object.keys(carCrashVotes)) {
          const voterSeat = Number(voterSeatText);
          if (String(voterSeat) !== voterSeatText) {
            context.addIssue({
              code: "custom",
              path: ["carCrashVotes", voterSeatText],
              message: "Car-crash vote keys must use canonical seat numbers",
            });
          }
          if (!activeSeats.has(voterSeat)) {
            context.addIssue({
              code: "custom",
              path: ["carCrashVotes", voterSeatText],
              message: "Only active players may vote in a car crash decision",
            });
          }
        }
      }
      if ((phase === "car-crash-result") !== (carCrashResult !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["carCrashResult"],
          message: "A car-crash result must exist only in the result phase",
        });
      }
      if (phase === "car-crash-result" && carCrashResult !== undefined) {
        const voterSeats = Object.keys(carCrashVotes).map(Number);
        const yesVotes = Object.values(carCrashVotes).filter(Boolean).length;
        if (
          voterSeats.length !== activeSeats.size ||
          [...activeSeats].some((seat) => !voterSeats.includes(seat))
        ) {
          context.addIssue({
            code: "custom",
            path: ["carCrashVotes"],
            message: "A reviewed car crash requires every active player's vote",
          });
        }
        if (
          carCrashResult.yesVotes !== yesVotes ||
          carCrashResult.eligibleVoters !== activeSeats.size ||
          carCrashResult.eliminate !== yesVotes > activeSeats.size / 2 ||
          carCrashResult.seats.length !== carCrashSeats.length ||
          carCrashResult.seats.some((seat, index) => seat !== carCrashSeats[index])
        ) {
          context.addIssue({
            code: "custom",
            path: ["carCrashResult"],
            message: "The car-crash result must match its accepted votes and participants",
          });
        }
      }

      const shotEntries = Object.entries(shotAssignments);
      const shotPhase = phase.startsWith("night-") || phase === "finished";
      if (!shotPhase && phase !== "day" && shotEntries.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["shotAssignments"],
          message: "Night shots are not valid before night",
        });
      }
      if (phase === "day" && shotEntries.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["shotAssignments"],
          message: "Night shots are not valid during the day phase",
        });
      }
      if (phase === "night-mafia" || phase === "night-mafia-result") {
        for (const [shooterSeatText, targetSeat] of shotEntries) {
          const shooterSeat = Number(shooterSeatText);
          if (String(shooterSeat) !== shooterSeatText) {
            context.addIssue({
              code: "custom",
              path: ["shotAssignments", shooterSeatText],
              message: "Mafia shooter keys must use canonical seat numbers",
            });
          }
          const shooter = players.find(({ seat }) => seat === shooterSeat);
          if (shooter?.status !== "active" || shooter.team !== "black") {
            context.addIssue({
              code: "custom",
              path: ["shotAssignments", shooterSeatText],
              message: "Only active Mafia-aligned players may shoot",
            });
          }
          if (!playerSeats.has(targetSeat)) {
            context.addIssue({
              code: "custom",
              path: ["shotAssignments", shooterSeatText],
              message: "Night shots must target seated players",
            });
          }
        }
      }
      const expectedCheckKind =
        phase === "night-don-result"
          ? "don-check"
          : phase === "night-sheriff-result"
            ? "sheriff-check"
            : null;
      if (
        expectedCheckKind === null
          ? checkResult !== undefined
          : checkResult?.kind !== expectedCheckKind
      ) {
        context.addIssue({
          code: "custom",
          path: ["checkResult"],
          message: "Check results must exist only in their matching result phase",
        });
      }
      if (phase === "goodbye-speech" && goodbyeSeats.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["goodbyeSeats"],
          message: "A goodbye speech requires at least one player",
        });
      }
      if (phase === "best-move") {
        const actor = players.find(({ seat }) => seat === bestMove?.playerSeat);
        if (
          bestMove === undefined ||
          actor?.status === "active" ||
          new Set(bestMove.selectedSeats).size !== bestMove.selectedSeats.length ||
          bestMove.selectedSeats.includes(bestMove.playerSeat) ||
          bestMove.selectedSeats.some((seat) => !activeSeats.has(seat)) ||
          bestMove.mafiaHits !== undefined
        ) {
          context.addIssue({
            code: "custom",
            path: ["bestMove"],
            message:
              "Best move must belong to the deceased player and select up to three active seats",
          });
        }
      }
      for (const [index, player] of players.entries()) {
        const expectedTeam = player.role === "mafia" || player.role === "don" ? "black" : "red";
        if (player.team !== expectedTeam) {
          context.addIssue({
            code: "custom",
            path: ["players", index, "team"],
            message: "Role and team do not match",
          });
        }
      }
      for (const [expectedRole, count] of Object.entries(expectedRoleCounts)) {
        if (
          players.filter(({ role: playerRole }) => playerRole === expectedRole).length !== count
        ) {
          context.addIssue({
            code: "custom",
            path: ["players"],
            message: `Expected ${count} ${expectedRole}`,
          });
        }
      }
      if ((phase === "finished") !== (winner !== null)) {
        context.addIssue({
          code: "custom",
          path: ["winner"],
          message: "Only a finished game has a winner",
        });
      }
    },
  );

export const durableGameEventTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !value.startsWith("timer.") && !value.startsWith("music."), {
    message: "Timer and music controls are not durable game log events",
  });

const gameLogEntrySchema = z.object({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  type: durableGameEventTypeSchema,
  phase: z.string().trim().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
});

const canonicalSeat = z.number().int().min(1).max(10);
const canonicalSeatKey = z.string().regex(/^(?:[1-9]|10)$/);
const emptyCanonicalPayload = z.object({}).strict();
const voteResultSchema = z
  .object({
    kind: z.enum(["winner", "car-crash", "eliminate-both-vote", "eliminate-all-skipped"]),
    seats: z.array(canonicalSeat),
    totals: z.record(canonicalSeatKey, z.number().int().nonnegative()),
  })
  .strict();
const carCrashVoteResultSchema = z
  .object({
    eliminate: z.boolean(),
    seats: z.array(canonicalSeat),
    yesVotes: z.number().int().nonnegative(),
    eligibleVoters: z.number().int().nonnegative(),
  })
  .strict();
const nightShotResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("kill"), targetSeat: canonicalSeat }).strict(),
  z.object({ kind: z.literal("no-effect"), targetSeat: canonicalSeat }).strict(),
  z.object({ kind: z.literal("miss") }).strict(),
]);
const canonicalEventMetadata = z.object({
  replayVersion: z.literal(1),
  id: z.uuid(),
  gameId: z.uuid(),
  sequence: z.number().int().positive(),
  parentEventId: z.uuid().nullable(),
  phaseBefore: gamePhase,
  phaseAfter: gamePhase,
  dayBefore: z.number().int().min(0),
  dayAfter: z.number().int().min(0),
  stateHashAfter: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  createdAt: z.iso.datetime({ offset: true }),
});
const canonicalGameEventSchema = z.discriminatedUnion("type", [
  canonicalEventMetadata
    .extend({
      type: z.literal("game.started"),
      payload: emptyCanonicalPayload,
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("game.checkpointed"),
      payload: emptyCanonicalPayload,
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("phase.changed"),
      payload: z.object({ to: gamePhase }).strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("turn.completed"),
      payload: z.object({ seat: canonicalSeat }).strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("player.nominated"),
      payload: z.object({ nominatorSeat: canonicalSeat, candidateSeat: canonicalSeat }).strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("foul.issued"),
      payload: z
        .object({
          seat: canonicalSeat,
          foulNumber: z.number().int().positive(),
          redCarded: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("player.red-carded"),
      payload: z.object({ seat: canonicalSeat }).strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("voting.skipped"),
      payload: z.object({ reason: z.literal("host-skipped") }).strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("voting.resolved"),
      payload: z
        .object({
          voteAssignments: z.record(canonicalSeatKey, canonicalSeat),
          result: voteResultSchema,
        })
        .strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("car-crash.resolved"),
      payload: z
        .object({
          votes: z.record(canonicalSeatKey, z.boolean()),
          result: carCrashVoteResultSchema,
        })
        .strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("mafia.shots-resolved"),
      payload: z
        .object({
          shots: z.array(
            z
              .object({
                shooterSeat: canonicalSeat,
                targetSeat: canonicalSeat,
                secret: z.literal(true),
              })
              .strict(),
          ),
          result: nightShotResultSchema,
        })
        .strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("don.checked"),
      payload: z.object({ targetSeat: canonicalSeat, match: z.boolean() }).strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("don.check-skipped"),
      payload: emptyCanonicalPayload,
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("sheriff.checked"),
      payload: z.object({ targetSeat: canonicalSeat, match: z.boolean() }).strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("sheriff.check-skipped"),
      payload: emptyCanonicalPayload,
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("best-move.completed"),
      payload: z
        .object({
          playerSeat: canonicalSeat,
          selectedSeats: z.array(canonicalSeat).max(3),
          mafiaHits: z.number().int().min(0).max(3),
        })
        .strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("game.completed"),
      payload: z.object({ winner: team }).strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("game.drawn"),
      payload: z
        .object({
          reason: z
            .string()
            .min(1)
            .max(500)
            .refine((value) => value === value.trim()),
        })
        .strict(),
    })
    .strict(),
  canonicalEventMetadata
    .extend({
      type: z.literal("game.cancelled"),
      payload: z
        .object({
          reason: z
            .string()
            .min(1)
            .max(500)
            .refine((value) => value === value.trim()),
        })
        .strict(),
    })
    .strict(),
]);

const initialGameBaselineSchema = z.object({
  replayVersion: z.literal(1),
  game: gameStateSchema,
});

interface ReplayableStateInput {
  readonly game: GameState | null;
  readonly initialGame?: InitialGameBaseline | null;
  readonly events?: readonly GameLogEntry[];
  readonly headEventId?: string | null;
}

const deriveReplayState = (state: ReplayableStateInput): GameState | null => {
  if (state.initialGame == null) return state.game;
  if (state.headEventId == null) return state.initialGame.game;
  const byId = new Map((state.events ?? []).map((event) => [event.id, event]));
  const reversed: GameLogEntry[] = [];
  const visited = new Set<string>();
  let currentId: string | null = state.headEventId;
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error("Game history contains a cycle");
    visited.add(currentId);
    const event: GameLogEntry | undefined = byId.get(currentId);
    if (event === undefined) throw new Error("Game history is missing its active parent");
    reversed.push(event);
    currentId = event.parentEventId;
  }
  return replayGameLog(state.initialGame, reversed.reverse()).game;
};

const gameSessionStateSchema = z
  .object({
    setup: setupSessionStateSchema.nullable(),
    game: gameStateSchema.nullable(),
    hostPlayerId: z.uuid().nullable(),
    hostName: z.string().trim().min(1).max(100).nullable(),
    playlistId: z.string().max(200),
    log: z.array(gameLogEntrySchema),
    initialGame: initialGameBaselineSchema.nullable().optional(),
    events: z.array(canonicalGameEventSchema).optional(),
    headEventId: z.uuid().nullable().optional(),
    resetReturnEventId: z.null().optional(),
    legacyLog: z.array(gameLogEntrySchema).optional(),
    undoHistory: z
      .array(
        z.object({
          game: gameStateSchema,
          logLength: z.number().int().min(0),
          sequence: z.number().int().min(0),
        }),
      )
      .max(3),
    undoBudget: z.number().int().min(0).max(3).optional(),
  })
  .superRefine(
    (
      {
        setup,
        game,
        hostPlayerId,
        hostName,
        log,
        undoHistory,
        initialGame,
        events = [],
        headEventId,
      },
      context,
    ) => {
      try {
        deriveReplayState({
          game,
          initialGame: initialGame as InitialGameBaseline | null | undefined,
          events: events as unknown as readonly GameLogEntry[],
          headEventId,
        });
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: ["events"],
          message: error instanceof Error ? error.message : "Game history cannot be replayed",
        });
      }
      const currentGame = game;
      if ((hostPlayerId === null) !== (hostName === null)) {
        context.addIssue({
          code: "custom",
          path: ["hostName"],
          message: "Host ID and name must be stored together",
        });
      }
      if (currentGame !== null && hostPlayerId === null) {
        context.addIssue({
          code: "custom",
          path: ["hostPlayerId"],
          message: "A live game requires its host",
        });
      }
      if (hostPlayerId !== null && currentGame?.players.some(({ id }) => id === hostPlayerId)) {
        context.addIssue({
          code: "custom",
          path: ["hostPlayerId"],
          message: "Host cannot occupy a player seat",
        });
      }
      const setupHostPlayerId = setup?.hostPlayerId === "" ? null : (setup?.hostPlayerId ?? null);
      if (setup !== null && setupHostPlayerId !== hostPlayerId) {
        context.addIssue({
          code: "custom",
          path: ["setup", "hostPlayerId"],
          message: "Setup host must match the authoritative session host",
        });
      }
      if (new Set(log.map(({ id }) => id)).size !== log.length) {
        context.addIssue({ code: "custom", path: ["log"], message: "Log IDs must be unique" });
      }
      for (const [index, entry] of log.entries()) {
        const previous = log[index - 1];
        const invalidSequence =
          events.length === 0
            ? entry.sequence !== index + 1
            : previous !== undefined && entry.sequence <= previous.sequence;
        if (invalidSequence) {
          context.addIssue({
            code: "custom",
            path: ["log", index, "sequence"],
            message:
              events.length === 0
                ? "Log sequence must be contiguous"
                : "Active branch log sequence must be increasing",
          });
        }
      }
      for (const [index, snapshot] of undoHistory.entries()) {
        if (currentGame === null || snapshot.game.day !== currentGame.day) {
          context.addIssue({
            code: "custom",
            path: ["undoHistory", index, "game", "day"],
            message: "Undo history cannot cross a day checkpoint",
          });
        }
        const retainedEntry = snapshot.logLength === 0 ? undefined : log[snapshot.logLength - 1];
        if (
          snapshot.logLength > log.length ||
          snapshot.sequence !== snapshot.logLength ||
          (snapshot.sequence > 0 && retainedEntry?.sequence !== snapshot.sequence)
        ) {
          context.addIssue({
            code: "custom",
            path: ["undoHistory", index],
            message: "Undo snapshot must reference a retained log prefix",
          });
        }
      }
      if (events.length > 0 && (initialGame === undefined || initialGame === null)) {
        context.addIssue({
          code: "custom",
          path: ["initialGame"],
          message: "Incremental events require an initial game baseline",
        });
      }
      if (new Set(events.map(({ id }) => id)).size !== events.length) {
        context.addIssue({ code: "custom", path: ["events"], message: "Event IDs must be unique" });
      }
      if (events.length > 0 && (headEventId === undefined || headEventId === null)) {
        context.addIssue({
          code: "custom",
          path: ["headEventId"],
          message: "Canonical history requires an active head",
        });
      }
      if (
        headEventId !== undefined &&
        headEventId !== null &&
        !events.some(({ id }) => id === headEventId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["headEventId"],
          message: "The active head must reference a stored event",
        });
      }
      if (headEventId !== undefined && headEventId !== null) {
        const byId = new Map(events.map((event) => [event.id, event]));
        const retained = new Set<string>();
        let eventId: string | null = headEventId;
        while (eventId !== null && !retained.has(eventId)) {
          retained.add(eventId);
          eventId = byId.get(eventId)?.parentEventId ?? null;
        }
        if (retained.size !== events.length) {
          context.addIssue({
            code: "custom",
            path: ["events"],
            message: "Canonical history must contain only the retained active prefix",
          });
        }
      }
    },
  );

const finalGameResultsSchema = z
  .object({
    hostPlayerId: z.uuid(),
    outcome: z.enum(["red", "black", "draw", "cancelled"]).optional(),
    winner: team.nullable(),
    reason: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => value === value.trim(), "Reason must be trimmed")
      .nullable()
      .optional(),
    playedAt: z.iso.datetime({ offset: true }),
    players: z
      .array(
        z.object({
          playerId: z.uuid(),
          seat: z.number().int().min(1).max(10),
          role,
          team,
          status: playerStatus,
          fouls: z.number().int().min(0),
          bestMoveHits: z.number().int().min(0).max(3).nullable().optional(),
        }),
      )
      .length(10),
  })
  .superRefine(({ hostPlayerId, outcome, winner, reason, players }, context) => {
    const resolvedOutcome = outcome ?? winner;
    if (resolvedOutcome === null) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "A completion outcome is required",
      });
    } else if (resolvedOutcome === "red" || resolvedOutcome === "black") {
      if (winner !== resolvedOutcome || (reason !== undefined && reason !== null)) {
        context.addIssue({
          code: "custom",
          path: ["winner"],
          message: "A winning completion must match its winner and have no ruling reason",
        });
      }
    } else if (winner !== null || reason === undefined || reason === null) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A draw or cancellation requires a reason and cannot have a winner",
      });
    }
    if (players.some(({ playerId }) => playerId === hostPlayerId)) {
      context.addIssue({
        code: "custom",
        path: ["hostPlayerId"],
        message: "Host cannot occupy a player seat",
      });
    }
    if (new Set(players.map(({ playerId }) => playerId)).size !== players.length) {
      context.addIssue({ code: "custom", path: ["players"], message: "Player IDs must be unique" });
    }
    if (new Set(players.map(({ seat }) => seat)).size !== players.length) {
      context.addIssue({
        code: "custom",
        path: ["players"],
        message: "Player seats must be unique",
      });
    }
    for (const [expectedRole, count] of Object.entries(expectedRoleCounts)) {
      if (players.filter(({ role: playerRole }) => playerRole === expectedRole).length !== count) {
        context.addIssue({
          code: "custom",
          path: ["players"],
          message: `Expected ${count} ${expectedRole}`,
        });
      }
    }
    for (const [index, player] of players.entries()) {
      const expectedTeam = player.role === "mafia" || player.role === "don" ? "black" : "red";
      if (player.team !== expectedTeam) {
        context.addIssue({
          code: "custom",
          path: ["players", index, "team"],
          message: "Role and team do not match",
        });
      }
    }
  })
  .transform(({ outcome, winner, reason, ...results }) => ({
    ...results,
    outcome: outcome ?? winner!,
    winner,
    reason: reason ?? null,
  }));

const sessionOperationBase = {
  mutationId: z.uuid(),
  baseRevision: z.number().int().nonnegative(),
} as const;

export const gameSessionNormalizeMutationSchema = z.object(sessionOperationBase).strict();

export const gameSessionStartMutationSchema = z
  .object({
    ...sessionOperationBase,
    initialGame: initialGameBaselineSchema,
    event: canonicalGameEventSchema,
  })
  .strict()
  .superRefine(({ initialGame, event }, context) => {
    if (event.type !== "game.started" && event.type !== "game.checkpointed") {
      context.addIssue({
        code: "custom",
        path: ["event", "type"],
        message: "A session start requires a game.started event",
      });
      return;
    }
    if (event.sequence !== 1 || event.parentEventId !== null) {
      context.addIssue({
        code: "custom",
        path: ["event"],
        message: "game.started must be replay sequence 1 with no parent",
      });
      return;
    }
    try {
      replayGameLog(initialGame as InitialGameBaseline, [event as unknown as GameLogEntry]);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["event"],
        message: error instanceof Error ? error.message : "The start event cannot be replayed",
      });
    }
  });

export const gameSessionEventMutationSchema = z
  .object({
    ...sessionOperationBase,
    event: canonicalGameEventSchema,
  })
  .strict()
  .superRefine(({ event }, context) => {
    if (event.type === "game.started" || event.sequence < 2 || event.parentEventId === null) {
      context.addIssue({
        code: "custom",
        path: ["event"],
        message: "An appended event must be a non-root canonical replay entry",
      });
    }
  });

export const gameSessionHeadMutationSchema = z
  .object({
    ...sessionOperationBase,
    targetEventId: z.uuid(),
    reason: z.enum(["undo", "reset", "restore-reset"]),
  })
  .strict();

export const gameSessionCompleteMutationSchema = z
  .object({
    ...sessionOperationBase,
    results: finalGameResultsSchema,
  })
  .strict();

export const gameSessionMutationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    mutationId: z.uuid(),
    baseRevision: z.number().int().min(0).optional(),
    state: gameSessionStateSchema,
    results: finalGameResultsSchema.nullable(),
  })
  .superRefine(({ state, results }, context) => {
    const currentGame = state.game;
    const terminal =
      currentGame?.phase === "finished" ||
      currentGame?.phase === "draw" ||
      currentGame?.phase === "cancelled";
    if (results !== null && !terminal) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "Final results require a terminal game",
      });
      return;
    }
    if (results === null || currentGame === null) return;
    const expectedOutcome =
      currentGame.phase === "finished" ? currentGame.winner : currentGame.phase;
    if (
      results.hostPlayerId !== state.hostPlayerId ||
      results.outcome !== expectedOutcome ||
      results.winner !== currentGame.winner
    ) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "Results do not match the game snapshot",
      });
    }
    const headEvent = state.events?.find(({ id }) => id === state.headEventId);
    const terminalHead =
      headEvent?.type === "game.completed" ||
      headEvent?.type === "game.drawn" ||
      headEvent?.type === "game.cancelled";
    if (results.outcome === "draw" || results.outcome === "cancelled" || terminalHead) {
      const expectedType =
        results.outcome === "red" || results.outcome === "black"
          ? "game.completed"
          : results.outcome === "draw"
            ? "game.drawn"
            : "game.cancelled";
      const headReason =
        headEvent?.type === "game.drawn" || headEvent?.type === "game.cancelled"
          ? headEvent.payload.reason
          : null;
      if (
        headEvent?.type !== expectedType ||
        headEvent?.createdAt !== results.playedAt ||
        headReason !== results.reason
      ) {
        context.addIssue({
          code: "custom",
          path: ["results"],
          message: "Results must match the canonical terminal event",
        });
      }
    }
    const gamePlayers = new Map(currentGame.players.map((player) => [player.id, player]));
    for (const result of results.players) {
      const player = gamePlayers.get(result.playerId);
      if (
        player === undefined ||
        player.seat !== result.seat ||
        player.role !== result.role ||
        player.team !== result.team ||
        player.status !== result.status ||
        player.fouls !== result.fouls ||
        (result.bestMoveHits ?? null) !==
          (currentGame.bestMove?.playerSeat === player.seat
            ? (currentGame.bestMove.mafiaHits ?? null)
            : null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["results", "players"],
          message: "Results players do not match the game snapshot",
        });
        break;
      }
    }
  });
