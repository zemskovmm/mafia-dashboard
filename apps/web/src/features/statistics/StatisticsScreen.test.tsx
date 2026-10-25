import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClubStatisticsResponse,
  PlayerStatisticsResponse,
  PlayerStatisticsRow,
  StatisticsHistoryGame,
  StatisticsTotals,
} from "@mafia/game-domain";
import {
  assignGameTournament,
  getClubStatistics,
  getPlayerStatistics,
  listTournaments,
} from "../../api/client.js";
import type * as ApiClient from "../../api/client.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { StatisticsScreen } from "./StatisticsScreen.js";

vi.mock("../../api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  getClubStatistics: vi.fn(),
  getPlayerStatistics: vi.fn(),
  listTournaments: vi.fn(),
  createTournament: vi.fn(),
  assignGameTournament: vi.fn(),
}));
const totals = (changes: Partial<StatisticsTotals> = {}): StatisticsTotals => ({
  games: 3,
  outcomeGames: changes.games ?? 3,
  wins: 1,
  draws: 1,
  losses: 1,
  winRate: 100 / 3,
  ...changes,
});
const row = (changes: Partial<PlayerStatisticsRow> = {}): PlayerStatisticsRow => ({
  playerId: "alpha",
  nickname: "Alpha",
  totals: totals(),
  teams: {
    red: totals(),
    black: totals({ games: 0, wins: 0, draws: 0, losses: 0, winRate: null }),
  },
  roles: { citizen: totals(), sheriff: totals(), mafia: totals(), don: totals() },
  fouls: 4,
  foulGames: 3,
  foulsPerGame: 4 / 3,
  statusGames: 3,
  redCards: 1,
  eliminations: 2,
  bestMoveResults: 2,
  bestMoveHits: 3,
  bestMoveMean: 1.5,
  hostedGames: 2,
  lastHostedAt: "2026-10-12T12:00:00Z",
  lastPlayedAt: "2026-10-14T12:00:00Z",
  recentForm: ["win", "draw", "loss"],
  rating: {
    algorithm: "club-team-elo-v1",
    value: 1600.4,
    ratedGames: 12,
    status: "established",
    rank: 2,
    lastChange: 16.04,
  },
  scopedRatingChange: 0,
  scopedRatedGames: 1,
  ...changes,
});
const game = (changes: Partial<StatisticsHistoryGame> = {}): StatisticsHistoryGame => ({
  gameId: "game-a",
  name: "Evening game",
  playedAt: "2026-10-14T12:00:00Z",

  hasCasper: false,
  outcome: "red",
  reason: "Saved outcome",
  tournamentId: "event-a",
  hostPlayerId: "host",
  isHost: false,
  statisticsAvailable: true,
  timelineAvailable: true,
  participant: {
    playerId: "alpha",
    seat: 1,
    role: "citizen",
    team: "red",
    status: "eliminated",
    fouls: 2,
    bestMoveHits: 0,
  },
  unratedReason: null,
  ratingChange: {
    before: 1584.36,
    after: 1600.4,
    change: 16.04,
    redAverage: 1500,
    blackAverage: 1501,
    expectedScore: 0.499,
    score: 1,
  },
  ...changes,
});
const club = (players = [row()]): ClubStatisticsResponse => ({
  players,
  tournaments: [{ id: "event-a", name: "Autumn cup" }],
  coverage: { completedGames: 3, partialGames: 1, unavailableGames: 1, pendingGames: 2 },
  algorithm: "club-team-elo-v1",
});
const detail = (changes: Partial<PlayerStatisticsResponse> = {}): PlayerStatisticsResponse => ({
  player: row(),
  history: [game()],
  nextCursor: null,
  total: 1,
  ...changes,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const renderScreen = (props: Partial<Parameters<typeof StatisticsScreen>[0]> = {}) =>
  render(
    <StatisticsScreen
      clubId="club-a"
      isManager={false}
      onBack={vi.fn()}
      onAssignTournament={(gameId, value) => assignGameTournament(gameId, value, "club-a")}
      {...props}
    />,
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getClubStatistics).mockResolvedValue(club());
  vi.mocked(getPlayerStatistics).mockResolvedValue(detail());
  vi.mocked(listTournaments).mockResolvedValue(club().tournaments);
  vi.mocked(assignGameTournament).mockResolvedValue("event-a");
});

describe("StatisticsScreen", () => {
  it("offers notebook import to a regular club member without manager controls", async () => {
    const onImport = vi.fn();
    renderScreen({ onImport });
    await userEvent.setup().click(screen.getByRole("button", { name: "Import paper game" }));
    expect(onImport).toHaveBeenCalledOnce();
  });

  it("uses one current record view without edition controls or historical engine labels", async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("button", { name: "Alpha" });
    expect(screen.queryByRole("combobox", { name: "Rules edition" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Alpha" }));
    const history = await screen.findByRole("article", { name: "Evening game" });
    expect(within(history).queryByText(/Federation|Legacy|Rules edition/)).not.toBeInTheDocument();
    expect(history).not.toHaveTextContent("mafgame-2026-07-01");
  });

  it.each(["en", "ru"] as const)(
    "renders partial observations and unavailable timelines honestly in %s",
    async (locale) => {
      const user = userEvent.setup();
      const partial = row({
        totals: totals({ outcomeGames: 1, wins: 1, draws: 0, losses: 0, winRate: 100 }),
        fouls: 0,
        foulGames: 0,
        foulsPerGame: null,
        statusGames: 0,
        redCards: 0,
        eliminations: 0,
        bestMoveResults: 0,
        bestMoveHits: 0,
        bestMoveMean: null,
      });
      vi.mocked(getClubStatistics).mockResolvedValue(club([partial]));
      vi.mocked(getPlayerStatistics).mockResolvedValue(
        detail({
          player: partial,
          history: [
            game({
              playedAt: null,
              outcome: null,
              hasCasper: null,
              timelineAvailable: false,
              ratingChange: null,
              unratedReason: "incomplete-results",
              participant: {
                playerId: "alpha",
                seat: null,
                role: null,
                team: null,
                status: null,
                fouls: null,
                bestMoveHits: null,
              },
            }),
          ],
        }),
      );
      render(
        <I18nProvider locale={locale}>
          <StatisticsScreen clubId="club-a" isManager onBack={vi.fn()} onOpenTimeline={vi.fn()} />
        </I18nProvider>,
      );
      await user.click(await screen.findByRole("button", { name: "Alpha" }));
      const details = await screen.findByRole("region", {
        name: locale === "en" ? "Player details: Alpha" : "Данные игрока: Alpha",
      });
      const history = within(details).getByRole("article", { name: "Evening game" });
      const labels =
        locale === "en"
          ? ["Fouls", "Final red cards", "Final eliminations", "Best Move hits"]
          : ["Фолы", "Итоговые красные карточки", "Итоговые удаления", "Попадания в «Лучшем ходе»"];
      for (const label of labels) {
        expect(
          within(details).getAllByText(label, { selector: "dt" })[0]!.nextElementSibling,
        ).toHaveTextContent("—");
      }
      expect(
        within(history).getByText(locale === "en" ? "Date not recorded" : "Дата не записана"),
      ).toBeInTheDocument();
      expect(
        within(history).getByText(locale === "en" ? "Outcome not recorded" : "Исход не записан"),
      ).toBeInTheDocument();
      expect(
        within(history).getByText(
          locale === "en" ? "Timeline not recorded" : "Хронология не записана",
        ),
      ).toBeInTheDocument();
      expect(
        within(history).queryByRole("button", {
          name: locale === "en" ? "Open timeline" : "Открыть хронологию",
        }),
      ).not.toBeInTheDocument();
      expect(history.querySelector("time")).toBeNull();
      expect(history).not.toHaveTextContent(/null|undefined|Invalid Date/);
      expect(
        screen.getAllByText(
          locale === "en" ? "Results recorded for 1 of 3 games" : "Исход записан для 1 из 3 игр",
        ).length,
      ).toBeGreaterThan(0);
      expect(
        screen.getByText(
          locale === "en" ? /1 completed game has partial facts/ : /Игр с неполными данными: 1/,
        ),
      ).toBeInTheDocument();
    },
  );

  it("keeps observed zero distinct from unknown discipline and Best Move totals", async () => {
    const user = userEvent.setup();
    const observedZero = row({
      fouls: 0,
      foulGames: 1,
      foulsPerGame: 0,
      statusGames: 1,
      redCards: 0,
      eliminations: 0,
      bestMoveResults: 1,
      bestMoveHits: 0,
      bestMoveMean: 0,
    });
    vi.mocked(getPlayerStatistics).mockResolvedValue(detail({ player: observedZero, history: [] }));
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    const details = await screen.findByRole("region", { name: "Player details: Alpha" });
    for (const label of ["Fouls", "Final red cards", "Final eliminations", "Best Move hits"]) {
      expect(
        within(details).getByText(label, { selector: "dt" }).nextElementSibling,
      ).toHaveTextContent(/^0$/);
    }
    expect(
      within(details).getByText("Games with recorded fouls: 1; with recorded final status: 1."),
    ).toBeInTheDocument();
  });

  it("explains every excluded rating reason and preserves adjudication/discipline summaries", async () => {
    const user = userEvent.setup();
    const reasons = [
      "casper",
      "cancelled",
      "incomplete-results",
      "ineligible-roster",
      "host",
    ] as const;
    vi.mocked(getPlayerStatistics).mockResolvedValueOnce(
      detail({
        history: reasons.map((reason, index) =>
          game({
            gameId: `excluded-${reason}`,
            name: `Excluded ${reason}`,
            unratedReason: reason,
            ratingChange: null,
            isHost: reason === "host",
            statisticsAvailable: reason !== "incomplete-results",
            participant:
              reason === "host" || reason === "incomplete-results"
                ? null
                : { ...game().participant!, status: "red-carded" },
            adjudication:
              index === 0
                ? {
                    losingTeam: "black",
                    offenderSeat: 7,
                    rule: "5.1",
                    reason: "Saved judge explanation",
                    committeeApproved: true,
                  }
                : undefined,
          }),
        ),
        total: reasons.length,
      }),
    );
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    const details = await screen.findByRole("region", { name: "Player details: Alpha" });
    for (const explanation of [
      "Casper-format games are not rated.",
      "Cancelled games are not rated.",
      "Incomplete saved results: no rating change is available.",
      "The saved roster is not eligible for this rating model.",
      "Hosting is not rated.",
      "Statistics unavailable for this game.",
    ])
      expect(await within(details).findByText(explanation)).toBeInTheDocument();
    expect(within(details).getAllByText(/Red-carded/).length).toBeGreaterThan(0);
    const firstGame = within(details).getByRole("article", { name: "Excluded casper" });
    await user.click(within(firstGame).getByText("Saved result summary"));
    expect(within(firstGame).getByText("Saved judge explanation")).toBeVisible();
    expect(within(firstGame).getByText("Committee approved")).toBeVisible();
    expect(within(firstGame).getByText("Offender: seat 7")).toBeVisible();
    expect(within(firstGame).getByText(/Rule 5.1/)).toBeVisible();
  });

  it("uses the established localized anonymous fallback when a retained profile is retired during a detail read", async () => {
    const user = userEvent.setup();
    vi.mocked(getPlayerStatistics).mockResolvedValueOnce(detail({ player: row({ nickname: "" }) }));
    render(
      <I18nProvider locale="ru">
        <StatisticsScreen clubId="club-a" isManager={false} onBack={vi.fn()} />
      </I18nProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    expect(
      await screen.findByRole("region", { name: "Данные игрока: Анонимный игрок" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Данные игрока: Alpha" })).not.toBeInTheDocument();
  });

  it("shows a retryable detail error instead of inventing an empty player, and preserves history on page failure", async () => {
    const user = userEvent.setup();
    vi.mocked(getPlayerStatistics)
      .mockRejectedValueOnce(new Error("private detail"))
      .mockResolvedValueOnce(detail({ nextCursor: "next", total: 2 }))
      .mockRejectedValueOnce(new Error("private page"))
      .mockResolvedValueOnce(
        detail({ history: [game({ gameId: "b", name: "Second game" })], total: 2 }),
      );
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Player statistics are temporarily unavailable.",
    );
    expect(screen.queryByText("This player is no longer available.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry player details" }));
    await user.click(await screen.findByRole("button", { name: "Load more games" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your loaded history is unchanged.");
    expect(screen.getByText("Evening game")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more games" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Load more games" }));
    expect(await screen.findByText("Second game")).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 2 games")).toBeInTheDocument();
  });

  it("does not append an old player's held history page into another player's details", async () => {
    const user = userEvent.setup();
    const pendingPage = deferred<PlayerStatisticsResponse>();
    vi.mocked(getClubStatistics).mockResolvedValue(
      club([row(), row({ playerId: "b", nickname: "Bravo" })]),
    );
    vi.mocked(getPlayerStatistics)
      .mockResolvedValueOnce(detail({ nextCursor: "next", total: 2 }))
      .mockReturnValueOnce(pendingPage.promise)
      .mockResolvedValueOnce(
        detail({ player: row({ playerId: "b", nickname: "Bravo" }), history: [], total: 0 }),
      );
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    await user.click(await screen.findByRole("button", { name: "Load more games" }));
    await user.click(screen.getByRole("button", { name: "Bravo" }));
    await screen.findByText("Showing 0 of 0 games");
    await act(async () =>
      pendingPage.resolve(
        detail({ history: [game({ gameId: "late", name: "Late old game" })], total: 2 }),
      ),
    );
    expect(screen.queryByText("Late old game")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 0 of 0 games")).toBeInTheDocument();
  });

  it("keeps presentation failure retryable and suppresses only a cancelled editor's local callback", async () => {
    const user = userEvent.setup();
    const pendingSave = deferred<string | null>();
    vi.mocked(assignGameTournament)
      .mockRejectedValueOnce(new Error("not confirmed"))
      .mockReturnValueOnce(pendingSave.promise);
    vi.mocked(getPlayerStatistics).mockResolvedValue(
      detail({ history: [game({ tournamentId: null })] }),
    );
    const onTournamentAssigned = vi.fn();
    renderScreen({ onTournamentAssigned });
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    await user.click(await screen.findByRole("button", { name: "Change tournament" }));
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Save tournament" })).toBeDisabled();
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Tournament" }),
      "event-a",
    );
    await user.click(screen.getByRole("button", { name: "Save tournament" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tournament assignment was not confirmed.",
    );
    expect(screen.getByRole("button", { name: "Save tournament" })).toBeEnabled();
    expect(onTournamentAssigned).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save tournament" }));
    await user.click(screen.getByRole("button", { name: "Cancel tournament edit" }));
    await act(async () => pendingSave.resolve("event-a"));
    expect(onTournamentAssigned).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Change tournament" }));
    expect(screen.getByRole("button", { name: "Save tournament" })).toBeEnabled();
  });

  it("suppresses an obsolete editor's local success presentation after switching players", async () => {
    const user = userEvent.setup();
    const pendingSave = deferred<string | null>();
    vi.mocked(assignGameTournament).mockReturnValueOnce(pendingSave.promise);
    vi.mocked(getClubStatistics).mockResolvedValue(
      club([row(), row({ playerId: "b", nickname: "Bravo" })]),
    );
    vi.mocked(getPlayerStatistics)
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(
        detail({ player: row({ playerId: "b", nickname: "Bravo" }), history: [] }),
      );
    const onTournamentAssigned = vi.fn();
    renderScreen({ onTournamentAssigned });
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    await user.click(await screen.findByRole("button", { name: "Change tournament" }));
    await user.click(screen.getByRole("button", { name: "Save tournament" }));
    await user.click(screen.getByRole("button", { name: "Bravo" }));
    await screen.findByRole("region", { name: "Player details: Bravo" });
    await act(async () => pendingSave.resolve("event-a"));
    expect(onTournamentAssigned).not.toHaveBeenCalled();
  });

  it("groups displayed rating ties, preserves club rank through search, and supports keyboard sorting/back", async () => {
    const user = userEvent.setup();
    const base = row().rating;
    vi.mocked(getClubStatistics).mockResolvedValue(
      club([
        row({
          playerId: "z",
          nickname: "Zulu",
          rating: { ...base, value: null, ratedGames: 0, status: "unranked", rank: null },
        }),
        row({
          playerId: "p",
          nickname: "Provisional player",
          rating: { ...base, value: 1800, ratedGames: 9, status: "provisional", rank: null },
        }),
        row({ playerId: "b", nickname: "Bravo", rating: { ...base, value: 1600.49 } }),
        row(),
        row({ playerId: "t", nickname: "Top", rating: { ...base, value: 1700, rank: 1 } }),
      ]),
    );
    const onBack = vi.fn();
    renderScreen({ onBack });
    await screen.findByRole("button", { name: "Alpha" });
    const table = screen.getByRole("table", { name: "Club player statistics" });
    const players = within(table)
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("aria-expanded"));
    expect(players.map((button) => button.textContent)).toEqual([
      "Top",
      "Alpha",
      "Bravo",
      "Provisional player",
      "Zulu",
    ]);
    expect(within(screen.getByRole("row", { name: /Alpha/ })).getByText("2")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search nickname" }), "Bravo");
    expect(within(screen.getByRole("row", { name: /Bravo/ })).getByText("2")).toBeInTheDocument();
    expect(getClubStatistics).toHaveBeenCalledOnce();
    const sort = within(table).getByRole("button", { name: "Games" });
    sort.focus();
    await user.keyboard("{Enter}");
    expect(sort.closest("th")).toHaveAttribute("aria-sort", "descending");
    await user.keyboard("{Enter}");
    expect(sort.closest("th")).toHaveAttribute("aria-sort", "ascending");
    const back = screen.getByRole("button", { name: "Back to game" });
    back.focus();
    await user.keyboard("{Enter}");
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("sends every filter to the API, clears old rows immediately, rejects late scoped responses and invalid dates", async () => {
    const user = userEvent.setup();
    const old = deferred<ClubStatisticsResponse>();
    vi.mocked(getClubStatistics)
      .mockResolvedValueOnce(club())
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(club([row({ nickname: "Filtered" })]));
    renderScreen();
    await screen.findByRole("button", { name: "Alpha" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Team" }), "black");
    expect(screen.queryByRole("button", { name: "Alpha" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Role" }), "don");
    expect(await screen.findByRole("button", { name: "Filtered" })).toBeInTheDocument();
    await act(async () => old.resolve(club([row({ nickname: "Obsolete" })])));
    expect(screen.queryByRole("button", { name: "Obsolete" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Tournament scope" }), "event-a");
    // Native date inputs are set through a change event; user-event date typing varies across engines.
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("To (UTC)"), { target: { value: "2026-10-15" } });
    await waitFor(() =>
      expect(getClubStatistics).toHaveBeenLastCalledWith("club-a", {
        team: "black",
        role: "don",

        tournamentId: "event-a",
        from: "2026-10-01",
        to: "2026-10-15",
      }),
    );
    expect(screen.getByText(/Current rating uses all eligible club games/)).toBeInTheDocument();
    const count = vi.mocked(getClubStatistics).mock.calls.length;
    fireEvent.change(screen.getByLabelText("To (UTC)"), { target: { value: "2026-09-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Start date must not follow end date.");
    expect(getClubStatistics).toHaveBeenCalledTimes(count);
    expect(screen.queryByRole("table", { name: "Club player statistics" })).not.toBeInTheDocument();
  });

  it("clears club data while loading and never accepts the old club's reply", async () => {
    const old = deferred<ClubStatisticsResponse>();
    const next = deferred<ClubStatisticsResponse>();
    vi.mocked(getClubStatistics).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { rerender } = renderScreen();
    rerender(<StatisticsScreen clubId="club-b" isManager={false} onBack={vi.fn()} />);
    await act(async () => old.resolve(club()));
    expect(screen.queryByRole("button", { name: "Alpha" })).not.toBeInTheDocument();
    await act(async () => next.resolve(club([row({ nickname: "New club" })])));
    expect(screen.getByRole("button", { name: "New club" })).toBeInTheDocument();
  });

  it("shows incomplete/pending coverage and keeps errors distinct from empty/search-empty results", async () => {
    const user = userEvent.setup();
    vi.mocked(getClubStatistics).mockRejectedValueOnce(new Error("secret storage payload"));
    renderScreen();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Statistics are temporarily unavailable.",
    );
    expect(screen.queryByText("No recorded players in this scope.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry statistics" }));
    await screen.findByRole("button", { name: "Alpha" });
    expect(screen.getByText(/1 completed game has unavailable statistics/)).toBeInTheDocument();
    expect(screen.getByText(/2 unfinished games/)).toBeInTheDocument();
    expect(
      screen.getByText(/Wins divided by games with a recorded player result; draws are included/),
    ).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "nobody");
    expect(screen.getByText("No nicknames match your search.")).toBeInTheDocument();
    vi.mocked(getClubStatistics).mockResolvedValueOnce(club([]));
    await user.selectOptions(screen.getByRole("combobox", { name: "Tournament scope" }), "none");
    expect(await screen.findByText("No recorded players in this scope.")).toBeInTheDocument();
  });

  it("separates lifetime Elo and event change, distinguishing eligible zero from no observations", async () => {
    const user = userEvent.setup();
    vi.mocked(getClubStatistics).mockResolvedValue(
      club([
        row(),
        row({ playerId: "b", nickname: "Bravo", scopedRatedGames: 0, scopedRatingChange: null }),
      ]),
    );
    renderScreen();
    await screen.findByRole("button", { name: "Alpha" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Tournament scope" }), "event-a");
    await screen.findByRole("columnheader", { name: "Tournament Elo change" });
    expect(within(screen.getByRole("row", { name: /Alpha/ })).getByText("0.0")).toBeInTheDocument();
    expect(
      within(screen.getByRole("row", { name: /Bravo/ })).getByText(
        "No eligible games in this scope",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Not an official tournament score/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Lifetime Elo" })).toBeInTheDocument();
  });

  it("opens full metrics and paged result summaries without manager timeline access", async () => {
    const user = userEvent.setup();
    vi.mocked(getPlayerStatistics)
      .mockResolvedValueOnce(detail({ nextCursor: "page-2", total: 2 }))
      .mockResolvedValueOnce(
        detail({
          history: [
            game(),
            game({
              gameId: "game-b",
              name: "Legacy hosted game",
              isHost: true,
              participant: null,

              hasCasper: true,
              outcome: "cancelled",
              ratingChange: null,
              unratedReason: "cancelled",
            }),
          ],
          total: 2,
        }),
      );
    renderScreen({ onOpenTimeline: vi.fn() });
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    const details = await screen.findByRole("region", { name: "Player details: Alpha" });
    for (const label of [
      "Team breakdown",
      "Role breakdown",
      "Fouls",
      "Fouls per game with recorded fouls",
      "Final red cards",
      "Final eliminations",
      "Recorded Best Move results",
      "Best Move hits",
      "Mean hits per recorded result",
      "Hosted games",
      "Last recorded hosting date",
      "Last recorded play date",
    ])
      expect(within(details).getAllByText(label).length).toBeGreaterThan(0);
    expect(
      within(details).getByText("0", { selector: ".statistics-best-move" }),
    ).toBeInTheDocument();
    expect(within(details).getByText(/Before 1,584.4/)).toBeInTheDocument();
    expect(within(details).getByText(/Expected score/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open timeline" })).not.toBeInTheDocument();
    await user.click(within(details).getByRole("button", { name: "Load more games" }));
    expect(getPlayerStatistics).toHaveBeenLastCalledWith(
      "alpha",
      "club-a",
      {},
      { cursor: "page-2", limit: 50 },
    );
    expect(await within(details).findByText("Legacy hosted game")).toBeInTheDocument();
    expect(within(details).getAllByRole("article")).toHaveLength(2);
    expect(within(details).getByText("Cancelled games are not rated.")).toBeInTheDocument();
    expect(within(details).getByText("Showing 2 of 2 games")).toBeInTheDocument();
  });

  it("clears a prior player's pending detail and ignores its late success", async () => {
    const user = userEvent.setup();
    const old = deferred<PlayerStatisticsResponse>();
    vi.mocked(getClubStatistics).mockResolvedValue(
      club([row(), row({ playerId: "b", nickname: "Bravo" })]),
    );
    vi.mocked(getPlayerStatistics)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(
        detail({ player: row({ playerId: "b", nickname: "Bravo" }), history: [] }),
      );
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    await user.click(screen.getByRole("button", { name: "Bravo" }));
    await screen.findByRole("region", { name: "Player details: Bravo" });
    await act(async () => old.resolve(detail()));
    expect(screen.queryByText("Evening game")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Player details: Alpha" })).not.toBeInTheDocument();
  });

  it("only opens timeline for a manager and saves an exact historical tournament then reloads", async () => {
    const user = userEvent.setup();
    const save = deferred<string | null>();
    vi.mocked(assignGameTournament).mockReturnValueOnce(save.promise);
    const onOpenTimeline = vi.fn();
    const onTournamentAssigned = vi.fn();
    renderScreen({ isManager: true, onOpenTimeline, onTournamentAssigned });
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    await user.click(await screen.findByRole("button", { name: "Open timeline" }));
    expect(onOpenTimeline).toHaveBeenCalledWith("game-a");
    await user.click(screen.getByRole("button", { name: "Change tournament" }));
    await user.click(screen.getByRole("checkbox", { name: "Include in tournament" }));
    await user.click(screen.getByRole("button", { name: "Save tournament" }));
    expect(assignGameTournament).toHaveBeenCalledExactlyOnceWith("game-a", null, "club-a");
    expect(onTournamentAssigned).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Saving tournament…" })).toBeDisabled();
    await act(async () => save.resolve(null));
    expect(onTournamentAssigned).toHaveBeenCalledExactlyOnceWith("game-a", null);
    await waitFor(() => expect(getClubStatistics).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getPlayerStatistics).toHaveBeenCalledTimes(2));
  });

  it("does not show old editor success in another club and releases presentation busy on a fresh editor", async () => {
    const user = userEvent.setup();
    const save = deferred<string | null>();
    vi.mocked(assignGameTournament).mockReturnValueOnce(save.promise);
    const onTournamentAssigned = vi.fn();
    const { rerender } = renderScreen({ onTournamentAssigned });
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    await user.click(await screen.findByRole("button", { name: "Change tournament" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save tournament" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Save tournament" }));
    expect(assignGameTournament).toHaveBeenCalledExactlyOnceWith("game-a", "event-a", "club-a");
    rerender(
      <StatisticsScreen
        clubId="club-b"
        isManager={false}
        onBack={vi.fn()}
        onAssignTournament={(gameId, value) => assignGameTournament(gameId, value, "club-b")}
        onTournamentAssigned={onTournamentAssigned}
      />,
    );
    await act(async () => save.resolve("event-a"));
    expect(onTournamentAssigned).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    await user.click(await screen.findByRole("button", { name: "Change tournament" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save tournament" })).toBeEnabled(),
    );
  });

  it("localizes labels, numeric precision, dates and unrated explanations in Russian", async () => {
    const user = userEvent.setup();
    vi.mocked(getPlayerStatistics).mockResolvedValue(
      detail({
        history: [game({ ratingChange: null, unratedReason: "casper", hasCasper: true })],
      }),
    );
    render(
      <I18nProvider locale="ru">
        <StatisticsScreen clubId="club-a" isManager={false} onBack={vi.fn()} />
      </I18nProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Alpha" }));
    const details = await screen.findByRole("region", { name: "Данные игрока: Alpha" });
    expect(screen.getByRole("heading", { name: "Статистика клуба" })).toBeInTheDocument();
    expect(
      within(details).getByText("В формате с Каспером рейтинг не начисляется."),
    ).toBeInTheDocument();
    expect(within(details).getByText("1,3")).toBeInTheDocument();
    expect(within(details).getByText("1,5")).toBeInTheDocument();
    expect(within(details).getAllByText("14.10.2026").length).toBeGreaterThan(0);
    expect(
      within(details).getByText("Среднее число попаданий на записанный результат"),
    ).toBeInTheDocument();
  });
});
