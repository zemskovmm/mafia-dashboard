import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BadgeX,
  Ban,
  CarFront,
  Circle,
  Crosshair,
  Eye,
  Lightbulb,
  MessageCircle,
  Play,
  ShieldCheck,
  SkipForward,
  Trophy,
  UserPlus,
  Vote,
  type LucideProps,
} from "lucide-react";
import {
  isProvisionalInteractionType,
  replayGameLog,
  type GameLogEntry,
  type GameState,
  type InitialGameBaseline,
  type ReplayFrame,
} from "@mafia/game-domain";
import {
  getGameSession,
  listCompletedGameSessions,
  type CompletedGameSessionSummary,
  type RemoteGameSession,
} from "../../api/client.js";
import { reportError } from "../console/error-console.js";
import { getActiveBranch } from "../game/game-history.js";
import { createSampleGameHistory } from "./sample-game-data.js";
import {
  buildTimeline,
  isVisibleTimelineEvent,
  TIMELINE_REGION_COLORS,
  type TimelineMarker,
  type TimelineModel,
  type TimelineRegion,
  type TimelineRegionKind,
} from "./timeline-model.js";

interface TimelineLoaders {
  readonly listCompleted: (clubId: string) => Promise<readonly CompletedGameSessionSummary[]>;
  readonly getSession: (gameId: string, clubId: string) => Promise<RemoteGameSession>;
}

interface GameTimelineScreenProps {
  readonly clubId: string;
  readonly onBack: () => void;
  readonly loaders?: TimelineLoaders;
  readonly showDevelopmentTools?: boolean;
  readonly currentHistory?: {
    readonly label: string;
    readonly frames: readonly ReplayFrame[];
    readonly headEventId: string;
  };
  readonly onPreviewCurrentEvent?: (eventId: string) => void;
  readonly onResetCurrentEvent?: (eventId: string) => void;
}

interface LoadedHistory {
  readonly label: string;
  readonly timeline: TimelineModel;
  readonly summary: CompletedGameSessionSummary | null;
  readonly sample: boolean;
  readonly legacy: boolean;
  readonly current: boolean;
  readonly headEventId: string | null;
}

const defaultLoaders: TimelineLoaders = {
  listCompleted: (clubId) => listCompletedGameSessions(clubId),
  getSession: (gameId, clubId) => getGameSession(gameId, clubId),
};

const iconByName: Readonly<Record<string, ComponentType<LucideProps>>> = {
  play: Play,
  "arrow-right": ArrowRight,
  "message-circle": MessageCircle,
  "user-plus": UserPlus,
  vote: Vote,
  ban: Ban,
  "car-front": CarFront,
  crosshair: Crosshair,
  eye: Eye,
  "shield-search": ShieldCheck,
  "skip-forward": SkipForward,
  "triangle-alert": Circle,
  "badge-x": BadgeX,
  lightbulb: Lightbulb,
  trophy: Trophy,
  circle: Circle,
};

interface LegacyLogEntry {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

interface LegacyRegionIdentity {
  readonly id: string;
  readonly kind: TimelineRegionKind;
  readonly label: string;
  readonly color: string;
  readonly day: number;
}

const legacyRegion = (phase: string, day: number): LegacyRegionIdentity | null => {
  if (phase === "finished") return null;
  if (day === 0) {
    return {
      id: "initial-night",
      kind: "initial-night",
      label: "Initial night",
      color: TIMELINE_REGION_COLORS.initialNight,
      day,
    };
  }
  if (phase.startsWith("night-")) {
    return {
      id: `night-${day}`,
      kind: "night",
      label: `Night ${day}`,
      color: TIMELINE_REGION_COLORS.night,
      day,
    };
  }
  if (
    phase === "voting" ||
    phase === "voting-cancelled" ||
    phase === "car-crash" ||
    phase === "car-crash-decision" ||
    phase === "car-crash-skipped" ||
    phase === "goodbye-speech"
  ) {
    return {
      id: `voting-${day}`,
      kind: "voting",
      label: `Voting ${day}`,
      color: TIMELINE_REGION_COLORS.voting,
      day,
    };
  }
  return {
    id: `day-${day}`,
    kind: "day",
    label: `Day ${day}`,
    color: TIMELINE_REGION_COLORS.day,
    day,
  };
};

const legacyPlayerLabel = (game: GameState | null, value: unknown): string => {
  if (typeof value !== "number" || !Number.isInteger(value)) return "Unknown player";
  const player = game?.players.find(({ seat }) => seat === value);
  const name = typeof player?.name === "string" ? player.name.trim() : "";
  return name.length > 0 ? name : `Seat ${value}`;
};

const legacyMarker = (
  raw: LegacyLogEntry,
  game: GameState | null,
  frameIndex: number,
  regionId: string | null,
): TimelineMarker => {
  let kind: TimelineMarker["kind"] = "generic";
  let icon = "circle";
  let label = raw.type.replace(/[.-]+/g, " ").trim() || "Game event";
  let ariaLabel = label;
  switch (raw.type) {
    case "phase.changed":
      if (typeof raw.payload.to === "string") {
        kind = "phase";
        icon = "arrow-right";
        label =
          raw.payload.to === "night-mafia"
            ? "Night"
            : `Phase: ${raw.payload.to.replaceAll("-", " ")}`;
        ariaLabel = label;
      }
      break;
    case "turn.completed":
      if (typeof raw.payload.seat === "number") {
        const player = legacyPlayerLabel(game, raw.payload.seat);
        kind = "turn";
        icon = "message-circle";
        label = `${player} completed turn`;
        ariaLabel = `${player} completed their turn`;
      }
      break;
    case "player.nominated":
      if (
        typeof raw.payload.nominatorSeat === "number" &&
        typeof raw.payload.candidateSeat === "number"
      ) {
        const nominator = legacyPlayerLabel(game, raw.payload.nominatorSeat);
        const candidate = legacyPlayerLabel(game, raw.payload.candidateSeat);
        kind = "nomination";
        icon = "user-plus";
        label = `${candidate} set for voting`;
        ariaLabel = `Nomination: ${nominator} set ${candidate} for voting`;
      }
      break;
    case "player.red-carded":
      if (typeof raw.payload.seat === "number") {
        const player = legacyPlayerLabel(game, raw.payload.seat);
        kind = "red-card";
        icon = "badge-x";
        label = `${player} red-carded`;
        ariaLabel = `Red card: ${player}`;
      }
      break;
    case "don.checked":
    case "sheriff.checked":
      if (typeof raw.payload.targetSeat === "number" && typeof raw.payload.match === "boolean") {
        const actor = raw.type === "don.checked" ? "Don" : "Sheriff";
        const role = raw.type === "don.checked" ? "Sheriff" : "Mafia";
        kind = raw.type === "don.checked" ? "don-check" : "sheriff-check";
        icon = raw.type === "don.checked" ? "eye" : "shield-search";
        label = `${actor} checked ${legacyPlayerLabel(game, raw.payload.targetSeat)}: ${raw.payload.match ? role : `Not ${role}`}`;
        ariaLabel = label;
      }
      break;
    case "don.check-skipped":
    case "sheriff.check-skipped":
      kind = "check-skipped";
      icon = "skip-forward";
      label = raw.type === "don.check-skipped" ? "Don check skipped" : "Sheriff check skipped";
      ariaLabel = label;
      break;
    case "voting.skipped":
      kind = "voting-cancelled";
      icon = "ban";
      label = "Voting skipped";
      ariaLabel = "Voting skipped by the host";
      break;
    case "game.completed":
      if (raw.payload.winner === "red" || raw.payload.winner === "black") {
        const winner = raw.payload.winner === "red" ? "Red" : "Black";
        kind = "completion";
        icon = "trophy";
        label = `${winner} team won`;
        ariaLabel = `Game completed: ${winner} team won`;
      }
      break;
  }
  return {
    id: `marker-${raw.id}`,
    eventId: raw.id,
    eventType: raw.type,
    frameIndex,
    sequence: raw.sequence,
    regionId,
    kind,
    icon,
    label,
    ariaLabel,
    accessibleLabel: ariaLabel,
    createdAt: raw.createdAt,
  };
};

const legacyTimeline = (session: RemoteGameSession): TimelineModel => {
  const finalGame = session.state.game as GameState | null;
  const rawLog = session.state.log as readonly LegacyLogEntry[];
  if (rawLog.length === 0) return { regions: [], markers: [], frames: [] };
  let day = 0;
  const regions: TimelineRegion[] = [];
  const markers: TimelineMarker[] = [];
  for (const raw of rawLog) {
    if (isProvisionalInteractionType(raw.type) || !isVisibleTimelineEvent(raw.type, raw.payload)) {
      continue;
    }
    if (typeof raw.payload.day === "number" && Number.isInteger(raw.payload.day)) {
      day = raw.payload.day;
    }
    const requestedPhase =
      raw.type === "phase.changed" && typeof raw.payload.to === "string"
        ? raw.payload.to
        : raw.phase;
    if (day === 0 && requestedPhase !== "mafia-planning" && requestedPhase !== "sheriff-wake") {
      day = 1;
    }
    const identity =
      raw.type === "best-move.completed"
        ? legacyRegion("night-best-move", Math.max(1, day - 1))
        : legacyRegion(requestedPhase, day);
    const frameIndex = markers.length;
    const previous = regions.at(-1);
    if (identity !== null) {
      if (previous?.id === identity.id) {
        regions[regions.length - 1] = {
          ...previous,
          endFrameIndex: frameIndex,
          frameCount: previous.frameCount + 1,
          endSequence: raw.sequence,
        };
      } else {
        regions.push({
          ...identity,
          startFrameIndex: frameIndex,
          endFrameIndex: frameIndex,
          frameCount: 1,
          startSequence: raw.sequence,
          endSequence: raw.sequence,
        });
      }
    }
    markers.push(legacyMarker(raw, finalGame, frameIndex, identity?.id ?? null));
  }
  return { regions, markers, frames: [] };
};

const replaySession = (
  session: RemoteGameSession,
): { readonly timeline: TimelineModel; readonly legacy: boolean } => {
  const baseline = session.state.initialGame as InitialGameBaseline | null | undefined;
  const entries = session.state.events as readonly GameLogEntry[] | undefined;
  const headEventId = session.state.headEventId;
  if (entries?.some(({ gameId }) => gameId !== session.gameId) === true) {
    throw new Error("Loaded timeline contains events from another game");
  }
  if (baseline == null || entries === undefined || headEventId == null) {
    const timeline = legacyTimeline(session);
    if (timeline.markers.length === 0) throw new Error("This game has no timeline markers");
    return { timeline, legacy: true };
  }
  return {
    timeline: buildTimeline(replayGameLog(baseline, getActiveBranch(entries, headEventId)).frames),
    legacy: false,
  };
};

export const GameTimelineScreen = (props: GameTimelineScreenProps) => (
  <TenantGameTimelineScreen key={props.clubId} {...props} />
);

const TenantGameTimelineScreen = ({
  clubId,
  onBack,
  loaders = defaultLoaders,
  showDevelopmentTools = false,
  currentHistory,
  onPreviewCurrentEvent,
  onResetCurrentEvent,
}: GameTimelineScreenProps) => {
  const loadCurrentHistory = (): LoadedHistory | null => {
    if (currentHistory === undefined) return null;
    const timeline = buildTimeline(currentHistory.frames);
    const headSequence = currentHistory.frames.find(
      ({ entry }) => entry.id === currentHistory.headEventId,
    )?.entry.sequence;
    const semanticHead = timeline.markers.reduce<(typeof timeline.markers)[number] | null>(
      (latest, marker) =>
        headSequence !== undefined && marker.sequence <= headSequence ? marker : latest,
      null,
    );
    return {
      label: `${currentHistory.label} · Checkpoint #${semanticHead?.sequence ?? headSequence ?? "—"}`,
      timeline,
      summary: null,
      sample: false,
      legacy: false,
      current: true,
      headEventId: semanticHead?.eventId ?? currentHistory.headEventId,
    };
  };
  const [summaries, setSummaries] = useState<readonly CompletedGameSessionSummary[] | null>(null);
  const [selectedGameId, setSelectedGameId] = useState(
    currentHistory === undefined ? "" : "current",
  );
  const [history, setHistory] = useState<LoadedHistory | null>(loadCurrentHistory);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [loadingGameName, setLoadingGameName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);

  useEffect(() => {
    const request = listRequestRef.current + 1;
    listRequestRef.current = request;
    setError(null);
    void loaders
      .listCompleted(clubId)
      .then((next) => {
        if (listRequestRef.current === request) setSummaries(next);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "timeline.completed-games.list" });
        if (listRequestRef.current === request) {
          setSummaries([]);
          setError("Completed games are temporarily unavailable.");
        }
      });
    return () => {
      if (listRequestRef.current === request) listRequestRef.current += 1;
    };
  }, [clubId, loaders]);

  useEffect(() => {
    if (selectedGameId === "current") setHistory(loadCurrentHistory());
  }, [currentHistory?.headEventId, currentHistory?.label, selectedGameId]);

  const timeline = history?.timeline ?? null;
  const selectedMarker =
    timeline?.markers.find(({ id }) => id === selectedMarkerId) ??
    timeline?.markers.find(({ eventId }) => eventId === history?.headEventId) ??
    timeline?.markers[0] ??
    null;

  const showSample = () => {
    sessionRequestRef.current += 1;
    const sample = createSampleGameHistory();
    setSelectedGameId("");
    setLoadingGameName(null);
    setError(null);
    setHistory({
      label: sample.label,
      timeline: buildTimeline(sample.frames),
      summary: null,
      sample: true,
      legacy: false,
      current: false,
      headEventId: null,
    });
    setSelectedMarkerId(null);
  };

  const selectCompletedGame = (gameId: string) => {
    const request = sessionRequestRef.current + 1;
    sessionRequestRef.current = request;
    setSelectedGameId(gameId);
    setHistory(null);
    setSelectedMarkerId(null);
    setLoadingGameName(null);
    setError(null);
    if (gameId === "current") {
      setHistory(loadCurrentHistory());
      return;
    }
    if (gameId === "") return;
    const summary = summaries?.find((candidate) => candidate.gameId === gameId);
    if (summary === undefined) return;
    setLoadingGameName(summary.name);
    void loaders
      .getSession(gameId, clubId)
      .then((session) => {
        if (sessionRequestRef.current !== request) return;
        if (session.gameId !== gameId || session.status !== "completed") {
          throw new Error("Loaded session does not match the selected completed game");
        }
        const replayed = replaySession(session);
        setHistory({
          label: summary.name,
          timeline: replayed.timeline,
          summary,
          sample: false,
          legacy: replayed.legacy,
          current: false,
          headEventId: null,
        });
        setLoadingGameName(null);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "timeline.completed-game.load" });
        if (sessionRequestRef.current === request) {
          setLoadingGameName(null);
          setError(`Unable to load ${summary.name}.`);
        }
      });
  };

  const columnCount = Math.max(1, timeline?.markers.length ?? 1);
  const gridStyle = {
    gridTemplateColumns: `repeat(${columnCount}, minmax(64px, 76px))`,
    minWidth: `${columnCount * 68}px`,
  } satisfies CSSProperties;
  const trackStyle = { minWidth: `${columnCount * 68 + 24}px` } satisfies CSSProperties;

  return (
    <main className="timeline-screen" aria-label="Game timeline">
      <header className="timeline-header">
        <button type="button" className="timeline-back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" /> Back
        </button>
        <div>
          <p className="eyebrow">
            {history?.current ? "Current game · Semantic checkpoints" : "Past games · Read only"}
          </p>
          <h1>Game timeline</h1>
        </div>
        <label>
          <span>Completed game</span>
          <select
            aria-label="Completed game"
            value={selectedGameId}
            onChange={(event) => selectCompletedGame(event.currentTarget.value)}
          >
            {currentHistory === undefined ? null : <option value="current">Current game</option>}
            <option value="">Choose a completed game</option>
            {(summaries ?? []).map((summary) => (
              <option key={summary.gameId} value={summary.gameId}>
                {summary.name} · {summary.winner === "red" ? "Citizens" : "Mafia"}
              </option>
            ))}
          </select>
        </label>
        {showDevelopmentTools ? (
          <button type="button" onClick={showSample}>
            Generate sample game data
          </button>
        ) : null}
      </header>

      {error === null ? null : (
        <p className="timeline-error" role="alert">
          {error}
        </p>
      )}
      {summaries === null && history === null ? (
        <p className="timeline-loading">Loading completed games…</p>
      ) : null}
      {loadingGameName === null || history !== null ? null : (
        <p className="timeline-loading">Loading {loadingGameName}…</p>
      )}
      {summaries?.length === 0 && history === null && error === null ? (
        <p className="timeline-empty">No completed games yet.</p>
      ) : null}

      {history === null || timeline === null ? null : (
        <>
          <section className="timeline-editor" aria-label="Game event sequence">
            <div className="timeline-meta">
              <strong>{history.label}</strong>
              {history.sample ? (
                <span className="timeline-sample-badge">Sample · not saved</span>
              ) : null}
              {history.legacy ? (
                <span className="timeline-legacy-badge">
                  Legacy log · state preview unavailable
                </span>
              ) : null}
              {history.summary === null ? null : (
                <span>
                  {history.summary.hostName ?? "Unknown host"} ·{" "}
                  {new Date(history.summary.playedAt).toLocaleString()}
                </span>
              )}
            </div>
            <div className="timeline-track-scroll">
              <div className="timeline-track" style={trackStyle}>
                <div className="timeline-region-lane" style={gridStyle}>
                  {timeline.regions.map((region) => (
                    <div
                      key={region.id}
                      className={`timeline-region is-${region.kind}`}
                      style={
                        {
                          gridColumn: `${region.startFrameIndex + 1} / ${region.endFrameIndex + 2}`,
                          "--timeline-region-color": region.color,
                        } as CSSProperties
                      }
                    >
                      <strong>{region.label}</strong>
                      <small>{region.frameCount} accepted events</small>
                    </div>
                  ))}
                </div>
                <div className="timeline-marker-lane" style={gridStyle}>
                  {timeline.markers.map((marker) => {
                    const Icon = iconByName[marker.icon] ?? Circle;
                    return (
                      <button
                        key={marker.id}
                        type="button"
                        className={`timeline-marker is-${marker.kind}${selectedMarker?.id === marker.id ? " is-selected" : ""}`}
                        style={{ gridColumn: marker.frameIndex + 1 }}
                        aria-label={marker.ariaLabel}
                        aria-pressed={selectedMarker?.id === marker.id}
                        title={marker.label}
                        onClick={() => setSelectedMarkerId(marker.id)}
                      >
                        <Icon aria-hidden="true" />
                        <span>#{marker.sequence}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <TimelineInspector
            marker={selectedMarker}
            current={history.current}
            currentHeadEventId={history.headEventId}
            onPreview={onPreviewCurrentEvent}
            onReset={onResetCurrentEvent}
          />
        </>
      )}
    </main>
  );
};

const TimelineInspector = ({
  marker,
  current,
  currentHeadEventId,
  onPreview,
  onReset,
}: {
  readonly marker: TimelineMarker | null;
  readonly current: boolean;
  readonly currentHeadEventId: string | null;
  readonly onPreview?: (eventId: string) => void;
  readonly onReset?: (eventId: string) => void;
}) => (
  <aside className="timeline-inspector" aria-label="Selected event details">
    {marker === null ? (
      <p>Select an event marker.</p>
    ) : (
      <>
        <div>
          <p className="eyebrow">Log #{marker.sequence}</p>
          <h2>{marker.label}</h2>
        </div>
        <dl>
          <div>
            <dt>Event</dt>
            <dd>{marker.eventType}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{new Date(marker.createdAt).toLocaleTimeString()}</dd>
          </div>
          {marker.result === undefined ? null : (
            <div>
              <dt>Result</dt>
              <dd>{marker.result}</dd>
            </div>
          )}
        </dl>
        {marker.accessibleLabel === marker.label ? null : <p>{marker.accessibleLabel}</p>}
        {marker.shots === undefined ? null : (
          <ul>
            {marker.shots.map((shot) => (
              <li key={`${shot.shooterSeat}-${shot.targetSeat}`}>
                {shot.shooterLabel} → {shot.targetLabel}
              </li>
            ))}
          </ul>
        )}
        {!current || onPreview === undefined || onReset === undefined ? null : (
          <div className="timeline-state-actions">
            <button type="button" onClick={() => onPreview(marker.eventId)}>
              Preview timeline checkpoint
            </button>
            <button
              type="button"
              className="danger-action"
              disabled={marker.eventId === currentHeadEventId}
              onClick={() => onReset(marker.eventId)}
            >
              Reset game to timeline checkpoint
            </button>
          </div>
        )}
      </>
    )}
  </aside>
);
