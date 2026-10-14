import type {
  ReplayFrame,
  BestMoveCompletionReason,
  LegalVotingSkipReason,
  RemovalOccurrenceStage,
  RemovalObservation,
  Team,
} from "@mafia/game-domain";
import type { TimelineConsoleMessageKey } from "../../i18n/messages/timeline-console.js";
import type { MarkerDescription, TimelineText } from "./timeline-model.js";

const bestMoveEndings = {
  "complete-list": "Best Move complete list",
  interrupted: "Best Move interrupted",
  "time-expired": "Best Move time expired",
  declined: "Best Move declined",
  "finished-early": "Best Move finished early",
} as const satisfies Record<BestMoveCompletionReason, TimelineConsoleMessageKey>;

const skipBases = {
  "no-nominees": "Skip basis no nominees",
  "zero-round-sole-nominee": "Skip basis zero round sole nominee",
  "all-active": "Skip basis all active",
  "nine-three-restricted": "Skip basis nine three restricted",
  "zero-round-five": "Skip basis zero round five",
  "disciplinary-cancellation": "Voting cancelled: disciplinary removal",
} as const satisfies Record<LegalVotingSkipReason, TimelineConsoleMessageKey>;

const removalStages = {
  agreement: "Removal stage agreement",
  "before-shooting-count": "Removal stage before shooting count",
  "shooting-count": "Removal stage shooting count",
  "don-check": "Removal stage don check",
  "sheriff-check": "Removal stage sheriff check",
  "day-discussion": "Removal stage day discussion",
  "open-voting": "Removal stage open voting",
  "after-voting-result": "Removal stage after voting result",
  farewell: "Removal stage farewell",
} as const satisfies Record<RemovalOccurrenceStage, TimelineConsoleMessageKey>;

const messageFor = <Key extends string>(
  keys: Readonly<Record<Key, TimelineConsoleMessageKey>>,
  value: unknown,
): TimelineConsoleMessageKey | null =>
  typeof value === "string" && Object.hasOwn(keys, value) ? keys[value as Key] : null;

export const describeFederationEvent = (
  frame: ReplayFrame,
  text: TimelineText,
  player: (seat: unknown) => string,
): MarkerDescription | null => {
  const payload = frame.entry.payload as Readonly<Record<string, unknown>>;
  const bestMove = frame.after.bestMove;
  const named = (
    kind: MarkerDescription["kind"],
    icon: string,
    label: string,
    reason?: unknown,
  ): MarkerDescription => ({
    kind,
    icon,
    label,
    ariaLabel:
      typeof reason === "string"
        ? `${label}; ${text.t("Decision reason: {reason}", { reason })}`
        : label,
  });
  const adjudication = frame.after.adjudication;
  const teamName = (team: Team): string =>
    text.t(team === "red" ? "History red team" : "History black team");
  if (
    (frame.entry.type === "game.adjudicated" || frame.entry.type === "game.completed") &&
    adjudication !== undefined
  ) {
    const label = text.t("Adjudicated win: {team}", {
      team: teamName(adjudication.losingTeam === "red" ? "black" : "red"),
    });
    const details = [
      label,
      text.t("Adjudication losing team: {team}", { team: teamName(adjudication.losingTeam) }),
      ...(adjudication.offenderSeat === undefined
        ? []
        : [
            text.t("Adjudication offender: {player}", {
              player: player(adjudication.offenderSeat),
            }),
          ]),
      text.t("Rule {rule}", { rule: adjudication.rule }),
      text.t("Decision reason: {reason}", { reason: adjudication.reason }),
      text.t(
        adjudication.committeeApproved ? "Committee approved" : "Committee approval not recorded",
      ),
    ];
    return { kind: "completion", icon: "trophy", label, ariaLabel: details.join("; ") };
  }
  if (
    frame.entry.type === "phase.changed" &&
    frame.after.phase === "draw" &&
    frame.after.rulesDrawReason !== undefined
  ) {
    const basis = frame.after.rulesDrawReason;
    return {
      kind: "completion",
      icon: "trophy",
      label: text.t("Rules draw · 6.5.6"),
      ariaLabel: text.t(
        "Automatic draw under rule 6.5.6: {unchanged} consecutive game nights with no change to table composition; {completed} game nights completed",
        { unchanged: basis.consecutiveUnchangedNights, completed: basis.completedGameNights },
      ),
    };
  }
  switch (frame.entry.type) {
    case "mafia.multiple-shot-observed":
      if (!Number.isInteger(payload.shooterSeat)) return null;
      return named(
        "mafia-shots",
        "crosshair",
        text.t("Actual multiple shot observed: {player}", { player: player(payload.shooterSeat) }),
      );
    case "discipline.removal-observed":
    case "discipline.foul-issued": {
      const observation = (
        frame.entry.type === "discipline.removal-observed" ? payload : payload.removal
      ) as RemovalObservation | undefined;
      if (
        observation == null ||
        !Number.isInteger(observation.seat) ||
        typeof observation.reason !== "string" ||
        typeof observation.rule !== "string"
      )
        return null;
      const key = messageFor(removalStages, observation.stage);
      if (key === null) return null;
      const label = text.t(
        frame.entry.type === "discipline.foul-issued"
          ? "Fourth Foul: {player}; removal recorded during {stage}"
          : "Removal recorded for {player} during {stage}",
        {
          player: player(observation.seat),
          stage: text.t(key),
        },
      );
      const status = frame.after.disciplinaryRemovals?.find(
        ({ seat }) => seat === observation.seat,
      );
      const details = [
        label,
        text.t("Rule {rule}", { rule: observation.rule }),
        text.t("Decision reason: {reason}", { reason: observation.reason }),
      ];
      if (status !== undefined) {
        details.push(
          text.t("Removal status: departure: {departure}; announcement: {announcement}", {
            departure: text.t(
              status.departure === "pending" ? "Removal pending" : "Removal departed",
            ),
            announcement: text.t(
              status.announcement === "pending" ? "Removal pending" : "Removal announced",
            ),
          }),
        );
        if (status.checkCompletionPending) details.push(text.t("Check completion pending"));
      }
      return { kind: "discipline", icon: "badge-x", label, ariaLabel: details.join("; ") };
    }
    case "discipline.removals-announced":
      if (!Array.isArray(payload.seats) || !payload.seats.every(Number.isInteger)) return null;
      return named(
        "red-card",
        "badge-x",
        text.t("Removal announced: {players}", {
          players: text.formatList(payload.seats.map(player)),
        }),
      );
    case "voting.order-announced":
      if (frame.after.ballot === undefined) return null;
      return named(
        "voting-call",
        "vote",
        text.t("Voting order announced {number}/2: {players}", {
          number: frame.after.ballot.orderAnnouncements,
          players: text.formatList(
            frame.before.nominations.map(({ candidateSeat }) => player(candidateSeat)),
          ),
        }),
      );
    case "voting.candidate-mentioned":
      if (!Number.isInteger(payload.candidateSeat) || frame.after.ballot === undefined) return null;
      return named(
        "voting-call",
        "vote",
        text.t("Live call {number}/2: {player}", {
          number: frame.after.ballot.mention,
          player: player(payload.candidateSeat),
        }),
      );
    case "voting.candidate-selected":
      if (!Number.isInteger(payload.candidateSeat)) return null;
      return named(
        "voting-call",
        "vote",
        text.t("Candidate selected: {player}", {
          player: player(payload.candidateSeat),
        }),
      );
    case "vote.recorded":
      if (
        !Number.isInteger(payload.voterSeat) ||
        (payload.candidateSeat !== null && !Number.isInteger(payload.candidateSeat))
      )
        return null;
      return named(
        "vote-correction",
        "vote",
        payload.candidateSeat === null
          ? text.t("Recorded vote cleared: {voter}", { voter: player(payload.voterSeat) })
          : text.t("Vote recorded: {voter} → {candidate}", {
              voter: player(payload.voterSeat),
              candidate: player(payload.candidateSeat),
            }),
      );
    case "voting.candidate-inspected":
      if (!Number.isInteger(payload.candidateSeat)) return null;
      return named(
        "voting-call",
        "vote",
        text.t("Candidate inspected: {player}; live call remains {live}", {
          player: player(payload.candidateSeat),
          live: player(frame.before.turnOrder[frame.before.currentTurnIndex]),
        }),
      );
    case "voting.candidate-stopped":
      if (!Number.isInteger(payload.candidateSeat)) return null;
      return named(
        "voting-call",
        "vote",
        text.t("STOP: {player}", { player: player(payload.candidateSeat) }),
      );
    case "voting.live-advanced":
      if (!Number.isInteger(payload.candidateSeat)) return null;
      return named(
        "voting-call",
        "vote",
        text.t("Next live candidate: {player}", { player: player(payload.candidateSeat) }),
      );
    case "vote.accepted":
      if (!Number.isInteger(payload.voterSeat) || !Number.isInteger(payload.candidateSeat))
        return null;
      return named(
        "vote",
        "vote",
        text.t("Vote accepted: {voter} → {candidate}", {
          voter: player(payload.voterSeat),
          candidate: player(payload.candidateSeat),
        }),
      );
    case "vote.corrected": {
      if (
        !Number.isInteger(payload.voterSeat) ||
        (payload.candidateSeat !== null && !Number.isInteger(payload.candidateSeat)) ||
        typeof payload.reason !== "string"
      )
        return null;
      const label =
        payload.candidateSeat === null
          ? text.t("Vote correction: {voter} unassigned", { voter: player(payload.voterSeat) })
          : text.t("Vote correction: {voter} → {candidate}", {
              voter: player(payload.voterSeat),
              candidate: player(payload.candidateSeat),
            });
      return named("vote-correction", "vote", label, payload.reason);
    }
    case "voting.count-disputed":
      if (!Number.isInteger(payload.candidateSeat) || typeof payload.reason !== "string")
        return null;
      return named(
        "voting-dispute",
        "vote",
        text.t("Voting paused: count disputed for {player}", {
          player: player(payload.candidateSeat),
        }),
        payload.reason,
      );
    case "voting.count-ruled": {
      if (
        frame.after.ballot?.finalRuling === undefined ||
        payload.externalReviewAcknowledged !== true ||
        typeof payload.reason !== "string"
      )
        return null;
      const label = text.t("Final count for {player} after acknowledged external review", {
        player: player(frame.after.ballot.finalRuling.candidateSeat),
      });
      const totals = new Map<number, number>();
      for (const candidate of Object.values(frame.after.voteAssignments)) {
        if (candidate !== undefined) totals.set(candidate, (totals.get(candidate) ?? 0) + 1);
      }
      const counts = text.formatList(
        frame.after.nominations.map(
          ({ candidateSeat }) =>
            `${player(candidateSeat)}: ${text.t("votes", { count: totals.get(candidateSeat) ?? 0 })}`,
        ),
      );
      return {
        ...named("voting-dispute", "vote", label, payload.reason),
        ariaLabel: `${label}; ${counts}; ${text.t("Decision reason: {reason}", { reason: payload.reason })}`,
      };
    }
    case "voting.legally-skipped": {
      const key = messageFor(skipBases, payload.reason);
      if (key === null) return null;
      const label =
        payload.reason === "disciplinary-cancellation"
          ? text.t(key)
          : text.t("Voting skipped: {basis}", { basis: text.t(key) });
      return named("voting-cancelled", "ban", label);
    }
    case "best-move.number-accepted": {
      if (!Number.isInteger(payload.seat) || bestMove === undefined) return null;
      const label = text.t("Best Move number {number} accepted: {player}", {
        number: bestMove.selectedSeats.length,
        player: player(payload.seat),
      });
      return { kind: "best-move", icon: "lightbulb", label, ariaLabel: label };
    }
    case "best-move.slip-corrected": {
      if (
        !Number.isInteger(payload.index) ||
        !Number.isInteger(payload.seat) ||
        typeof payload.reason !== "string"
      )
        return null;
      const index = payload.index as number;
      const oldSeat = frame.before.bestMove?.selectedSeats[index];
      if (oldSeat === undefined) return null;
      const label = text.t("Best Move slip corrected at number {number}: {before} → {after}", {
        number: index + 1,
        before: player(oldSeat),
        after: player(payload.seat),
      });
      return {
        kind: "best-move",
        icon: "lightbulb",
        label,
        ariaLabel: `${label}; ${text.t("Correction reason: {reason}", { reason: payload.reason })}`,
      };
    }
    case "best-move.finalized": {
      const key = messageFor(bestMoveEndings, payload.reason);
      if (
        key === null ||
        payload.readbackAcknowledged !== true ||
        bestMove === undefined ||
        !Number.isInteger(bestMove.mafiaHits)
      )
        return null;
      const ending = text.t(key);
      const selections =
        bestMove.selectedSeats.length === 0
          ? text.t("No accepted Best Move numbers")
          : text.formatList(bestMove.selectedSeats.map(player));
      const label = text.t("Best Move {ending}: {selections}", { ending, selections });
      return {
        kind: "best-move",
        icon: "lightbulb",
        label,
        ariaLabel: text.t(
          "Best Move by {owner}: {selections}; {hits}; {ending}; readback acknowledged",
          {
            owner: player(bestMove.playerSeat),
            selections,
            ending,
            hits: text.t("Mafia hits", { count: bestMove.mafiaHits! }),
          },
        ),
        result: String(bestMove.mafiaHits),
      };
    }
    default:
      return null;
  }
};
