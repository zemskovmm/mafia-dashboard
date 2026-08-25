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
  EyeOff,
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
} from "@mafia/game-domain";
import {
  getGameSession,
  listCompletedGameSessions,
  type CompletedGameSessionSummary,
  type RemoteGameSession,
} from "../../api/client.js";
import { getActiveBranch } from "../game/game-history.js";
import { createSampleGameHistory } from "./sample-game-data.js";
import {
  buildTimeline,
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
  readonly privacyHidden?: boolean;
  readonly onTogglePrivacy?: () => void;
}

interface LoadedHistory {
  readonly label: string;
  readonly timeline: TimelineModel;
  readonly summary: CompletedGameSessionSummary | null;
  readonly sample: boolean;
  readonly legacy: boolean;
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
  readonly secret: boolean;
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
        label = `Phase: ${raw.payload.to.replaceAll("-", " ")}`;
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
    secret: raw.secret,
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
    if (isProvisionalInteractionType(raw.type)) continue;
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
    const identity = legacyRegion(requestedPhase, day);
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
  privacyHidden = false,
  onTogglePrivacy,
}: GameTimelineScreenProps) => {
  const [summaries, setSummaries] = useState<readonly CompletedGameSessionSummary[] | null>(null);
  const [selectedGameId, setSelectedGameId] = useState("");
  const [history, setHistory] = useState<LoadedHistory | null>(null);
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
      .catch(() => {
        if (listRequestRef.current === request) {
          setSummaries([]);
          setError("Completed games are temporarily unavailable.");
        }
      });
    return () => {
      if (listRequestRef.current === request) listRequestRef.current += 1;
    };
  }, [clubId, loaders]);

  const timeline = history?.timeline ?? null;
  const selectedMarker =
    timeline?.markers.find(({ id }) => id === selectedMarkerId) ?? timeline?.markers[0] ?? null;

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
        });
        setLoadingGameName(null);
      })
      .catch(() => {
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
    <main className="timeline-screen" aria-label="Past game timeline">
      <header className="timeline-header">
        <button type="button" className="timeline-back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" /> Back
        </button>
        <div>
          <p className="eyebrow">Replay editor · Read only</p>
          <h1>Past game timeline</h1>
        </div>
        <label>
          <span>Completed game</span>
          <select
            aria-label="Completed game"
            value={selectedGameId}
            onChange={(event) => selectCompletedGame(event.currentTarget.value)}
          >
            <option value="">Choose a completed game</option>
            {(summaries ?? []).map((summary) => (
              <option key={summary.gameId} value={summary.gameId}>
                {summary.name} · {summary.winner === "red" ? "Citizens" : "Mafia"}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={showSample}>
          Generate sample game data
        </button>
        {onTogglePrivacy === undefined ? null : (
          <button
            type="button"
            aria-label={privacyHidden ? "Show private info" : "Hide private info"}
            aria-pressed={privacyHidden}
            onClick={onTogglePrivacy}
          >
            {privacyHidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
          </button>
        )}
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
              {columnCount > 12 ? (
                <span className="timeline-scroll-hint">Scroll timeline →</span>
              ) : null}
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
                    const privateMarker = privacyHidden && marker.secret;
                    const Icon = privateMarker ? Circle : (iconByName[marker.icon] ?? Circle);
                    return (
                      <button
                        key={marker.id}
                        type="button"
                        className={`timeline-marker ${privateMarker ? "is-private" : `is-${marker.kind}`}${selectedMarker?.id === marker.id ? " is-selected" : ""}`}
                        style={{ gridColumn: marker.frameIndex + 1 }}
                        aria-label={privateMarker ? "Private event" : marker.ariaLabel}
                        aria-pressed={selectedMarker?.id === marker.id}
                        title={privateMarker ? "Private event" : marker.label}
                        onClick={() => setSelectedMarkerId(marker.id)}
                      >
                        <Icon aria-hidden="true" />
                        <span>{privateMarker ? "•" : `#${marker.sequence}`}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <TimelineInspector marker={selectedMarker} privacyHidden={privacyHidden} />
        </>
      )}
    </main>
  );
};

const TimelineInspector = ({
  marker,
  privacyHidden,
}: {
  readonly marker: TimelineMarker | null;
  readonly privacyHidden: boolean;
}) => (
  <aside className="timeline-inspector" aria-label="Selected event details">
    {marker === null ? (
      <p>Select an event marker.</p>
    ) : (
      <>
        <div>
          <p className="eyebrow">
            {privacyHidden && marker.secret ? "Private log" : `Log #${marker.sequence}`}
          </p>
          <h2>{privacyHidden && marker.secret ? "Private event" : marker.label}</h2>
        </div>
        <dl>
          <div>
            <dt>Event</dt>
            <dd>{privacyHidden && marker.secret ? "Hidden" : marker.eventType}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{new Date(marker.createdAt).toLocaleTimeString()}</dd>
          </div>
          <div>
            <dt>Visibility</dt>
            <dd>{marker.secret ? "Host secret" : "Game log"}</dd>
          </div>
          {privacyHidden && marker.secret ? null : marker.result === undefined ? null : (
            <div>
              <dt>Result</dt>
              <dd>{marker.result}</dd>
            </div>
          )}
        </dl>
        {privacyHidden && marker.secret ? null : marker.accessibleLabel === marker.label ? null : (
          <p>{marker.accessibleLabel}</p>
        )}
        {privacyHidden && marker.secret ? null : marker.shots === undefined ? null : (
          <ul>
            {marker.shots.map((shot) => (
              <li key={`${shot.shooterSeat}-${shot.targetSeat}`}>
                {shot.shooterLabel} → {shot.targetLabel}
              </li>
            ))}
          </ul>
        )}
      </>
    )}
  </aside>
);
