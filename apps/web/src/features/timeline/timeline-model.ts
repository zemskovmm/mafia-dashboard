import {
  isFederationGame,
  isSecretGameEventType,
  isTerminalGamePhase,
  type GameState,
  type ReplayFrame,
} from "@mafia/game-domain";
import {
  timelineConsoleMessages,
  type TimelineConsoleMessageKey,
} from "../../i18n/messages/timeline-console.js";
import type { Message, MessageValues } from "../../i18n/messages/types.js";
import { describeFederationEvent } from "./federation-timeline.js";

export interface TimelineText {
  readonly t: (key: TimelineConsoleMessageKey, values?: MessageValues) => string;
  readonly formatList: (values: readonly string[]) => string;
  readonly formatTime: (value: Date | string) => string;
  readonly playerName?: (id: string) => string | undefined;
}

const interpolate = (template: string, values: MessageValues): string =>
  template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, name: string) =>
    values[name] === undefined ? token : String(values[name]),
  );

export const englishTimelineText: TimelineText = {
  t: (key, values = {}) => {
    const message: Message = timelineConsoleMessages.en[key];
    const template =
      typeof message === "string"
        ? message
        : (message[new Intl.PluralRules("en").select(Number(values.count ?? 0))] ?? message.other);
    return interpolate(template, values);
  },
  formatList: (values) =>
    values.length === 2 ? `${values[0]} and ${values[1]}` : values.join(", "),
  formatTime: (value) =>
    new Intl.DateTimeFormat("en", { timeStyle: "medium" }).format(
      value instanceof Date ? value : new Date(value),
    ),
};

export const TIMELINE_REGION_COLORS = {
  initialNight: "#1e3a5f",
  day: "#d9972f",
  voting: "#7955a6",
  night: "#182033",
} as const;

export type TimelineRegionKind = "initial-night" | "day" | "voting" | "night";

export interface TimelineRegion {
  readonly id: string;
  readonly kind: TimelineRegionKind;
  readonly label: string;
  readonly color: string;
  readonly day: number;
  readonly startFrameIndex: number;
  readonly endFrameIndex: number;
  readonly frameCount: number;
  readonly startSequence: number;
  readonly endSequence: number;
}

export type TimelineMarkerKind =
  | "start"
  | "phase"
  | "turn"
  | "nomination"
  | "voting-result"
  | "voting-call"
  | "voting-dispute"
  | "vote-correction"
  | "vote"
  | "voting-cancelled"
  | "car-crash-result"
  | "mafia-shots"
  | "don-check"
  | "sheriff-check"
  | "check-skipped"
  | "foul"
  | "discipline"
  | "red-card"
  | "best-move"
  | "completion"
  | "generic";

export interface TimelineShot {
  readonly shooterSeat: number;
  readonly targetSeat: number;
  readonly shooterLabel: string;
  readonly targetLabel: string;
  readonly occurrence?: number;
}

export interface TimelineMarker {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly frameIndex: number;
  readonly sequence: number;
  readonly regionId: string | null;
  readonly kind: TimelineMarkerKind;
  readonly icon: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly accessibleLabel: string;
  readonly createdAt: string;
  readonly shots?: readonly TimelineShot[];
  readonly result?: string;
}

export interface TimelineFrameModel {
  readonly index: number;
  readonly sequence: number;
  readonly regionId: string | null;
  readonly markerId: string;
  readonly replayFrame: ReplayFrame;
}

export interface TimelineModel {
  readonly regions: readonly TimelineRegion[];
  readonly markers: readonly TimelineMarker[];
  readonly frames: readonly TimelineFrameModel[];
}

interface RegionIdentity {
  readonly id: string;
  readonly kind: TimelineRegionKind;
  readonly label: string;
  readonly color: string;
  readonly day: number;
}

export interface MarkerDescription {
  readonly kind: TimelineMarkerKind;
  readonly icon: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly shots?: readonly TimelineShot[];
  readonly result?: string;
}

const regionForState = (game: GameState, text: TimelineText): RegionIdentity | null => {
  if (game.day === 0) {
    return {
      id: "initial-night",
      kind: "initial-night",
      label: text.t(isFederationGame(game) ? "Night 1 · Mafia planning" : "Initial night"),
      color: TIMELINE_REGION_COLORS.initialNight,
      day: 0,
    };
  }

  if (isTerminalGamePhase(game.phase)) return null;
  if (game.phase.startsWith("night-")) {
    return {
      id: `night-${game.day}`,
      kind: "night",
      label: text.t("Night {day}", { day: game.day + (isFederationGame(game) ? 1 : 0) }),
      color: TIMELINE_REGION_COLORS.night,
      day: game.day,
    };
  }
  if (
    game.phase === "voting" ||
    game.phase === "voting-cancelled" ||
    game.phase === "car-crash" ||
    game.phase === "car-crash-decision" ||
    game.phase === "car-crash-skipped" ||
    (game.phase === "goodbye-speech" && game.goodbyeNext === "night")
  ) {
    return {
      id: `voting-${game.day}`,
      kind: "voting",
      label:
        isFederationGame(game) && game.day === 1
          ? text.t("Voting · zero round")
          : text.t("Voting {day}", { day: game.day - (isFederationGame(game) ? 1 : 0) }),
      color: TIMELINE_REGION_COLORS.voting,
      day: game.day,
    };
  }
  return {
    id: `day-${game.day}`,
    kind: "day",
    label:
      isFederationGame(game) && game.day === 1
        ? text.t("Zero round")
        : text.t("Day {day}", { day: game.day - (isFederationGame(game) ? 1 : 0) }),
    color: TIMELINE_REGION_COLORS.day,
    day: game.day,
  };
};

const regionForFrame = (frame: ReplayFrame, text: TimelineText): RegionIdentity | null => {
  if (
    frame.entry.type === "game.completed" ||
    frame.entry.type === "game.drawn" ||
    frame.entry.type === "game.cancelled" ||
    frame.entry.type === "game.adjudicated" ||
    (frame.entry.type === "phase.changed" && isTerminalGamePhase(frame.after.phase))
  ) {
    return null;
  }
  if (frame.entry.type.startsWith("best-move.")) {
    const day = frame.before.day;
    return {
      id: `night-${day}`,
      kind: "night",
      label: text.t("Night {day}", { day: day + (isFederationGame(frame.before) ? 1 : 0) }),
      color: TIMELINE_REGION_COLORS.night,
      day,
    };
  }
  return regionForState(frame.after, text) ?? regionForState(frame.before, text);
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const hiddenPhaseTargets = new Set(["sheriff-wake", "night-don", "night-sheriff", "best-move"]);

const phaseMessageKeys = {
  "mafia-planning": "Phase mafia planning",
  "mafia-sleep": "Phase mafia sleep",
  "don-identification": "Phase don identification",
  "sheriff-identification": "Phase sheriff identification",
  "free-seating": "Phase free seating",
  "sheriff-wake": "Phase sheriff wake",
  day: "Phase day",
  voting: "Phase voting",
  "voting-cancelled": "Phase voting cancelled",
  "car-crash": "Phase car crash",
  "car-crash-decision": "Phase car crash decision",
  "car-crash-result": "Phase car crash result",
  "car-crash-skipped": "Phase car crash skipped",
  "goodbye-speech": "Phase goodbye speech",
  "best-move": "Phase best move",
  "night-mafia": "Phase night mafia",
  "night-mafia-result": "Phase night mafia result",
  "night-don": "Phase night don",
  "night-don-result": "Phase night don result",
  "night-sheriff": "Phase night sheriff",
  "night-sheriff-result": "Phase night sheriff result",
  "night-resolution": "Phase night resolution",
  finished: "Phase finished",
  draw: "Phase drawn",
  cancelled: "Phase cancelled",
} as const satisfies Readonly<Record<string, TimelineConsoleMessageKey>>;

export const formatTimelinePhase = (phase: string, text: TimelineText): string =>
  text.t("Phase: {phase}", {
    phase: text.t(phaseMessageKeys[phase as keyof typeof phaseMessageKeys] ?? "Generic event", {
      event: phase.replaceAll("-", " "),
    }),
  });

export const isVisibleTimelineEvent = (eventType: string, payload: unknown): boolean => {
  if (eventType === "turn.completed") return false;
  if (eventType !== "phase.changed") return true;
  const target = asRecord(payload)?.to;
  return typeof target !== "string" || !hiddenPhaseTargets.has(target);
};

const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const playerLabel = (frame: ReplayFrame, value: unknown, text: TimelineText): string => {
  const seat = integer(value);
  if (seat === null) return text.t("Unknown player");
  const player =
    frame.after.players.find((candidate) => candidate.seat === seat) ??
    frame.before.players.find((candidate) => candidate.seat === seat);
  if (player === undefined) return text.t("Seat {seat}", { seat });
  return text.playerName?.(player.id) ?? text.t("Anonymous player");
};

const humanizeEventType = (eventType: string): string => {
  const text = eventType.replace(/[.-]+/g, " ").trim();
  return text.length === 0 ? "Game event" : `${text[0]!.toUpperCase()}${text.slice(1)}`;
};

const genericDescription = (eventType: string, text: TimelineText): MarkerDescription => {
  const label = text.t("Generic event", { event: humanizeEventType(eventType) });
  return { kind: "generic", icon: "circle", label, ariaLabel: label };
};

const voteTotalsLabel = (frame: ReplayFrame, value: unknown, text: TimelineText): string => {
  const totals = asRecord(value);
  if (totals === null) return "";
  return Object.entries(totals)
    .map(([seat, total]) => {
      const parsedSeat = Number(seat);
      return typeof total === "number" && Number.isFinite(total)
        ? `${playerLabel(frame, parsedSeat, text)}: ${text.t("votes", { count: total })}`
        : null;
    })
    .filter((item): item is string => item !== null)
    .join(", ");
};

const describeMarker = (frame: ReplayFrame, text: TimelineText): MarkerDescription => {
  const eventType = String(frame.entry.type);
  const payload = asRecord(frame.entry.payload);
  if (payload === null) return genericDescription(eventType, text);
  const federation = describeFederationEvent(frame, text, (seat) => playerLabel(frame, seat, text));
  if (federation !== null) return federation;

  switch (eventType) {
    case "game.started":
      return {
        kind: "start",
        icon: "play",
        label: text.t("Game started"),
        ariaLabel: text.t("Game started"),
      };
    case "game.checkpointed":
      return {
        kind: "start",
        icon: "play",
        label: text.t("Imported game checkpoint"),
        ariaLabel: text.t("Imported game checkpoint"),
      };
    case "phase.changed": {
      const to = typeof payload.to === "string" ? payload.to : null;
      if (to === null) return genericDescription(eventType, text);
      if (to === "night-mafia") {
        return {
          kind: "phase",
          icon: "arrow-right",
          label: text.t("Night"),
          ariaLabel: text.t("Night"),
        };
      }
      const label = formatTimelinePhase(to, text);
      return { kind: "phase", icon: "arrow-right", label, ariaLabel: label };
    }
    case "turn.completed": {
      if (integer(payload.seat) === null) return genericDescription(eventType, text);
      const player = playerLabel(frame, payload.seat, text);
      return {
        kind: "turn",
        icon: "message-circle",
        label: text.t("{player} completed turn", { player }),
        ariaLabel: text.t("{player} completed their turn", { player }),
      };
    }
    case "player.nominated": {
      if (integer(payload.nominatorSeat) === null || integer(payload.candidateSeat) === null) {
        return genericDescription(eventType, text);
      }
      const nominator = playerLabel(frame, payload.nominatorSeat, text);
      const candidate = playerLabel(frame, payload.candidateSeat, text);
      return {
        kind: "nomination",
        icon: "user-plus",
        label: text.t("{candidate} set for voting", { candidate }),
        ariaLabel: text.t("Nomination: {nominator} set {candidate} for voting", {
          nominator,
          candidate,
        }),
      };
    }
    case "voting.resolved": {
      const result = asRecord(payload.result);
      const seats = Array.isArray(result?.seats) ? result.seats : null;
      if (result === null || seats === null || seats.some((seat) => integer(seat) === null)) {
        return genericDescription(eventType, text);
      }
      const players = text.formatList(seats.map((seat) => playerLabel(frame, seat, text)));
      const outcome =
        result.kind === "winner"
          ? text.t("Players eliminated", { players, count: seats.length })
          : text.t("Players tied", { players, count: seats.length });
      const totals = voteTotalsLabel(frame, result.totals, text);
      if (result.kind === "eliminate-all-skipped" && typeof result.skipReason === "string") {
        const basisKeys = {
          "all-active": "Skip basis all active",
          "nine-three-restricted": "Skip basis nine three restricted",
          "zero-round-five": "Skip basis zero round five",
        } as const satisfies Record<string, TimelineConsoleMessageKey>;
        const basisKey = basisKeys[result.skipReason as keyof typeof basisKeys];
        if (basisKey !== undefined) {
          const label = text.t("Collective lift prohibited: {basis}", { basis: text.t(basisKey) });
          return {
            kind: "voting-result",
            icon: "vote",
            label,
            ariaLabel: `${label}; ${players}${totals.length > 0 ? `; ${totals}` : ""}`,
            result: "eliminate-all-skipped",
          };
        }
      }
      return {
        kind: "voting-result",
        icon: "vote",
        label: text.t("Vote: {outcome}", { outcome }),
        ariaLabel: `${text.t("Voting result: {outcome}", { outcome })}${totals.length > 0 ? `; ${totals}` : ""}`,
        result: typeof result.kind === "string" ? result.kind : "unknown",
      };
    }
    case "voting.skipped":
      return {
        kind: "voting-cancelled",
        icon: "ban",
        label: text.t("Voting skipped"),
        ariaLabel: text.t("Voting skipped by the host"),
        result: "host-skipped",
      };
    case "car-crash.resolved":
    case "car-crash.ballot-resolved":
    case "car-crash.count-completed": {
      const result = asRecord(payload.result);
      const seats = Array.isArray(result?.seats) ? result.seats : null;
      if (
        result === null ||
        seats === null ||
        seats.some((seat) => integer(seat) === null) ||
        typeof result.eliminate !== "boolean"
      ) {
        return genericDescription(eventType, text);
      }
      const players = text.formatList(seats.map((seat) => playerLabel(frame, seat, text)));
      const outcome = result.eliminate
        ? text.t("Players eliminated", { players, count: seats.length })
        : text.t("Players kept", { players, count: seats.length });
      const completed = eventType === "car-crash.count-completed";
      const label = text.t(completed ? "Hand count completed: {outcome}" : "Car crash: {outcome}", {
        outcome,
      });
      return {
        kind: "car-crash-result",
        icon: "car-front",
        label,
        ariaLabel: completed
          ? `${label}; ${text.t("Hand count support: {yes} of {eligible}", {
              yes: Number(result.yesVotes),
              eligible: Number(result.eligibleVoters),
            })}`
          : text.t("Car-crash decision: {outcome}", { outcome }),
        result: result.eliminate ? "eliminated" : "kept",
      };
    }
    case "mafia.shots-resolved": {
      const rawShots = Array.isArray(payload.shots) ? payload.shots : null;
      const result = asRecord(payload.result);
      if (rawShots === null || result === null || typeof result.kind !== "string") {
        return genericDescription(eventType, text);
      }
      const shots: TimelineShot[] = [];
      for (const rawShot of rawShots) {
        const shot = asRecord(rawShot);
        const shooterSeat = integer(shot?.shooterSeat);
        const targetSeat = integer(shot?.targetSeat);
        if (shooterSeat === null || targetSeat === null) return genericDescription(eventType, text);
        shots.push({
          shooterSeat,
          targetSeat,
          shooterLabel: playerLabel(frame, shooterSeat, text),
          targetLabel: playerLabel(frame, targetSeat, text),
        });
      }
      if (shots.length === 0) return genericDescription(eventType, text);
      const pairs = shots
        .map(({ shooterLabel, targetLabel }) =>
          text.t("{shooter} to {target}", {
            shooter: shooterLabel,
            target: targetLabel,
          }),
        )
        .join("; ");
      let label: string;
      let resultLabel: string;
      if (result.kind === "kill" && integer(result.targetSeat) !== null) {
        const target = playerLabel(frame, result.targetSeat, text);
        label = text.t("Mafia kill: {target}", { target });
        resultLabel = text.t("{target} killed", { target });
      } else if (result.kind === "no-effect" && integer(result.targetSeat) !== null) {
        const target = playerLabel(frame, result.targetSeat, text);
        label = text.t("Mafia no effect: {target}", { target });
        resultLabel = text.t("no effect on {target}", { target });
      } else if (result.kind === "miss") {
        label = text.t("Mafia miss");
        resultLabel = text.t("miss");
      } else {
        return genericDescription(eventType, text);
      }
      return {
        kind: "mafia-shots",
        icon: "crosshair",
        label,
        ariaLabel: text.t("Mafia shots: {pairs}. Result: {result}", { pairs, result: resultLabel }),
        shots,
        result: result.kind,
      };
    }
    case "don.checked": {
      if (integer(payload.targetSeat) === null || typeof payload.match !== "boolean") {
        return genericDescription(eventType, text);
      }
      const label = text.t("Don checked {target}: {result}", {
        target: playerLabel(frame, payload.targetSeat, text),
        result: text.t(payload.match ? "Sheriff" : "Not Sheriff"),
      });
      return { kind: "don-check", icon: "eye", label, ariaLabel: label };
    }
    case "don.check-skipped":
      return {
        kind: "check-skipped",
        icon: "skip-forward",
        label: text.t("Don check skipped"),
        ariaLabel: text.t("Don check skipped"),
      };
    case "sheriff.checked": {
      if (integer(payload.targetSeat) === null || typeof payload.match !== "boolean") {
        return genericDescription(eventType, text);
      }
      const label = text.t("Sheriff checked {target}: {result}", {
        target: playerLabel(frame, payload.targetSeat, text),
        result: text.t(payload.match ? "Mafia" : "Not Mafia"),
      });
      return { kind: "sheriff-check", icon: "shield-search", label, ariaLabel: label };
    }
    case "sheriff.check-skipped":
      return {
        kind: "check-skipped",
        icon: "skip-forward",
        label: text.t("Sheriff check skipped"),
        ariaLabel: text.t("Sheriff check skipped"),
      };
    case "foul.issued": {
      const foulNumber = integer(payload.foulNumber);
      if (
        integer(payload.seat) === null ||
        foulNumber === null ||
        typeof payload.redCarded !== "boolean"
      ) {
        return genericDescription(eventType, text);
      }
      const player = playerLabel(frame, payload.seat, text);
      return payload.redCarded
        ? {
            kind: "red-card",
            icon: "badge-x",
            label: text.t("{player} red-carded (fourth foul)", { player }),
            ariaLabel: text.t("Foul {number}: {player}; red card issued", {
              number: foulNumber,
              player,
            }),
          }
        : {
            kind: "foul",
            icon: "triangle-alert",
            label: text.t("Foul {number}: {player}", { number: foulNumber, player }),
            ariaLabel: text.t("Foul {number}: {player}", { number: foulNumber, player }),
          };
    }
    case "player.red-carded": {
      if (integer(payload.seat) === null) return genericDescription(eventType, text);
      const player = playerLabel(frame, payload.seat, text);
      return {
        kind: "red-card",
        icon: "badge-x",
        label: text.t("{player} red-carded", { player }),
        ariaLabel: text.t("Red card: {player}", { player }),
      };
    }
    case "best-move.completed": {
      const playerSeat = integer(payload.playerSeat);
      const selectedSeats = Array.isArray(payload.selectedSeats) ? payload.selectedSeats : null;
      const mafiaHits = integer(payload.mafiaHits);
      if (
        playerSeat === null ||
        selectedSeats === null ||
        selectedSeats.some((seat) => integer(seat) === null) ||
        mafiaHits === null
      ) {
        return genericDescription(eventType, text);
      }
      const owner = playerLabel(frame, playerSeat, text);
      const selections = text.formatList(
        selectedSeats.map((seat) => playerLabel(frame, seat, text)),
      );
      const hits = text.t("Mafia hits", { count: mafiaHits });
      const label = text.t("Best move: {hits}", { hits });
      return {
        kind: "best-move",
        icon: "lightbulb",
        label,
        ariaLabel: text.t("Best move by {owner}: {selections}; {hits}", {
          owner,
          selections,
          hits,
        }),
        result: String(mafiaHits),
      };
    }
    case "game.completed": {
      const team =
        payload.winner === "red" ? "Red team" : payload.winner === "black" ? "Black team" : null;
      if (team === null) return genericDescription(eventType, text);
      const winner = text.t("{team} team won", { team: text.t(team) });
      return {
        kind: "completion",
        icon: "trophy",
        label: winner,
        ariaLabel: text.t("Game completed: {team}", { team: winner }),
      };
    }
    case "game.drawn":
    case "game.cancelled": {
      const reason = typeof payload.reason === "string" ? payload.reason : null;
      if (reason === null) return genericDescription(eventType, text);
      const drawn = eventType === "game.drawn";
      return {
        kind: "completion",
        icon: drawn ? "handshake" : "ban",
        label: text.t(drawn ? "Game drawn" : "Game cancelled"),
        ariaLabel: text.t(drawn ? "Game drawn: {reason}" : "Game cancelled: {reason}", {
          reason,
        }),
      };
    }
    default:
      return genericDescription(eventType, text);
  }
};

const createMarker = (
  frame: ReplayFrame,
  frameIndex: number,
  regionId: string | null,
  text: TimelineText,
): TimelineMarker => {
  const description = describeMarker(frame, text);
  return {
    id: `marker-${frame.entry.id}`,
    eventId: frame.entry.id,
    eventType: String(frame.entry.type),
    frameIndex,
    sequence: frame.entry.sequence,
    regionId,
    ...description,
    accessibleLabel: description.ariaLabel,
    createdAt: frame.entry.createdAt,
  };
};

export const buildTimeline = (
  frames: readonly ReplayFrame[],
  text: TimelineText = englishTimelineText,
): TimelineModel => {
  const visibleFrames = frames.filter(({ entry }) =>
    isVisibleTimelineEvent(String(entry.type), entry.payload),
  );
  const regions: TimelineRegion[] = [];
  const regionIds: Array<string | null> = [];

  visibleFrames.forEach((frame, frameIndex) => {
    const identity = regionForFrame(frame, text);
    regionIds.push(identity?.id ?? null);
    if (identity === null) return;
    const previous = regions.at(-1);
    if (previous?.id === identity.id) {
      regions[regions.length - 1] = {
        ...previous,
        endFrameIndex: frameIndex,
        frameCount: previous.frameCount + 1,
        endSequence: frame.entry.sequence,
      };
      return;
    }
    regions.push({
      ...identity,
      startFrameIndex: frameIndex,
      endFrameIndex: frameIndex,
      frameCount: 1,
      startSequence: frame.entry.sequence,
      endSequence: frame.entry.sequence,
    });
  });

  const markers = visibleFrames.map((frame, index) =>
    createMarker(frame, index, regionIds[index] ?? null, text),
  );
  const frameModels = visibleFrames.map((replayFrame, index) => ({
    index,
    sequence: replayFrame.entry.sequence,
    regionId: regionIds[index] ?? null,
    markerId: markers[index]!.id,
    replayFrame,
  }));

  return { regions, markers, frames: frameModels };
};

export const buildTimelineModel = buildTimeline;

export type PublicTimelineModel = Pick<TimelineModel, "regions" | "markers">;

/** Display-only public projection. Never return replay frames or use this as a replay log. */
export const buildPublicTimeline = (
  frames: readonly ReplayFrame[],
  text: TimelineText = englishTimelineText,
): PublicTimelineModel => {
  const { regions, markers } = buildTimeline(
    frames.filter(({ entry }) => !isSecretGameEventType(String(entry.type))),
    text,
  );
  return { regions, markers };
};
