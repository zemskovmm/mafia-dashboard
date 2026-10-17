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
  CASPER_NAME,
  CASPER_PLAYER_ID,
  assertGameLogEntry,
  replayGameLog,
  type GameLogEntry,
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
import { buildTimeline, type TimelineMarker, type TimelineText } from "./timeline-model.js";
import { completedRecordFacts, type CompletedRecordFacts } from "./completed-record.js";
import { CompletedRecordDetails } from "./CompletedRecordDetails.js";

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
  readonly initialGameId?: string;
  readonly backLabel?: string;
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
  readonly frames: readonly ReplayFrame[] | null;

  readonly facts: CompletedRecordFacts | null;
  readonly sample: boolean;
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

const replaySession = (session: RemoteGameSession): readonly ReplayFrame[] | null => {
  const baseline = session.state.initialGame as InitialGameBaseline | null | undefined;
  const entries = session.state.events as readonly GameLogEntry[] | undefined;
  const headEventId = session.state.headEventId;
  if (
    baseline == null &&
    headEventId == null &&
    (entries == null || (Array.isArray(entries) && entries.length === 0))
  )
    return null;
  if (!Array.isArray(entries) || entries.length === 0 || typeof headEventId !== "string") {
    throw new Error("Loaded timeline has incomplete canonical replay data");
  }
  for (const entry of entries) assertGameLogEntry(entry);
  if (entries?.some(({ gameId }) => gameId !== session.gameId) === true) {
    throw new Error("Loaded timeline contains events from another game");
  }
  if (baseline == null || entries === undefined || headEventId == null) {
    throw new Error("Loaded timeline is missing canonical replay data");
  }
  return replayGameLog(baseline, getActiveBranch(entries, headEventId)).frames;
};

export const GameTimelineScreen = (props: GameTimelineScreenProps) => (
  <TenantGameTimelineScreen key={`${props.clubId}:${props.initialGameId ?? ""}`} {...props} />
);

const TenantGameTimelineScreen = ({
  clubId,
  onBack,
  initialGameId,
  backLabel,
  players = [],
  loaders = defaultLoaders,
  showDevelopmentTools = false,
  currentHistory,
  onPreviewCurrentEvent,
  onResetCurrentEvent,
}: GameTimelineScreenProps) => {
  const i18n = useMessages(timelineConsoleMessages);
  const timelineText: TimelineText = {
    ...i18n,
    playerName: (id) =>
      id === CASPER_PLAYER_ID
        ? CASPER_NAME
        : players.find((profile) => profile.id === id)?.nickname,
  };
  const loadCurrentHistory = (): LoadedHistory | null => {
    if (currentHistory === undefined) return null;
    const timeline = buildTimeline(currentHistory.frames, timelineText);
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
      frames: currentHistory.frames,
      sample: false,
      facts: null,
      current: true,
      headEventId: semanticHead?.eventId ?? currentHistory.headEventId,
    };
  };
  const [summaries, setSummaries] = useState<readonly CompletedGameSessionSummary[] | null>(null);
  const [selectedGameId, setSelectedGameId] = useState(
    initialGameId ?? (currentHistory === undefined ? "" : "current"),
  );
  const [history, setHistory] = useState<LoadedHistory | null>(() =>
    initialGameId === undefined ? loadCurrentHistory() : null,
  );
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [loadingGameName, setLoadingGameName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [outcome, setOutcome] = useState("");
  const listRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);
  const invalidDateRange = from !== "" && to !== "" && from > to;

  const resetHistoricalSelection = () => {
    listRequestRef.current += 1;
    sessionRequestRef.current += 1;
    setSelectedGameId(currentHistory === undefined ? "" : "current");
    setHistory(loadCurrentHistory());
    setSelectedMarkerId(null);
    setLoadingGameName(null);
  };

  useEffect(() => {
    const request = listRequestRef.current + 1;
    listRequestRef.current = request;
    if (invalidDateRange) {
      setError(null);
      setSummaries([]);
      return;
    }
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
  }, [clubId, from, i18n, invalidDateRange, loaders, outcome, playerId, to]);

  useEffect(() => {
    if (selectedGameId === "current") setHistory(loadCurrentHistory());
  }, [currentHistory?.headEventId, currentHistory?.label, i18n, selectedGameId]);

  // Reproject resolved profile names on every directory refresh; replay frames remain canonical.
  const timeline = history?.frames == null ? null : buildTimeline(history.frames, timelineText);
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
      frames: sample.frames,
      sample: true,
      facts: null,
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
    if (summary === undefined && gameId !== initialGameId) return;
    setLoadingGameName(summary?.name ?? gameId);
    void loaders
      .getSession(gameId, clubId)
      .then((session) => {
        if (sessionRequestRef.current !== request) return;
        if (session.gameId !== gameId || session.status !== "completed") {
          throw new Error("Loaded session does not match the selected completed game");
        }
        const replayed = replaySession(session);
        setHistory({
          label: session.name,
          frames: replayed,

          facts: completedRecordFacts(session, summary ?? null),
          sample: false,
          current: false,
          headEventId: null,
        });
        setLoadingGameName(null);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "timeline.completed-game.load" });
        if (sessionRequestRef.current === request) {
          setLoadingGameName(null);
          setError(i18n.t("Unable to load {name}.", { name: summary?.name ?? gameId }));
        }
      });
  };

  useEffect(() => {
    if (initialGameId !== undefined) selectCompletedGame(initialGameId);
    return () => {
      sessionRequestRef.current += 1;
    };
    // The tenant/target key resets requests; locale changes only reproject labels.
  }, [clubId, initialGameId]);

  const columnCount = Math.max(1, timeline?.markers.length ?? 1);
  const gridStyle = {
    gridTemplateColumns: `repeat(${columnCount}, minmax(64px, 76px))`,
    minWidth: `${columnCount * 68}px`,
  } satisfies CSSProperties;
  const trackStyle = { minWidth: `${columnCount * 68 + 24}px` } satisfies CSSProperties;

  return (
    <main
      className="timeline-screen"
      aria-label={i18n.t("Game timeline")}
      style={
        history?.facts == null
          ? undefined
          : {
              gridTemplateRows:
                timeline === null
                  ? "auto auto auto auto"
                  : "auto auto auto minmax(300px, 1fr) minmax(220px, max-content)",
              overflowY: "auto",
              alignContent: "start",
            }
      }
    >
      <header className="timeline-header">
        <button type="button" className="timeline-back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" /> {backLabel ?? i18n.t("Back")}
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
            {initialGameId !== undefined &&
            !summaries?.some(({ gameId }) => gameId === initialGameId) ? (
              <option value={initialGameId}>{history?.label ?? initialGameId}</option>
            ) : null}
            {(summaries ?? []).map((summary) => (
              <option key={summary.gameId} value={summary.gameId}>
                {summary.name} ·{" "}
                {summary.outcome === "red"
                  ? i18n.t("Citizens")
                  : summary.outcome === "black"
                    ? i18n.t("Mafia")
                    : i18n.t(
                        summary.outcome === "draw"
                          ? "Game drawn"
                          : summary.outcome === "cancelled"
                            ? "Game cancelled"
                            : "Unknown outcome",
                      )}
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
            aria-invalid={invalidDateRange}
            max={to === "" ? undefined : to}
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
            aria-invalid={invalidDateRange}
            min={from === "" ? undefined : from}
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
        {invalidDateRange ? (
          <p className="timeline-filter-error" role="alert">
            {i18n.t("From date must not be after To date.")}
          </p>
        ) : null}
        <p style={{ gridColumn: "1 / -1", margin: 0, color: "var(--muted)", fontSize: ".75rem" }}>
          {i18n.t("Date filters include only games with a known played date.")}
        </p>
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
      {summaries?.length === 0 && history === null && error === null && !invalidDateRange ? (
        <p className="timeline-empty">{i18n.t("No completed games yet.")}</p>
      ) : null}

      {history?.facts == null ? null : (
        <CompletedRecordDetails
          facts={history.facts}
          text={timelineText}
          playerName={(id) => timelineText.playerName?.(id) ?? i18n.t("Anonymous player")}
          formatDateTime={i18n.formatDateTime}
        />
      )}
      {history === null ? null : (
        <>
          <section
            className="timeline-editor"
            aria-label={i18n.t("Game event sequence")}
            style={
              timeline === null
                ? { display: "block", overflow: "visible", paddingBottom: 18 }
                : undefined
            }
          >
            <div className="timeline-meta">
              <strong>{history.label}</strong>
              {history.sample ? (
                <span className="timeline-sample-badge">{i18n.t("Sample · not saved")}</span>
              ) : null}
              {history.facts === null ? null : (
                <span>
                  {history.facts.hostPlayerId === null
                    ? i18n.t("Unknown host")
                    : (players?.find(({ id }) => id === history.facts?.hostPlayerId)?.nickname ??
                      i18n.t("Anonymous player"))}{" "}
                  ·{" "}
                  {history.facts.playedAt === null
                    ? i18n.t("Unknown date")
                    : i18n.formatDateTime(history.facts.playedAt)}
                </span>
              )}
            </div>
            {timeline === null ? (
              <p>{i18n.t("Timeline detail is unavailable for this game.")}</p>
            ) : (
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
            )}
          </section>

          {timeline === null ? null : (
            <TimelineInspector
              marker={selectedMarker}
              current={history.current}
              currentHeadEventId={history.headEventId}
              text={i18n}
              onPreview={onPreviewCurrentEvent}
              onReset={onResetCurrentEvent}
            />
          )}
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
    "eliminate-all-skipped": "Collective lift prohibited",
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
              {marker.shots.map((shot, index) => (
                <li key={`${index}-${shot.shooterSeat}-${shot.targetSeat}`}>
                  {shot.occurrence === undefined
                    ? `${shot.shooterLabel} → ${shot.targetLabel}`
                    : text.t(
                        "Observed shot {number}: #{shooterSeat} {shooter} → #{targetSeat} {target}",
                        {
                          number: shot.occurrence,
                          shooterSeat: shot.shooterSeat,
                          shooter: shot.shooterLabel,
                          targetSeat: shot.targetSeat,
                          target: shot.targetLabel,
                        },
                      )}
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
