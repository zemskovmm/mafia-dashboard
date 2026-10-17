import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  ClubStatisticsResponse,
  ClubTournament,
  PlayerStatisticsResponse,
  PlayerStatisticsRow,
  StatisticsFilters,
  StatisticsHistoryGame,
  StatisticsTotals,
} from "@mafia/game-domain";
import { getClubStatistics, getPlayerStatistics, listTournaments } from "../../api/client.js";
import { useMessages, type FeatureI18n } from "../../i18n/I18nProvider.js";
import { gameMessages } from "../../i18n/messages/game.js";
import { statisticsMessages, type StatisticsMessageKey } from "../../i18n/messages/statistics.js";
import { reportError } from "../console/error-console.js";
import { GlassSurface } from "../theme/GlassSurface.js";
import { TournamentPicker } from "../tournaments/TournamentPicker.js";
import "./statistics.css";

export interface StatisticsScreenProps {
  readonly clubId: string;
  readonly isManager: boolean;
  readonly onBack: () => void;
  readonly onOpenTimeline?: (gameId: string) => void;
  readonly onTournamentAssigned?: (gameId: string, tournamentId: string | null) => void;
  readonly onAssignTournament?: (
    gameId: string,
    tournamentId: string | null,
  ) => Promise<string | null>;
  readonly pendingTournamentId?: (gameId: string) => string | null | undefined;
  readonly assignmentRevision?: number;
}

type Text = FeatureI18n<StatisticsMessageKey>;
const roles = ["citizen", "sheriff", "mafia", "don"] as const;
const teams = ["red", "black"] as const;
const groups = ["established", "provisional", "unranked"] as const;
const formatters = (locale: Text["locale"]) => {
  const decimal = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const utcDate = new Intl.DateTimeFormat(locale, { timeZone: "UTC" });
  return {
    number: (value: number | null) => (value === null ? "—" : decimal.format(value)),
    integer: (value: number | null) => (value === null ? "—" : integer.format(Math.round(value))),
    percent: (value: number | null) => (value === null ? "—" : percent.format(value / 100)),
    change: (value: number | null) => {
      if (value === null) return "—";
      // Do not display a negative zero for a rounded, effectively neutral change.
      const rounded = Math.round(value * 10) / 10;
      return `${rounded > 0 ? "+" : ""}${decimal.format(Object.is(rounded, -0) ? 0 : rounded)}`;
    },
    date: (value: string | null) => (value === null ? "—" : utcDate.format(new Date(value))),
  };
};

/** Replacing a club discards all local filters, rows and in-flight generations. */
export const StatisticsScreen = (props: StatisticsScreenProps) => (
  <ClubStatisticsScreen key={props.clubId} {...props} />
);

const ClubStatisticsScreen = (props: StatisticsScreenProps) => {
  const { t } = useMessages(statisticsMessages);
  const dateHelpId = useId();
  const [filters, setFilters] = useState<StatisticsFilters>({});
  const [tournaments, setTournaments] = useState<readonly ClubTournament[]>([]);
  const [tournamentError, setTournamentError] = useState(false);
  const [tournamentRetry, setTournamentRetry] = useState(0);
  const invalidDates =
    filters.from !== undefined && filters.to !== undefined && filters.from > filters.to;
  const update = (field: keyof StatisticsFilters, value: string) =>
    setFilters((current) => {
      const next = { ...current, [field]: value };
      if (value === "") delete next[field];
      return next;
    });
  useEffect(() => {
    let active = true;
    setTournamentError(false);
    void listTournaments(props.clubId)
      .then((next) => {
        if (active) setTournaments(next);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "statistics.tournaments.list" });
        if (active) setTournamentError(true);
      });
    return () => {
      active = false;
    };
  }, [props.clubId, tournamentRetry]);
  const scope = [
    filters.tournamentId === undefined
      ? t("allGames")
      : filters.tournamentId === "none"
        ? t("none")
        : (tournaments.find(({ id }) => id === filters.tournamentId)?.name ??
          t("unnamedTournament", { id: filters.tournamentId })),
    filters.from === undefined ? null : `${t("from")}: ${filters.from}`,
    filters.to === undefined ? null : `${t("to")}: ${filters.to}`,

    filters.team === undefined ? null : t(filters.team),
    filters.role === undefined ? null : t(filters.role),
  ]
    .filter((value) => value !== null)
    .join(" · ");

  return (
    <main className="statistics-screen">
      <header className="statistics-header">
        <button type="button" onClick={props.onBack}>
          {t("back")}
        </button>
        <h1>{t("heading")}</h1>
      </header>
      <GlassSurface
        as="section"
        className="statistics-panel statistics-filters"
        aria-label={t("filters")}
      >
        <label>
          {t("from")}
          <input
            type="date"
            value={filters.from ?? ""}
            aria-invalid={invalidDates}
            aria-describedby={`${dateHelpId}${invalidDates ? ` ${dateHelpId}-error` : ""}`}
            onChange={(event) => update("from", event.currentTarget.value)}
          />
        </label>
        <label>
          {t("to")}
          <input
            type="date"
            value={filters.to ?? ""}
            aria-invalid={invalidDates}
            aria-describedby={`${dateHelpId}${invalidDates ? ` ${dateHelpId}-error` : ""}`}
            onChange={(event) => update("to", event.currentTarget.value)}
          />
        </label>

        <label>
          {t("team")}
          <select
            value={filters.team ?? ""}
            onChange={(event) => update("team", event.currentTarget.value)}
          >
            <option value="">{t("all")}</option>
            {teams.map((team) => (
              <option key={team} value={team}>
                {t(team)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("role")}
          <select
            value={filters.role ?? ""}
            onChange={(event) => update("role", event.currentTarget.value)}
          >
            <option value="">{t("all")}</option>
            {roles.map((role) => (
              <option key={role} value={role}>
                {t(role)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("tournament")}
          <select
            value={filters.tournamentId ?? ""}
            onChange={(event) => update("tournamentId", event.currentTarget.value)}
          >
            <option value="">{t("allGames")}</option>
            <option value="none">{t("none")}</option>
            {tournaments.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setFilters({})}>
          {t("reset")}
        </button>
        <p id={dateHelpId} className="statistics-filter-note">
          {t("dates")}
        </p>
        <p className="statistics-filter-note">{t("scope", { scope })}</p>
        {tournamentError && (
          <div className="statistics-filter-note">
            <p role="alert">{t("tournamentError")}</p>
            <button type="button" onClick={() => setTournamentRetry((current) => current + 1)}>
              {t("retryTournaments")}
            </button>
          </div>
        )}
      </GlassSurface>
      <p className="statistics-note">
        {t("algorithm", { algorithm: "club-team-elo-v1" })} · {t("ratingCaution")}
      </p>
      <details className="statistics-explanation">
        <summary>{t("how")}</summary>
        <p>{t("ratingExplanation")}</p>
        <p>{t("ratingLimits")}</p>
      </details>
      <p className="statistics-note">{t("lifetimeHelp")}</p>
      {invalidDates ? (
        <p id={`${dateHelpId}-error`} role="alert">
          {t("invalidDates")}
        </p>
      ) : (
        <ScopedStatistics
          key={JSON.stringify(filters)}
          {...props}
          filters={filters}
          tournaments={tournaments}
          onTournamentAssigned={(gameId, tournamentId) => {
            props.onTournamentAssigned?.(gameId, tournamentId);
            setTournamentRetry((current) => current + 1);
          }}
        />
      )}
    </main>
  );
};

type SortKey =
  | "nickname"
  | "rank"
  | "rating"
  | "games"
  | "wins"
  | "draws"
  | "losses"
  | "winRate"
  | "redRate"
  | "blackRate"
  | "lastPlayed"
  | "eventChange";
type Sort = { readonly key: SortKey; readonly direction: "ascending" | "descending" };
const sortValue = (row: PlayerStatisticsRow, key: SortKey): string | number | null => {
  switch (key) {
    case "nickname":
      return row.nickname;
    case "rank":
      return row.rating.rank;
    case "rating":
      return row.rating.value === null ? null : Math.round(row.rating.value);
    case "eventChange":
      return row.scopedRatedGames === 0 ? null : row.scopedRatingChange;
    case "redRate":
      return row.teams.red.winRate;
    case "blackRate":
      return row.teams.black.winRate;
    case "lastPlayed":
      return row.lastPlayedAt;
    default:
      return key === "games" || row.totals.outcomeGames > 0 ? row.totals[key] : null;
  }
};

const RateCell = ({ totals, text }: { readonly totals: StatisticsTotals; readonly text: Text }) => (
  <td>
    {formatters(text.locale).percent(totals.winRate)}
    <small>{text.t("observedResults", { count: totals.outcomeGames, total: totals.games })}</small>
  </td>
);

const PerformanceCells = ({
  totals,
  text,
}: {
  readonly totals: StatisticsTotals;
  readonly text: Text;
}) => {
  const f = formatters(text.locale);
  return (
    <>
      <td>{f.integer(totals.games)}</td>
      {(["wins", "draws", "losses"] as const).map((key) => (
        <td key={key}>{f.integer(totals.outcomeGames === 0 ? null : totals[key])}</td>
      ))}
      <RateCell totals={totals} text={text} />
    </>
  );
};

const ScopedStatistics = ({
  filters,
  tournaments,
  ...props
}: StatisticsScreenProps & {
  readonly filters: StatisticsFilters;
  readonly tournaments: readonly ClubTournament[];
}) => {
  const text = useMessages(statisticsMessages);
  const { t: gameText } = useMessages(gameMessages);
  const { t, locale } = text;
  const f = useMemo(() => formatters(locale), [locale]);
  const [response, setResponse] = useState<ClubStatisticsResponse | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "rating", direction: "descending" });
  const [selected, setSelected] = useState<{
    readonly id: string;
    readonly nickname: string;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const detailId = useId();
  useEffect(() => {
    let active = true;
    setError(false);
    setResponse(null);
    void getClubStatistics(props.clubId, filters)
      .then((next) => {
        if (active) setResponse(next);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "statistics.club.read" });
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [props.clubId, filters, revision, props.assignmentRevision]);
  const rows = useMemo(() => {
    const tie = (a: PlayerStatisticsRow, b: PlayerStatisticsRow) =>
      a.nickname.localeCompare(b.nickname, locale) ||
      (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);
    return (response?.players ?? [])
      .filter(({ nickname }) =>
        nickname.toLocaleLowerCase(locale).includes(search.trim().toLocaleLowerCase(locale)),
      )
      .sort((a, b) => {
        if (sort.key === "rating") {
          const group = groups.indexOf(a.rating.status) - groups.indexOf(b.rating.status);
          if (group !== 0) return group;
        }
        const av = sortValue(a, sort.key);
        const bv = sortValue(b, sort.key);
        if (av === null || bv === null) return av === bv ? tie(a, b) : av === null ? 1 : -1;
        const difference =
          typeof av === "string" && typeof bv === "string"
            ? av.localeCompare(bv, locale)
            : Number(av) - Number(bv);
        return difference * (sort.direction === "ascending" ? 1 : -1) || tie(a, b);
      });
  }, [response, locale, search, sort]);
  const eventColumn = filters.tournamentId !== undefined;
  const eventLabel = filters.tournamentId === "none" ? "scopeChange" : "eventChange";
  const columns: readonly SortKey[] = [
    "nickname",
    "rank",
    "rating",
    ...(eventColumn ? ["eventChange" as const] : []),
    "games",
    "wins",
    "draws",
    "losses",
    "winRate",
    "redRate",
    "blackRate",
    "lastPlayed",
  ];
  const reload = () => {
    setResponse(null);
    setError(false);
    setRevision((current) => current + 1);
  };
  const allTournaments = response?.tournaments ?? tournaments;
  const displayName = (nickname: string) => nickname || gameText("player.anonymous");

  const renderRow = (player: PlayerStatisticsRow) => (
    <tr key={player.playerId}>
      <th scope="row">
        <button
          type="button"
          aria-expanded={selected?.id === player.playerId}
          aria-controls={detailId}
          onClick={() => {
            setSelected(
              selected?.id === player.playerId
                ? null
                : { id: player.playerId, nickname: displayName(player.nickname) },
            );
          }}
        >
          {displayName(player.nickname)}
        </button>
      </th>
      <td>{f.integer(player.rating.rank)}</td>
      <td>
        <strong>{f.integer(player.rating.value)}</strong>
        <small>{t(player.rating.status)}</small>
        <small>{t("ratedCount", { count: player.rating.ratedGames })}</small>
        {player.rating.lastChange !== null && (
          <small>{t("lastChange", { change: f.change(player.rating.lastChange) })}</small>
        )}
      </td>
      {eventColumn && (
        <td>
          {player.scopedRatedGames === 0 ? (
            <>
              <span>—</span>
              <small>{t("noEligible")}</small>
            </>
          ) : (
            <>
              <strong>{f.change(player.scopedRatingChange)}</strong>
              <small>{t("eligibleCount", { count: player.scopedRatedGames })}</small>
            </>
          )}
        </td>
      )}
      <PerformanceCells totals={player.totals} text={text} />
      <RateCell totals={player.teams.red} text={text} />
      <RateCell totals={player.teams.black} text={text} />
      <td>{f.date(player.lastPlayedAt)}</td>
      <td>
        <span className="statistics-form">
          {player.recentForm.length === 0
            ? "—"
            : player.recentForm.map((outcome, index) => (
                <span key={index} className={`statistics-form-${outcome}`}>
                  {t(outcome)}
                </span>
              ))}
        </span>
      </td>
    </tr>
  );

  return (
    <>
      {saved && <p role="status">{t("savedTournament")}</p>}
      <GlassSurface as="section" className="statistics-panel">
        <div className="statistics-table-tools">
          <label>
            {t("search")}
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </label>
          <button type="button" onClick={reload}>
            {t("refresh")}
          </button>
        </div>
        <p className="statistics-note">{t("denominator")}</p>
        {eventColumn && <p className="statistics-note">{t("eventHelp")}</p>}
        {response !== null && (
          <div className="statistics-coverage">
            <p>{t("coverage", { count: response.coverage.completedGames })}</p>
            {response.coverage.partialGames > 0 && (
              <p>{t("partial", { count: response.coverage.partialGames })}</p>
            )}
            {response.coverage.unavailableGames > 0 && (
              <p>{t("unavailable", { count: response.coverage.unavailableGames })}</p>
            )}
            {response.coverage.pendingGames > 0 && (
              <p>{t("pending", { count: response.coverage.pendingGames })}</p>
            )}
          </div>
        )}
        {error ? (
          <div>
            <p role="alert">{t("loadError")}</p>
            <button type="button" onClick={reload}>
              {t("retry")}
            </button>
          </div>
        ) : response === null ? (
          <p role="status">{t("loading")}</p>
        ) : response.players.length === 0 ? (
          <p>{t("empty")}</p>
        ) : (
          <>
            <p className="statistics-note">{t("tableHint")}</p>
            <div className="statistics-table-scroll" role="region" aria-label={t("table")}>
              <table className="statistics-table">
                <caption>{t("table")}</caption>
                <thead>
                  <tr>
                    {columns.map((key) => (
                      <th
                        key={key}
                        scope="col"
                        aria-sort={sort.key === key ? sort.direction : undefined}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setSort({
                              key,
                              direction:
                                sort.key === key
                                  ? sort.direction === "descending"
                                    ? "ascending"
                                    : "descending"
                                  : key === "nickname" || key === "rank"
                                    ? "ascending"
                                    : "descending",
                            })
                          }
                        >
                          {t(key === "eventChange" ? eventLabel : key)}
                        </button>
                      </th>
                    ))}
                    <th scope="col">{t("form")}</th>
                  </tr>
                </thead>
                {sort.key === "rating" ? (
                  groups.map((status) => {
                    const members = rows.filter((row) => row.rating.status === status);
                    return members.length === 0 ? null : (
                      <tbody key={status}>
                        <tr className="statistics-group">
                          <th scope="rowgroup" colSpan={columns.length + 1}>
                            {t(status)}
                          </th>
                        </tr>
                        {members.map(renderRow)}
                      </tbody>
                    );
                  })
                ) : (
                  <tbody>{rows.map(renderRow)}</tbody>
                )}
              </table>
            </div>
            {rows.length === 0 && <p>{t("searchEmpty")}</p>}
          </>
        )}
      </GlassSurface>
      {selected !== null && (
        <PlayerDetail
          key={`${selected.id}:${revision}:${props.assignmentRevision ?? 0}`}
          id={detailId}
          clubId={props.clubId}
          playerId={selected.id}
          nickname={selected.nickname}
          filters={filters}
          tournaments={allTournaments}
          isManager={props.isManager}
          onOpenTimeline={props.onOpenTimeline}
          onAssignTournament={props.onAssignTournament}
          pendingTournamentId={props.pendingTournamentId}
          onTournamentAssigned={(gameId, tournamentId) => {
            props.onTournamentAssigned?.(gameId, tournamentId);
            setSaved(true);
            reload();
          }}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}
    </>
  );
};

const BreakdownTable = ({
  caption,
  rows,
  text,
}: {
  readonly caption: string;
  readonly rows: readonly { readonly label: string; readonly totals: StatisticsTotals }[];
  readonly text: Text;
}) => {
  return (
    <div className="statistics-table-scroll" role="region" aria-label={caption}>
      <table className="statistics-table statistics-breakdown">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{text.t("totals")}</th>
            {(["games", "wins", "draws", "losses", "winRate"] as const).map((key) => (
              <th key={key} scope="col">
                {text.t(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, totals }) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <PerformanceCells totals={totals} text={text} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

interface PlayerDetailProps {
  readonly id: string;
  readonly clubId: string;
  readonly playerId: string;
  readonly nickname: string;
  readonly filters: StatisticsFilters;
  readonly tournaments: readonly ClubTournament[];
  readonly isManager: boolean;
  readonly onOpenTimeline?: (gameId: string) => void;
  readonly onTournamentAssigned: (gameId: string, tournamentId: string | null) => void;
  readonly onAssignTournament?: (
    gameId: string,
    tournamentId: string | null,
  ) => Promise<string | null>;
  readonly pendingTournamentId?: (gameId: string) => string | null | undefined;
  readonly onClose: () => void;
}

const PlayerDetail = (props: PlayerDetailProps) => {
  const text = useMessages(statisticsMessages);
  const { t: gameText } = useMessages(gameMessages);
  const { t } = text;
  const f = formatters(text.locale);
  const [response, setResponse] = useState<PlayerStatisticsResponse | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    const generation = ++request.current;
    setResponse(null);
    setError(false);
    setPageError(false);
    setPageBusy(false);
    void getPlayerStatistics(props.playerId, props.clubId, props.filters, { limit: 50 })
      .then((next) => {
        if (request.current === generation) setResponse(next);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "statistics.player.read" });
        if (request.current === generation) setError(true);
      });
    return () => {
      request.current += 1;
    };
  }, [props.playerId, props.clubId, props.filters, retry]);
  const loadMore = async () => {
    if (response?.nextCursor == null || pageBusy) return;
    const generation = ++request.current;
    setPageBusy(true);
    setPageError(false);
    try {
      const next = await getPlayerStatistics(props.playerId, props.clubId, props.filters, {
        cursor: response.nextCursor,
        limit: 50,
      });
      if (request.current !== generation) return;
      setResponse((current) => {
        if (current === null) return current;
        const ids = new Set(current.history.map(({ gameId }) => gameId));
        const added = next.history.filter(({ gameId }) => {
          if (ids.has(gameId)) return false;
          ids.add(gameId);
          return true;
        });
        return { ...next, history: [...current.history, ...added] };
      });
    } catch (error: unknown) {
      reportError(error, { source: "api", context: "statistics.player.history" });
      if (request.current === generation) setPageError(true);
    } finally {
      if (request.current === generation) setPageBusy(false);
    }
  };
  const player = response?.player;
  const nickname =
    player == null ? props.nickname : player.nickname || gameText("player.anonymous");
  const metrics =
    player == null
      ? []
      : [
          [t("fouls"), f.integer(player.foulGames === 0 ? null : player.fouls)],
          [t("foulsPerGame"), f.number(player.foulsPerGame)],
          [t("redCards"), f.integer(player.statusGames === 0 ? null : player.redCards)],
          [t("eliminations"), f.integer(player.statusGames === 0 ? null : player.eliminations)],
          [t("bestResults"), f.integer(player.bestMoveResults)],
          [t("bestHits"), f.integer(player.bestMoveResults === 0 ? null : player.bestMoveHits)],
          [t("bestMean"), f.number(player.bestMoveMean)],
        ];
  return (
    <GlassSurface
      as="section"
      id={props.id}
      className="statistics-panel statistics-player"
      role="region"
      aria-label={t("details", { nickname })}
    >
      <header className="statistics-detail-header">
        <h2>{t("details", { nickname })}</h2>
        <button type="button" onClick={props.onClose}>
          {t("close")}
        </button>
      </header>
      {error ? (
        <>
          <p role="alert">{t("playerError")}</p>
          <button type="button" onClick={() => setRetry((current) => current + 1)}>
            {t("retryPlayer")}
          </button>
        </>
      ) : response === null ? (
        <p role="status">{t("loadingPlayer")}</p>
      ) : player == null ? (
        <p>{t("missingPlayer")}</p>
      ) : (
        <>
          <div className="statistics-rating-summary">
            <strong>
              {t("rating")}: {f.integer(player.rating.value)}
            </strong>
            <span>
              {t(player.rating.status)} · {t("ratedCount", { count: player.rating.ratedGames })} ·{" "}
              {t("rank")}: {f.integer(player.rating.rank)}
            </span>
            <span>{t("lastChange", { change: f.change(player.rating.lastChange) })}</span>
            {props.filters.tournamentId !== undefined && (
              <span>
                {t(props.filters.tournamentId === "none" ? "scopeChange" : "eventChange")}:{" "}
                {player.scopedRatedGames === 0
                  ? t("noEligible")
                  : `${f.change(player.scopedRatingChange)} · ${t("eligibleCount", { count: player.scopedRatedGames })}`}
              </span>
            )}
          </div>
          <BreakdownTable
            text={text}
            caption={t("performance")}
            rows={[{ label: t("totals"), totals: player.totals }]}
          />
          <dl className="statistics-metrics">
            <div>
              <dt>{t("form")}</dt>
              <dd>
                {player.recentForm.length === 0
                  ? "—"
                  : player.recentForm.map((outcome) => t(outcome)).join(" · ")}
              </dd>
            </div>
          </dl>
          <div className="statistics-breakdowns">
            <BreakdownTable
              text={text}
              caption={t("teamBreakdown")}
              rows={teams.map((team) => ({ label: t(team), totals: player.teams[team] }))}
            />
            <BreakdownTable
              text={text}
              caption={t("roleBreakdown")}
              rows={roles.map((role) => ({ label: t(role), totals: player.roles[role] }))}
            />
          </div>
          <h3>{t("discipline")}</h3>
          <dl className="statistics-metrics">
            {metrics.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="statistics-note">{t("bestHelp")}</p>
          <p className="statistics-note">
            {t("observedDiscipline", { count: player.foulGames, statusCount: player.statusGames })}
          </p>
          <h3>{t("hosting")}</h3>
          <dl className="statistics-metrics">
            <div>
              <dt>{t("hosted")}</dt>
              <dd>{f.integer(player.hostedGames)}</dd>
            </div>
            <div>
              <dt>{t("lastHosted")}</dt>
              <dd>{f.date(player.lastHostedAt)}</dd>
            </div>
            <div>
              <dt>{t("lastPlayed")}</dt>
              <dd>{f.date(player.lastPlayedAt)}</dd>
            </div>
          </dl>
          <p className="statistics-note">{t("hostingHelp")}</p>
          <h3>{t("history")}</h3>
          <p role="status">
            {t("historyCount", { shown: response.history.length, total: response.total })}
          </p>
          {response.history.length === 0 ? (
            <p>{t("noHistory")}</p>
          ) : (
            <ol className="statistics-history">
              {response.history.map((game) => (
                <HistoryGame key={game.gameId} game={game} props={props} text={text} />
              ))}
            </ol>
          )}
          {pageError && <p role="alert">{t("pageError")}</p>}
          {response.nextCursor !== null && (
            <button type="button" disabled={pageBusy} onClick={() => void loadMore()}>
              {t(pageBusy ? "loadingMore" : "more")}
            </button>
          )}
        </>
      )}
    </GlassSurface>
  );
};

const HistoryGame = ({
  game,
  props,
  text,
}: {
  readonly game: StatisticsHistoryGame;
  readonly props: PlayerDetailProps;
  readonly text: Text;
}) => {
  const { t } = text;
  const f = formatters(text.locale);
  const [editing, setEditing] = useState(false);

  const tournamentName =
    game.tournamentId === null
      ? t("none")
      : (props.tournaments.find(({ id }) => id === game.tournamentId)?.name ??
        t("unnamedTournament", { id: game.tournamentId }));
  const unratedKey =
    game.unratedReason === "casper"
      ? "casperReason"
      : game.unratedReason === "cancelled"
        ? "cancelledReason"
        : game.unratedReason === "host"
          ? "hostReason"
          : (game.unratedReason ?? "unknownUnrated");
  return (
    <li>
      <article className="statistics-history-game" aria-label={game.name}>
        <header>
          <h4>{game.name}</h4>
          {game.playedAt === null ? (
            <span>{t("unknownDate")}</span>
          ) : (
            <time dateTime={game.playedAt}>{f.date(game.playedAt)}</time>
          )}
        </header>
        <p>
          {game.hasCasper ? `${t("casper")} · ` : ""}
          {tournamentName}
        </p>
        <p>
          {game.isHost ? t("host") : t("participant")}
          {game.participant !== null && (
            <>
              {" "}
              ·{" "}
              {game.participant.seat === null
                ? t("unknownSeat")
                : t("seat", { seat: game.participant.seat })}{" "}
              · {t(game.participant.role ?? "unknownRole")} ·{" "}
              {t(game.participant.team ?? "unknownTeam")} ·{" "}
              {t(game.participant.status ?? "unknownStatus")}
            </>
          )}{" "}
          ·{" "}
          <strong>
            {t(
              game.outcome === "red"
                ? "redWins"
                : game.outcome === "black"
                  ? "blackWins"
                  : (game.outcome ?? "unknownOutcome"),
            )}
          </strong>
        </p>
        {!game.statisticsAvailable && <p>{t("unavailableGame")}</p>}
        {!game.timelineAvailable && <p>{t("timelineUnavailable")}</p>}
        {game.participant !== null && (
          <dl className="statistics-metrics">
            <div>
              <dt>{t("fouls")}</dt>
              <dd>{f.integer(game.participant.fouls)}</dd>
            </div>
            <div>
              <dt>{t("bestMove")}</dt>
              <dd className="statistics-best-move">
                {game.participant.bestMoveHits === null
                  ? t("noBestMove")
                  : f.integer(game.participant.bestMoveHits)}
              </dd>
            </div>
          </dl>
        )}
        <details>
          <summary>{t("summary")}</summary>
          <dl className="statistics-metrics">
            <div>
              <dt>{t("gameIdentity")}</dt>
              <dd>
                <code>{game.gameId}</code>
              </dd>
            </div>

            {game.reason !== null && (
              <div>
                <dt>{t("reason")}</dt>
                <dd>{game.reason}</dd>
              </div>
            )}
          </dl>
          {game.adjudication !== undefined && (
            <div>
              <h5>{t("referee")}</h5>
              <p>
                {t("losingTeam")}: {t(game.adjudication.losingTeam)} ·{" "}
                {t("rule", { rule: game.adjudication.rule })}
              </p>
              <p>{game.adjudication.reason}</p>
              {game.adjudication.offenderSeat !== undefined && (
                <p>{t("offender", { seat: game.adjudication.offenderSeat })}</p>
              )}
              <p>{t(game.adjudication.committeeApproved ? "committee" : "noCommittee")}</p>
            </div>
          )}
        </details>
        {game.ratingChange === null ? (
          <p>{t(unratedKey)}</p>
        ) : (
          <div className="statistics-game-rating">
            <p>
              {t("ratingLine", {
                before: f.number(game.ratingChange.before),
                change: f.change(game.ratingChange.change),
                after: f.number(game.ratingChange.after),
              })}
            </p>
            <p>
              {t("averages", {
                red: f.number(game.ratingChange.redAverage),
                black: f.number(game.ratingChange.blackAverage),
              })}
            </p>
            <p>
              {t("expectation", {
                expected: f.percent(game.ratingChange.expectedScore * 100),
                score: f.number(game.ratingChange.score),
              })}
            </p>
          </div>
        )}
        <div className="statistics-history-actions">
          {props.isManager && game.timelineAvailable && props.onOpenTimeline !== undefined && (
            <button type="button" onClick={() => props.onOpenTimeline?.(game.gameId)}>
              {t("timeline")}
            </button>
          )}
          <button
            type="button"
            disabled={props.onAssignTournament === undefined}
            onClick={() => setEditing(!editing)}
            aria-expanded={editing}
          >
            {t("changeTournament")}
          </button>
        </div>
        {editing && (
          <HistoryTournamentEditor
            key={game.gameId}
            clubId={props.clubId}
            game={game}
            initialTournamentId={props.pendingTournamentId?.(game.gameId)}
            onAssign={props.onAssignTournament!}
            onCancel={() => setEditing(false)}
            onAssigned={props.onTournamentAssigned}
          />
        )}
      </article>
    </li>
  );
};

const HistoryTournamentEditor = ({
  clubId,
  game,
  onCancel,
  onAssigned,
  onAssign,
  initialTournamentId,
}: {
  readonly clubId: string;
  readonly game: StatisticsHistoryGame;
  readonly onCancel: () => void;
  readonly onAssigned: (gameId: string, tournamentId: string | null) => void;
  readonly onAssign: (gameId: string, tournamentId: string | null) => Promise<string | null>;
  readonly initialTournamentId?: string | null;
}) => {
  const { t } = useMessages(statisticsMessages);
  const [value, setValue] = useState(
    initialTournamentId === undefined ? game.tournamentId : initialTournamentId,
  );
  const [valid, setValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const save = async () => {
    if (!valid || busy) return;
    const request = ++generation.current;
    setBusy(true);
    setError(false);
    try {
      // The workspace owns persistence/retry; generation guards presentation only.
      const confirmed = await onAssign(game.gameId, value);
      if (request !== generation.current) return;
      onAssigned(game.gameId, confirmed);
    } catch (error: unknown) {
      reportError(error, { source: "api", context: "statistics.game.tournament.assign" });
      if (request === generation.current) setError(true);
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  return (
    <section
      className="statistics-tournament-editor"
      aria-label={t("editTournament", { game: game.name })}
    >
      <TournamentPicker
        clubId={clubId}
        value={value}
        onChange={setValue}
        disabled={busy}
        onValidityChange={setValid}
      />
      <div className="statistics-history-actions">
        <button type="button" disabled={busy || !valid} onClick={() => void save()}>
          {t(busy ? "savingTournament" : "saveTournament")}
        </button>
        <button type="button" onClick={onCancel}>
          {t("cancelEdit")}
        </button>
      </div>
      {error && <p role="alert">{t("assignmentError")}</p>}
    </section>
  );
};
