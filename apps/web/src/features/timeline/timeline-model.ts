import type { GameState, ReplayFrame } from "@mafia/game-domain";

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
  | "voting-cancelled"
  | "car-crash-result"
  | "mafia-shots"
  | "don-check"
  | "sheriff-check"
  | "check-skipped"
  | "foul"
  | "red-card"
  | "best-move"
  | "completion"
  | "generic";

export interface TimelineShot {
  readonly shooterSeat: number;
  readonly targetSeat: number;
  readonly shooterLabel: string;
  readonly targetLabel: string;
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
  readonly secret: boolean;
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

interface MarkerDescription {
  readonly kind: TimelineMarkerKind;
  readonly icon: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly shots?: readonly TimelineShot[];
  readonly result?: string;
}

const regionForState = (game: GameState): RegionIdentity | null => {
  if (game.day === 0) {
    return {
      id: "initial-night",
      kind: "initial-night",
      label: "Initial night",
      color: TIMELINE_REGION_COLORS.initialNight,
      day: 0,
    };
  }

  if (game.phase === "finished") return null;
  if (game.phase.startsWith("night-")) {
    return {
      id: `night-${game.day}`,
      kind: "night",
      label: `Night ${game.day}`,
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
      label: `Voting ${game.day}`,
      color: TIMELINE_REGION_COLORS.voting,
      day: game.day,
    };
  }
  return {
    id: `day-${game.day}`,
    kind: "day",
    label: `Day ${game.day}`,
    color: TIMELINE_REGION_COLORS.day,
    day: game.day,
  };
};

const regionForFrame = (frame: ReplayFrame): RegionIdentity | null =>
  regionForState(frame.after) ?? regionForState(frame.before);

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const playerLabel = (frame: ReplayFrame, value: unknown): string => {
  const seat = integer(value);
  if (seat === null) return "Unknown player";
  const player =
    frame.after.players.find((candidate) => candidate.seat === seat) ??
    frame.before.players.find((candidate) => candidate.seat === seat);
  const name = typeof player?.name === "string" ? player.name.trim() : "";
  return name.length > 0 ? name : `Seat ${seat}`;
};

const humanizeEventType = (eventType: string): string => {
  const text = eventType.replace(/[.-]+/g, " ").trim();
  return text.length === 0 ? "Game event" : `${text[0]!.toUpperCase()}${text.slice(1)}`;
};

const genericDescription = (eventType: string): MarkerDescription => {
  const label = humanizeEventType(eventType);
  return { kind: "generic", icon: "circle", label, ariaLabel: label };
};

const voteTotalsLabel = (frame: ReplayFrame, value: unknown): string => {
  const totals = asRecord(value);
  if (totals === null) return "";
  return Object.entries(totals)
    .map(([seat, total]) => {
      const parsedSeat = Number(seat);
      return typeof total === "number" && Number.isFinite(total)
        ? `${playerLabel(frame, parsedSeat)}: ${total} votes`
        : null;
    })
    .filter((item): item is string => item !== null)
    .join(", ");
};

const describeMarker = (frame: ReplayFrame): MarkerDescription => {
  const eventType = String(frame.entry.type);
  const payload = asRecord(frame.entry.payload);
  if (payload === null) return genericDescription(eventType);

  switch (eventType) {
    case "game.started":
      return { kind: "start", icon: "play", label: "Game started", ariaLabel: "Game started" };
    case "game.checkpointed":
      return {
        kind: "start",
        icon: "play",
        label: "Imported game checkpoint",
        ariaLabel: "Imported game checkpoint",
      };
    case "phase.changed": {
      const to = typeof payload.to === "string" ? payload.to : null;
      if (to === null) return genericDescription(eventType);
      const label = `Phase: ${to.replaceAll("-", " ")}`;
      return { kind: "phase", icon: "arrow-right", label, ariaLabel: label };
    }
    case "turn.completed": {
      if (integer(payload.seat) === null) return genericDescription(eventType);
      const player = playerLabel(frame, payload.seat);
      return {
        kind: "turn",
        icon: "message-circle",
        label: `${player} completed turn`,
        ariaLabel: `${player} completed their turn`,
      };
    }
    case "player.nominated": {
      if (integer(payload.nominatorSeat) === null || integer(payload.candidateSeat) === null) {
        return genericDescription(eventType);
      }
      const nominator = playerLabel(frame, payload.nominatorSeat);
      const candidate = playerLabel(frame, payload.candidateSeat);
      return {
        kind: "nomination",
        icon: "user-plus",
        label: `${candidate} set for voting`,
        ariaLabel: `Nomination: ${nominator} set ${candidate} for voting`,
      };
    }
    case "voting.resolved": {
      const result = asRecord(payload.result);
      const seats = Array.isArray(result?.seats) ? result.seats : null;
      if (result === null || seats === null || seats.some((seat) => integer(seat) === null)) {
        return genericDescription(eventType);
      }
      const players = seats.map((seat) => playerLabel(frame, seat)).join(" and ");
      const outcome = result.kind === "winner" ? `${players} eliminated` : `${players} tied`;
      const totals = voteTotalsLabel(frame, result.totals);
      return {
        kind: "voting-result",
        icon: "vote",
        label: `Vote: ${outcome}`,
        ariaLabel: `Voting result: ${outcome}${totals.length > 0 ? `; ${totals}` : ""}`,
        result: typeof result.kind === "string" ? result.kind : "unknown",
      };
    }
    case "voting.skipped":
      return {
        kind: "voting-cancelled",
        icon: "ban",
        label: "Voting skipped",
        ariaLabel: "Voting skipped by the host",
        result: "host-skipped",
      };
    case "car-crash.resolved": {
      const result = asRecord(payload.result);
      const seats = Array.isArray(result?.seats) ? result.seats : null;
      if (
        result === null ||
        seats === null ||
        seats.some((seat) => integer(seat) === null) ||
        typeof result.eliminate !== "boolean"
      ) {
        return genericDescription(eventType);
      }
      const players = seats.map((seat) => playerLabel(frame, seat)).join(" and ");
      const outcome = result.eliminate ? `${players} eliminated` : `${players} kept`;
      return {
        kind: "car-crash-result",
        icon: "car-front",
        label: `Car crash: ${outcome}`,
        ariaLabel: `Car-crash decision: ${outcome}`,
        result: result.eliminate ? "eliminated" : "kept",
      };
    }
    case "mafia.shots-resolved": {
      const rawShots = Array.isArray(payload.shots) ? payload.shots : null;
      const result = asRecord(payload.result);
      if (rawShots === null || result === null || typeof result.kind !== "string") {
        return genericDescription(eventType);
      }
      const shots: TimelineShot[] = [];
      for (const rawShot of rawShots) {
        const shot = asRecord(rawShot);
        const shooterSeat = integer(shot?.shooterSeat);
        const targetSeat = integer(shot?.targetSeat);
        if (shooterSeat === null || targetSeat === null) return genericDescription(eventType);
        shots.push({
          shooterSeat,
          targetSeat,
          shooterLabel: playerLabel(frame, shooterSeat),
          targetLabel: playerLabel(frame, targetSeat),
        });
      }
      if (shots.length === 0) return genericDescription(eventType);
      const pairs = shots
        .map(({ shooterLabel, targetLabel }) => `${shooterLabel} to ${targetLabel}`)
        .join("; ");
      let label: string;
      let resultLabel: string;
      if (result.kind === "kill" && integer(result.targetSeat) !== null) {
        const target = playerLabel(frame, result.targetSeat);
        label = `Mafia kill: ${target}`;
        resultLabel = `${target} killed`;
      } else if (result.kind === "no-effect" && integer(result.targetSeat) !== null) {
        const target = playerLabel(frame, result.targetSeat);
        label = `Mafia no effect: ${target}`;
        resultLabel = `no effect on ${target}`;
      } else if (result.kind === "miss") {
        label = "Mafia miss";
        resultLabel = "miss";
      } else {
        return genericDescription(eventType);
      }
      return {
        kind: "mafia-shots",
        icon: "crosshair",
        label,
        ariaLabel: `Mafia shots: ${pairs}. Result: ${resultLabel}`,
        shots,
        result: result.kind,
      };
    }
    case "don.checked": {
      if (integer(payload.targetSeat) === null || typeof payload.match !== "boolean") {
        return genericDescription(eventType);
      }
      const label = `Don checked ${playerLabel(frame, payload.targetSeat)}: ${payload.match ? "Sheriff" : "Not Sheriff"}`;
      return { kind: "don-check", icon: "eye", label, ariaLabel: label };
    }
    case "don.check-skipped":
      return {
        kind: "check-skipped",
        icon: "skip-forward",
        label: "Don check skipped",
        ariaLabel: "Don check skipped",
      };
    case "sheriff.checked": {
      if (integer(payload.targetSeat) === null || typeof payload.match !== "boolean") {
        return genericDescription(eventType);
      }
      const label = `Sheriff checked ${playerLabel(frame, payload.targetSeat)}: ${payload.match ? "Mafia" : "Not Mafia"}`;
      return { kind: "sheriff-check", icon: "shield-search", label, ariaLabel: label };
    }
    case "sheriff.check-skipped":
      return {
        kind: "check-skipped",
        icon: "skip-forward",
        label: "Sheriff check skipped",
        ariaLabel: "Sheriff check skipped",
      };
    case "foul.issued": {
      const foulNumber = integer(payload.foulNumber);
      if (
        integer(payload.seat) === null ||
        foulNumber === null ||
        typeof payload.redCarded !== "boolean"
      ) {
        return genericDescription(eventType);
      }
      const player = playerLabel(frame, payload.seat);
      return payload.redCarded
        ? {
            kind: "red-card",
            icon: "badge-x",
            label: `${player} red-carded (fourth foul)`,
            ariaLabel: `Foul ${foulNumber}: ${player}; red card issued`,
          }
        : {
            kind: "foul",
            icon: "triangle-alert",
            label: `Foul ${foulNumber}: ${player}`,
            ariaLabel: `Foul ${foulNumber}: ${player}`,
          };
    }
    case "player.red-carded": {
      if (integer(payload.seat) === null) return genericDescription(eventType);
      const player = playerLabel(frame, payload.seat);
      return {
        kind: "red-card",
        icon: "badge-x",
        label: `${player} red-carded`,
        ariaLabel: `Red card: ${player}`,
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
        return genericDescription(eventType);
      }
      const owner = playerLabel(frame, playerSeat);
      const selections = selectedSeats.map((seat) => playerLabel(frame, seat)).join(", ");
      const label = `Best move: ${mafiaHits} Mafia ${mafiaHits === 1 ? "hit" : "hits"}`;
      return {
        kind: "best-move",
        icon: "lightbulb",
        label,
        ariaLabel: `Best move by ${owner}: ${selections}; ${mafiaHits} Mafia ${mafiaHits === 1 ? "hit" : "hits"}`,
        result: String(mafiaHits),
      };
    }
    case "game.completed": {
      const winner = payload.winner === "red" ? "Red" : payload.winner === "black" ? "Black" : null;
      if (winner === null) return genericDescription(eventType);
      return {
        kind: "completion",
        icon: "trophy",
        label: `${winner} team won`,
        ariaLabel: `Game completed: ${winner} team won`,
      };
    }
    default:
      return genericDescription(eventType);
  }
};

const createMarker = (
  frame: ReplayFrame,
  frameIndex: number,
  regionId: string | null,
): TimelineMarker => {
  const description = describeMarker(frame);
  return {
    id: `marker-${frame.entry.id}`,
    eventId: frame.entry.id,
    eventType: String(frame.entry.type),
    frameIndex,
    sequence: frame.entry.sequence,
    regionId,
    ...description,
    accessibleLabel: description.ariaLabel,
    secret: frame.entry.secret,
    createdAt: frame.entry.createdAt,
  };
};

export const buildTimeline = (frames: readonly ReplayFrame[]): TimelineModel => {
  const regions: TimelineRegion[] = [];
  const regionIds: Array<string | null> = [];

  frames.forEach((frame, frameIndex) => {
    const identity = regionForFrame(frame);
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

  const markers = frames.map((frame, index) =>
    createMarker(frame, index, regionIds[index] ?? null),
  );
  const frameModels = frames.map((replayFrame, index) => ({
    index,
    sequence: replayFrame.entry.sequence,
    regionId: regionIds[index] ?? null,
    markerId: markers[index]!.id,
    replayFrame,
  }));

  return { regions, markers, frames: frameModels };
};

export const buildTimelineModel = buildTimeline;
