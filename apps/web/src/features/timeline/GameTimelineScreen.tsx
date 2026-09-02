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
  type CompletedGameSessionFilters,
  type CompletedGameSessionSummary,
  type RemoteGameSession,
} from "../../api/client.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import {
  timelineConsoleMessages,
  type TimelineConsoleMessageKey,
} from "../../i18n/messages/timeline-console.js";
import { reportError } from "../console/error-console.js";
import { getActiveBranch } from "../game/game-history.js";
import { createSampleGameHistory } from "./sample-game-data.js";
import {
  buildTimeline,
  formatTimelinePhase,
  isVisibleTimelineEvent,
  TIMELINE_REGION_COLORS,
  type TimelineMarker,
  type TimelineModel,
  type TimelineRegion,
  type TimelineRegionKind,
  type TimelineText,
} from "./timeline-model.js";

interface TimelineLoaders {
  readonly listCompleted: (
    clubId: string,
    filters: CompletedGameSessionFilters,
  ) => Promise<readonly CompletedGameSessionSummary[]>;
  readonly getSession: (gameId: string, clubId: string) => Promise<RemoteGameSession>;
}

interface GameTimelineScreenProps {
  readonly clubId: string;
  readonly onBack: () => void;
  readonly players?: readonly { readonly id: string; readonly nickname: string }[];
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
  listCompleted: (clubId, filters) => listCompletedGameSessions(clubId, filters),
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

const legacyRegion = (
  phase: string,
  day: number,
  text: TimelineText,
): LegacyRegionIdentity | null => {
  if (phase === "finished") return null;
  if (day === 0) {
    return {
      id: "initial-night",
      kind: "initial-night",
      label: text.t("Initial night"),
      color: TIMELINE_REGION_COLORS.initialNight,
      day,
    };
  }
  if (phase.startsWith("night-")) {
    return {
      id: `night-${day}`,
      kind: "night",
      label: text.t("Night {day}", { day }),
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
      label: text.t("Voting {day}", { day }),
      color: TIMELINE_REGION_COLORS.voting,
      day,
    };
  }
  return {
    id: `day-${day}`,
    kind: "day",
    label: text.t("Day {day}", { day }),
    color: TIMELINE_REGION_COLORS.day,
    day,
  };
};

const legacyPlayerLabel = (game: GameState | null, value: unknown, text: TimelineText): string => {
  if (typeof value !== "number" || !Number.isInteger(value)) return text.t("Unknown player");
  const player = game?.players.find(({ seat }) => seat === value);
  const name = typeof player?.name === "string" ? player.name.trim() : "";
  return name.length > 0 ? name : text.t("Seat {seat}", { seat: value });
};

const legacyMarker = (
  raw: LegacyLogEntry,
  game: GameState | null,
  frameIndex: number,
  regionId: string | null,
  text: TimelineText,
): TimelineMarker => {
  let kind: TimelineMarker["kind"] = "generic";
  let icon = "circle";
  let label = text.t("Generic event", {
    event: raw.type.replace(/[.-]+/g, " ").trim() || "Game event",
  });
  let ariaLabel = label;
  switch (raw.type) {
    case "phase.changed":
      if (typeof raw.payload.to === "string") {
        kind = "phase";
        icon = "arrow-right";
        label =
          raw.payload.to === "night-mafia"
            ? text.t("Night")
            : formatTimelinePhase(raw.payload.to, text);
        ariaLabel = label;
      }
      break;
    case "turn.completed":
      if (typeof raw.payload.seat === "number") {
        const player = legacyPlayerLabel(game, raw.payload.seat, text);
        kind = "turn";
        icon = "message-circle";
        label = text.t("{player} completed turn", { player });
        ariaLabel = text.t("{player} completed their turn", { player });
      }
      break;
    case "player.nominated":
      if (
        typeof raw.payload.nominatorSeat === "number" &&
        typeof raw.payload.candidateSeat === "number"
      ) {
        const nominator = legacyPlayerLabel(game, raw.payload.nominatorSeat, text);
        const candidate = legacyPlayerLabel(game, raw.payload.candidateSeat, text);
        kind = "nomination";
        icon = "user-plus";
        label = text.t("{candidate} set for voting", { candidate });
        ariaLabel = text.t("Nomination: {nominator} set {candidate} for voting", {
          nominator,
          candidate,
        });
      }
      break;
    case "player.red-carded":
      if (typeof raw.payload.seat === "number") {
        const player = legacyPlayerLabel(game, raw.payload.seat, text);
        kind = "red-card";
        icon = "badge-x";
        label = text.t("{player} red-carded", { player });
        ariaLabel = text.t("Red card: {player}", { player });
      }
      break;
    case "don.checked":
    case "sheriff.checked":
      if (typeof raw.payload.targetSeat === "number" && typeof raw.payload.match === "boolean") {
        kind = raw.type === "don.checked" ? "don-check" : "sheriff-check";
        icon = raw.type === "don.checked" ? "eye" : "shield-search";
        label =
          raw.type === "don.checked"
            ? text.t("Don checked {target}: {result}", {
                target: legacyPlayerLabel(game, raw.payload.targetSeat, text),
                result: text.t(raw.payload.match ? "Sheriff" : "Not Sheriff"),
              })
            : text.t("Sheriff checked {target}: {result}", {
                target: legacyPlayerLabel(game, raw.payload.targetSeat, text),
                result: text.t(raw.payload.match ? "Mafia" : "Not Mafia"),
              });
        ariaLabel = label;
      }
      break;
    case "don.check-skipped":
    case "sheriff.check-skipped":
      kind = "check-skipped";
      icon = "skip-forward";
      label = text.t(
        raw.type === "don.check-skipped" ? "Don check skipped" : "Sheriff check skipped",
      );
      ariaLabel = label;
      break;
    case "voting.skipped":
      kind = "voting-cancelled";
      icon = "ban";
      label = text.t("Voting skipped");
      ariaLabel = text.t("Voting skipped by the host");
      break;
    case "game.completed":
      if (raw.payload.winner === "red" || raw.payload.winner === "black") {
        const winner = text.t("{team} team won", {
          team: text.t(raw.payload.winner === "red" ? "Red team" : "Black team"),
        });
        kind = "completion";
        icon = "trophy";
        label = winner;
        ariaLabel = text.t("Game completed: {team}", { team: winner });
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

const legacyTimeline = (session: RemoteGameSession, text: TimelineText): TimelineModel => {
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
        ? legacyRegion("night-best-move", Math.max(1, day - 1), text)
        : legacyRegion(requestedPhase, day, text);
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
    markers.push(legacyMarker(raw, finalGame, frameIndex, identity?.id ?? null, text));
  }
  return { regions, markers, frames: [] };
};

const replaySession = (
  session: RemoteGameSession,
  text: TimelineText,
): { readonly timeline: TimelineModel; readonly legacy: boolean } => {
  const baseline = session.state.initialGame as InitialGameBaseline | null | undefined;
  const entries = session.state.events as readonly GameLogEntry[] | undefined;
  const headEventId = session.state.headEventId;
  if (entries?.some(({ gameId }) => gameId !== session.gameId) === true) {
    throw new Error("Loaded timeline contains events from another game");
  }
  if (baseline == null || entries === undefined || headEventId == null) {
    const timeline = legacyTimeline(session, text);
    if (timeline.markers.length === 0) throw new Error("This game has no timeline markers");
    return { timeline, legacy: true };
  }
  return {
    timeline: buildTimeline(
      replayGameLog(baseline, getActiveBranch(entries, headEventId)).frames,
      text,
    ),
    legacy: false,
  };
};

export const GameTimelineScreen = (props: GameTimelineScreenProps) => (
  <TenantGameTimelineScreen key={props.clubId} {...props} />
);

const TenantGameTimelineScreen = ({
  clubId,
  onBack,
  players = [],
  loaders = defaultLoaders,
  showDevelopmentTools = false,
  currentHistory,
  onPreviewCurrentEvent,
  onResetCurrentEvent,
}: GameTimelineScreenProps) => {
  const i18n = useMessages(timelineConsoleMessages);
  const loadCurrentHistory = (): LoadedHistory | null => {
    if (currentHistory === undefined) return null;
    const timeline = buildTimeline(currentHistory.frames, i18n);
    const headSequence = currentHistory.frames.find(
      ({ entry }) => entry.id === currentHistory.headEventId,
    )?.entry.sequence;
    const semanticHead = timeline.markers.reduce<(typeof timeline.markers)[number] | null>(
      (latest, marker) =>
        headSequence !== undefined && marker.sequence <= headSequence ? marker : latest,
      null,
    );
    return {
      label: i18n.t("{label} · Checkpoint #{sequence}", {
        label: currentHistory.label,
        sequence: semanticHead?.sequence ?? headSequence ?? "—",
      }),
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
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [outcome, setOutcome] = useState("");
  const listRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);

  const resetHistoricalSelection = () => {
    sessionRequestRef.current += 1;
    setSelectedGameId(currentHistory === undefined ? "" : "current");
    setHistory(loadCurrentHistory());
    setSelectedMarkerId(null);
    setLoadingGameName(null);
  };

  useEffect(() => {
    const request = listRequestRef.current + 1;
    listRequestRef.current = request;
    setError(null);
    setSummaries(null);
    const filters: CompletedGameSessionFilters = {
      ...(from === "" ? {} : { from }),
      ...(to === "" ? {} : { to }),
      ...(playerId === "" ? {} : { playerId }),
      ...(outcome === ""
        ? {}
        : { outcome: outcome as NonNullable<CompletedGameSessionFilters["outcome"]> }),
    };
    void loaders
      .listCompleted(clubId, filters)
      .then((next) => {
        if (listRequestRef.current === request) setSummaries(next);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "timeline.completed-games.list" });
        if (listRequestRef.current === request) {
          setSummaries([]);
          setError(i18n.t("Completed games are temporarily unavailable."));
        }
      });
    return () => {
      if (listRequestRef.current === request) listRequestRef.current += 1;
    };
  }, [clubId, from, i18n, loaders, outcome, playerId, to]);

  useEffect(() => {
    if (selectedGameId === "current") setHistory(loadCurrentHistory());
  }, [currentHistory?.headEventId, currentHistory?.label, i18n, selectedGameId]);

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
      timeline: buildTimeline(sample.frames, i18n),
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
        const replayed = replaySession(session, i18n);
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
          setError(i18n.t("Unable to load {name}.", { name: summary.name }));
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
    <main className="timeline-screen" aria-label={i18n.t("Game timeline")}>
      <header className="timeline-header">
        <button type="button" className="timeline-back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" /> {i18n.t("Back")}
        </button>
        <div>
          <p className="eyebrow">
            {history?.current
              ? i18n.t("Current game · Semantic checkpoints")
              : i18n.t("Past games · Read only")}
          </p>
          <h1>{i18n.t("Game timeline")}</h1>
        </div>
        <label>
          <span>{i18n.t("Completed game")}</span>
          <select
            aria-label={i18n.t("Completed game")}
            value={selectedGameId}
            onChange={(event) => selectCompletedGame(event.currentTarget.value)}
          >
            {currentHistory === undefined ? null : (
              <option value="current">{i18n.t("Current game")}</option>
            )}
            <option value="">{i18n.t("Choose a completed game")}</option>
            {(summaries ?? []).map((summary) => (
              <option key={summary.gameId} value={summary.gameId}>
                {summary.name} ·{" "}
                {summary.outcome === "red"
                  ? i18n.t("Citizens")
                  : summary.outcome === "black"
                    ? i18n.t("Mafia")
                    : i18n.t(summary.outcome === "draw" ? "Game drawn" : "Game cancelled")}
              </option>
            ))}
          </select>
        </label>
        {showDevelopmentTools ? (
          <button type="button" onClick={showSample}>
            {i18n.t("Generate sample game data")}
          </button>
        ) : null}
      </header>

      <section className="timeline-filters" aria-label={i18n.t("History filters")}>
        <label>
          <span>{i18n.t("From date")}</span>
          <input
            type="date"
            aria-label={i18n.t("From date")}
            value={from}
            onChange={(event) => {
              resetHistoricalSelection();
              setFrom(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          <span>{i18n.t("To date")}</span>
          <input
            type="date"
            aria-label={i18n.t("To date")}
            value={to}
            onChange={(event) => {
              resetHistoricalSelection();
              setTo(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          <span>{i18n.t("Player")}</span>
          <select
            aria-label={i18n.t("Player")}
            value={playerId}
            onChange={(event) => {
              resetHistoricalSelection();
              setPlayerId(event.currentTarget.value);
            }}
          >
            <option value="">{i18n.t("All players")}</option>
            {players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.nickname}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{i18n.t("Result")}</span>
          <select
            aria-label={i18n.t("Result")}
            value={outcome}
            onChange={(event) => {
              resetHistoricalSelection();
              setOutcome(event.currentTarget.value);
            }}
          >
            <option value="">{i18n.t("All results")}</option>
            <option value="red">{i18n.t("Citizens won")}</option>
            <option value="black">{i18n.t("Mafia won")}</option>
            <option value="draw">{i18n.t("Game drawn")}</option>
            <option value="cancelled">{i18n.t("Game cancelled")}</option>
          </select>
        </label>
        <button
          type="button"
          disabled={from === "" && to === "" && playerId === "" && outcome === ""}
          onClick={() => {
            resetHistoricalSelection();
            setFrom("");
            setTo("");
            setPlayerId("");
            setOutcome("");
          }}
        >
          {i18n.t("Clear filters")}
        </button>
      </section>

      {error === null ? null : (
        <p className="timeline-error" role="alert">
          {error}
        </p>
      )}
      {summaries === null && history === null ? (
        <p className="timeline-loading">{i18n.t("Loading completed games…")}</p>
      ) : null}
      {loadingGameName === null || history !== null ? null : (
        <p className="timeline-loading">{i18n.t("Loading {name}…", { name: loadingGameName })}</p>
      )}
      {summaries?.length === 0 && history === null && error === null ? (
        <p className="timeline-empty">{i18n.t("No completed games yet.")}</p>
      ) : null}

      {history === null || timeline === null ? null : (
        <>
          <section className="timeline-editor" aria-label={i18n.t("Game event sequence")}>
            <div className="timeline-meta">
              <strong>{history.label}</strong>
              {history.sample ? (
                <span className="timeline-sample-badge">{i18n.t("Sample · not saved")}</span>
              ) : null}
              {history.legacy ? (
                <span className="timeline-legacy-badge">
                  {i18n.t("Legacy log · state preview unavailable")}
                </span>
              ) : null}
              {history.summary === null ? null : (
                <span>
                  {history.summary.hostName ?? i18n.t("Unknown host")} ·{" "}
                  {i18n.formatDateTime(history.summary.playedAt)} · {history.summary.rulesetId} v
                  {history.summary.rulesetVersion}
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
                      <small>{i18n.t("accepted events", { count: region.frameCount })}</small>
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
            text={i18n}
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
  text,
  onPreview,
  onReset,
}: {
  readonly marker: TimelineMarker | null;
  readonly current: boolean;
  readonly currentHeadEventId: string | null;
  readonly text: TimelineText;
  readonly onPreview?: (eventId: string) => void;
  readonly onReset?: (eventId: string) => void;
}) => {
  const resultMessageKeys: Readonly<Record<string, TimelineConsoleMessageKey>> = {
    winner: "Winner",
    tie: "Tie",
    "host-skipped": "Skipped by host",
    eliminated: "Eliminated",
    kept: "Kept",
    kill: "Kill",
    "no-effect": "No effect",
    miss: "Miss",
  };
  const resultLabel = (result: string): string => {
    if (/^-?\d+$/.test(result)) return result;
    return text.t(resultMessageKeys[result] ?? "Unknown result ({value})", { value: result });
  };
  return (
    <aside className="timeline-inspector" aria-label={text.t("Selected event details")}>
      {marker === null ? (
        <p>{text.t("Select an event marker.")}</p>
      ) : (
        <>
          <div>
            <p className="eyebrow">{text.t("Event #{sequence}", { sequence: marker.sequence })}</p>
            <h2>{marker.label}</h2>
          </div>
          <dl>
            <div>
              <dt>{text.t("Event")}</dt>
              <dd>{marker.label}</dd>
            </div>
            <div>
              <dt>{text.t("Time")}</dt>
              <dd>{text.formatTime(marker.createdAt)}</dd>
            </div>
            {marker.result === undefined ? null : (
              <div>
                <dt>{text.t("Result")}</dt>
                <dd>{resultLabel(marker.result)}</dd>
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
                {text.t("Preview timeline checkpoint")}
              </button>
              <button
                type="button"
                className="danger-action"
                disabled={marker.eventId === currentHeadEventId}
                onClick={() => onReset(marker.eventId)}
              >
                {text.t("Reset game to timeline checkpoint")}
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  );
};
