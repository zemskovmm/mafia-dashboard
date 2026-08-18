import { z } from "zod";

const uuidOrEmpty = z.union([z.uuid(), z.literal("")]);
const role = z.enum(["sheriff", "citizen", "mafia", "don"]);
const team = z.enum(["red", "black"]);
const playerStatus = z.enum(["active", "eliminated", "red-carded"]);
const expectedRoleCounts = { sheriff: 1, citizen: 6, mafia: 2, don: 1 } as const;
const gamePhase = z.enum([
  "mafia-negotiation",
  "sheriff-wake",
  "day",
  "voting",
  "night-mafia",
  "night-don",
  "night-sheriff",
  "night-resolution",
  "finished",
]);

const playerInput = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  seat: z.number().int().min(1).max(10),
});

const setupState = z.object({
  step: z.enum(["music", "role-draw", "mafia-negotiation"]),
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
          message: "Setup players must match the selected roster",
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

export const gameStateSchema = z
  .object({
    phase: gamePhase,
    day: z.number().int().min(0),
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
    shotAssignments: z.record(z.string(), z.number().int().min(1).max(10)),
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
        shotAssignments,
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
        if (nomination.nominatorSeat === nomination.candidateSeat) {
          context.addIssue({
            code: "custom",
            path: ["nominations", index, "candidateSeat"],
            message: "A player cannot nominate themself",
          });
        }
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

      const setupPhase = phase === "mafia-negotiation" || phase === "sheriff-wake";
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
        for (const [voterSeatText, candidateSeat] of voteEntries) {
          const voterSeat = Number(voterSeatText);
          if (!activeSeats.has(voterSeat)) {
            context.addIssue({
              code: "custom",
              path: ["voteAssignments", voterSeatText],
              message: "Only active players may vote",
            });
          }
          if (!nominationCandidates.has(candidateSeat)) {
            context.addIssue({
              code: "custom",
              path: ["voteAssignments", voterSeatText],
              message: "Votes must target nominated players",
            });
          }
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
      if (phase === "night-mafia") {
        for (const [shooterSeatText, targetSeat] of shotEntries) {
          const shooterSeat = Number(shooterSeatText);
          const shooter = players.find(({ seat }) => seat === shooterSeat);
          if (shooter?.status !== "active" || shooter.team !== "black") {
            context.addIssue({
              code: "custom",
              path: ["shotAssignments", shooterSeatText],
              message: "Only active Mafia-aligned players may shoot",
            });
          }
          if (!activeSeats.has(targetSeat)) {
            context.addIssue({
              code: "custom",
              path: ["shotAssignments", shooterSeatText],
              message: "Night shots must target active players",
            });
          }
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

export const gameLogEntrySchema = z.object({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  type: durableGameEventTypeSchema,
  phase: z.string().trim().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
  secret: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const gameSessionStateSchema = z
  .object({
    setup: setupSessionStateSchema.nullable(),
    game: gameStateSchema.nullable(),
    hostPlayerId: z.uuid().nullable(),
    hostName: z.string().trim().min(1).max(100).nullable(),
    playlistId: z.string().max(200),
    log: z.array(gameLogEntrySchema),
    undoHistory: z
      .array(
        z.object({
          game: gameStateSchema,
          logLength: z.number().int().min(0),
          sequence: z.number().int().min(0),
        }),
      )
      .max(3),
  })
  .superRefine(({ setup, game, hostPlayerId, hostName, log, undoHistory }, context) => {
    if ((hostPlayerId === null) !== (hostName === null)) {
      context.addIssue({
        code: "custom",
        path: ["hostName"],
        message: "Host ID and name must be stored together",
      });
    }
    if (game !== null && hostPlayerId === null) {
      context.addIssue({
        code: "custom",
        path: ["hostPlayerId"],
        message: "A live game requires its host",
      });
    }
    if (hostPlayerId !== null && game?.players.some(({ id }) => id === hostPlayerId)) {
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
      if (entry.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["log", index, "sequence"],
          message: "Log sequence must be contiguous",
        });
      }
    }
    for (const [index, snapshot] of undoHistory.entries()) {
      if (game === null || snapshot.game.day !== game.day) {
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
  });

export const finalGameResultsSchema = z
  .object({
    hostPlayerId: z.uuid(),
    winner: team,
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
        }),
      )
      .length(10),
  })
  .superRefine(({ hostPlayerId, players }, context) => {
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
  });

export const gameSessionMutationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    mutationId: z.uuid(),
    baseRevision: z.number().int().min(0),
    state: gameSessionStateSchema,
    results: finalGameResultsSchema.nullable(),
  })
  .superRefine(({ state, results }, context) => {
    const finished = state.game?.phase === "finished";
    if (finished !== (results !== null)) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "Final results must exactly match finished state",
      });
      return;
    }
    if (results === null || state.game === null) return;
    if (results.hostPlayerId !== state.hostPlayerId || results.winner !== state.game.winner) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "Results do not match the game snapshot",
      });
    }
    const gamePlayers = new Map(state.game.players.map((player) => [player.id, player]));
    for (const result of results.players) {
      const player = gamePlayers.get(result.playerId);
      if (
        player === undefined ||
        player.seat !== result.seat ||
        player.role !== result.role ||
        player.team !== result.team ||
        player.status !== result.status ||
        player.fouls !== result.fouls
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

export type ValidatedGameSessionMutation = z.infer<typeof gameSessionMutationSchema>;
