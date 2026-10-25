import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as domain from "@mafia/game-domain";
import * as historyActions from "../game/game-history.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import type { CompletedGameSessionSummary, RemoteGameSession } from "../../api/client.js";
import { GameTimelineScreen } from "./GameTimelineScreen.js";
import { createSampleGameHistory } from "./sample-game-data.js";

const gameId = "00000000-0000-4000-8000-000000000701";
const summary = {
  gameId,
  name: "Recorded table",
  revision: 1,
  hostPlayerId: null,
  outcome: null,
  winner: null,
  reason: null,
  playedAt: null,
  day: null,
  timelineAvailable: false,
  eventCount: 0,
  updatedAt: "2026-10-16T12:00:00Z",
} satisfies CompletedGameSessionSummary;
const session = (
  state: Record<string, unknown> = {},
  results: Record<string, unknown> | null = {},
): RemoteGameSession => ({
  gameId,
  name: summary.name,
  revision: 1,
  duplicate: false,
  status: "completed",
  updatedAt: summary.updatedAt,
  state,
  results,
});

const localized = {
  en: {
    selector: "Completed game",
    unknown: "Unknown outcome",
    facts: "Recorded facts",
    date: "Unknown date",
    host: "Unknown host",
    unavailable: "Timeline detail is unavailable for this game.",
    participants: "Recorded participants",
    unknownValue: "Unknown",
    seat: "Seat",
    role: "Role",
    fouls: "Fouls",
    bestMove: "Best Move hits",
    team: "Team",
    status: "Final status",
  },
  ru: {
    selector: "Завершённая игра",
    unknown: "Исход неизвестен",
    facts: "Записанные факты",
    date: "Дата неизвестна",
    host: "Неизвестный ведущий",
    unavailable: "Подробная хронология этой игры недоступна.",
    participants: "Записанные участники",
    unknownValue: "Неизвестно",
    seat: "Место",
    role: "Роль",
    fouls: "Фолы",
    bestMove: "Попадания лучшего хода",
    team: "Команда",
    status: "Итоговый статус",
  },
} as const;

describe.each(["en", "ru"] as const)("engine-independent completed records (%s)", (locale) => {
  afterEach(() => vi.restoreAllMocks());
  it("offers notebook import from history without requesting a live-game action", () => {
    const onImport = vi.fn();
    render(
      <I18nProvider locale={locale}>
        <GameTimelineScreen
          clubId="club"
          onBack={vi.fn()}
          onImport={onImport}
          loaders={{ listCompleted: async () => [], getSession: async () => session() }}
        />
      </I18nProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: locale === "en" ? "Import paper game" : "Импорт игры из тетради",
      }),
    );
    expect(onImport).toHaveBeenCalledOnce();
  });

  it("reopens sparse notebook observations without constructing a replay", async () => {
    const replay = vi.spyOn(domain, "replayGameLog");
    const saved = session(
      {
        notebook: {
          dayCount: 2,
          cells: [
            { seat: 1, day: 1, phase: "day", nomination: 4, eliminated: true },
            { seat: 2, day: 1, phase: "night", eliminated: true },
          ],
          bestMove: { targetSeats: [5, 6, 8] },
        },
      },
      { players: [{ playerId: "known-player", seat: 1, role: "sheriff" }] },
    );
    const bytes = JSON.stringify(saved);
    const view = render(
      <I18nProvider locale={locale}>
        <GameTimelineScreen
          clubId="club"
          initialGameId={gameId}
          onBack={vi.fn()}
          players={[{ id: "known-player", nickname: "Current nickname" }]}
          loaders={{ listCompleted: async () => [summary], getSession: async () => saved }}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText("4 X")).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.getAllByText("Current nickname").length).toBeGreaterThanOrEqual(2);
    expect(replay).not.toHaveBeenCalled();
    expect(JSON.stringify(saved)).toBe(bytes);
    view.unmount();
  });

  it.each([
    {},
    { initialGame: null, events: [], headEventId: null },
    { events: null, initialGame: null },
  ])(
    "lists and opens an empty completed record normally without invented results, dates or controls",
    async (state) => {
      const text = localized[locale];
      const original = session(state);
      const replay = vi.spyOn(domain, "replayGameLog");
      const branch = vi.spyOn(historyActions, "getActiveBranch");
      const bytes = JSON.stringify(original);
      render(
        <I18nProvider locale={locale}>
          <GameTimelineScreen
            clubId="club"
            onBack={vi.fn()}
            loaders={{ listCompleted: async () => [summary], getSession: async () => original }}
            onPreviewCurrentEvent={vi.fn()}
            onResetCurrentEvent={vi.fn()}
          />
        </I18nProvider>,
      );
      const option = await screen.findByRole("option", {
        name: `Recorded table · ${text.unknown}`,
      });
      expect(option).toBeInTheDocument();
      fireEvent.change(screen.getByRole("combobox", { name: text.selector }), {
        target: { value: gameId },
      });
      expect(await screen.findByText(text.unavailable)).toBeInTheDocument();
      const facts = screen.getByRole("region", { name: text.facts });
      expect(within(facts).getByText(text.date)).toBeInTheDocument();
      expect(within(facts).getByText(text.host)).toBeInTheDocument();
      expect(within(facts).getByText(text.unknown)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText(/2026|1970|club-mafia|ruleset|Checkpoint/)).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Preview|Reset|Предпросмотр|Вернуть игру/ }),
      ).toBeNull();
      expect(JSON.stringify(original)).toBe(bytes);
      expect(replay).not.toHaveBeenCalled();
      expect(branch).not.toHaveBeenCalled();
    },
  );

  it("retains independent participant observations and distinguishes known zero from missing metrics", async () => {
    const text = localized[locale];
    const original = session(
      {},
      {
        outcome: "red",
        reason: "Accepted note",
        players: [
          { playerId: "known", fouls: 0, bestMoveHits: 0 },
          { playerId: "retired", seat: 4, role: "sheriff", status: "eliminated" },
        ],
      },
    );
    render(
      <I18nProvider locale={locale}>
        <GameTimelineScreen
          clubId="club"
          initialGameId={gameId}
          onBack={vi.fn()}
          players={[{ id: "known", nickname: "Known player" }]}
          loaders={{ listCompleted: async () => [], getSession: async () => original }}
        />
      </I18nProvider>,
    );
    const table = await screen.findByRole("table", { name: text.participants });
    const known = within(table).getByRole("row", { name: /Known player/ });
    expect(within(known).getAllByText("0")).toHaveLength(2);
    expect(within(known).getAllByText(text.unknownValue)).toHaveLength(4);
    expect(within(table).getByRole("columnheader", { name: text.fouls })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: text.bestMove })).toBeInTheDocument();
    expect(screen.getByText("Accepted note")).toBeInTheDocument();
    expect(screen.getByText(text.unavailable)).toBeInTheDocument();
    expect(screen.queryByText("retired")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["day", undefined])(
    "does not present a nonterminal snapshot (%s) as final participant observations",
    async (phase) => {
      const text = localized[locale];
      const original = session(
        {
          game: {
            phase,
            players: [
              {
                id: "known",
                seat: 1,
                role: "sheriff",
                team: "red",
                status: "active",
                fouls: 2,
              },
            ],
            bestMove: { playerSeat: 1, mafiaHits: 2 },
          },
        },
        { players: [{ playerId: "known" }] },
      );
      const before = JSON.stringify(original);
      render(
        <I18nProvider locale={locale}>
          <GameTimelineScreen
            clubId="club"
            initialGameId={gameId}
            onBack={vi.fn()}
            players={[{ id: "known", nickname: "Known player" }]}
            loaders={{ listCompleted: async () => [], getSession: async () => original }}
          />
        </I18nProvider>,
      );
      const table = await screen.findByRole("table", { name: text.participants });
      const row = within(table).getByRole("row", { name: /Known player/ });
      expect(
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      ).toEqual(Array.from({ length: 6 }, () => text.unknownValue));
      expect(JSON.stringify(original)).toBe(before);
    },
  );

  it.each([
    {
      label: "replacement identity",
      snapshotPlayers: [{ id: "owner", seat: 1 }],
      result: { playerId: "replacement", seat: 1 },
      expectedHits: null,
    },
    {
      label: "different existing identity moved into the owner's seat",
      snapshotPlayers: [
        { id: "owner", seat: 1 },
        { id: "replacement", seat: 2 },
      ],
      result: { playerId: "replacement", seat: 1 },
      expectedHits: null,
    },
    {
      label: "known owner with a corrected result seat",
      snapshotPlayers: [{ id: "owner", seat: 1 }],
      result: { playerId: "owner", seat: 2 },
      expectedHits: 2,
    },
    {
      label: "ambiguous snapshot owner seat",
      snapshotPlayers: [
        { id: "owner", seat: 1 },
        { id: "replacement", seat: 1 },
      ],
      result: { playerId: "owner", seat: 1 },
      expectedHits: null,
    },
  ])(
    "attributes stored Best Move hits to identity, not a replacement seat: $label",
    async ({ snapshotPlayers, result, expectedHits }) => {
      const text = localized[locale];
      const original = session(
        {
          game: {
            phase: "finished",
            players: snapshotPlayers,
            bestMove: { playerSeat: 1, mafiaHits: 2 },
          },
        },
        { players: [result] },
      );
      const before = JSON.stringify(original);
      render(
        <I18nProvider locale={locale}>
          <GameTimelineScreen
            clubId="club"
            initialGameId={gameId}
            onBack={vi.fn()}
            players={[{ id: result.playerId, nickname: "Result player" }]}
            loaders={{ listCompleted: async () => [], getSession: async () => original }}
          />
        </I18nProvider>,
      );
      const table = await screen.findByRole("table", { name: text.participants });
      const row = within(table).getByRole("row", { name: /Result player/ });
      expect(within(row).getAllByRole("cell").at(-1)).toHaveTextContent(
        expectedHits === null ? text.unknownValue : String(expectedHits),
      );
      expect(within(table).getAllByRole("row")).toHaveLength(2);
      expect(JSON.stringify(original)).toBe(before);
    },
  );

  it("shows a conversion-preserved completed snapshot with cleared optional history without requiring resumable current state", async () => {
    const text = localized[locale];
    const sample = createSampleGameHistory();
    const absentLifecycle = new Set([
      "completedGameNights",
      "sheriffChecksPerformed",
      "firstDayDepartureSeats",
      "currentSpeechRestricted",
    ]);
    const snapshot = Object.fromEntries(
      Object.entries(sample.game).filter(([key]) => !absentLifecycle.has(key)),
    );
    const original = {
      ...session({
        setup: null,
        game: snapshot,
        hostPlayerId: "known-host",
        playlistId: "",
        log: [{ type: "game.completed", text: "Preserved source note" }],
        legacyLog: [],
        initialGame: null,
        events: [],
        headEventId: null,
        resetReturnEventId: null,
        undoHistory: [],
        undoBudget: 0,
      }),
      aggregate: { events: [] },
    };
    const bytes = JSON.stringify(original);
    const replay = vi.spyOn(domain, "replayGameLog");
    const branch = vi.spyOn(historyActions, "getActiveBranch");
    render(
      <I18nProvider locale={locale}>
        <GameTimelineScreen
          clubId="club"
          initialGameId={gameId}
          onBack={vi.fn()}
          players={[
            { id: "known-host", nickname: "Recorded host" },
            { id: "sample-player-2", nickname: "Snapshot owner" },
          ]}
          loaders={{ listCompleted: async () => [summary], getSession: async () => original }}
          onPreviewCurrentEvent={vi.fn()}
          onResetCurrentEvent={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText(text.unavailable)).toBeInTheDocument();
    const facts = screen.getByRole("region", { name: text.facts });
    expect(within(facts).getByText("Recorded host")).toBeInTheDocument();
    expect(within(facts).getByText(text.unknown)).toBeInTheDocument();
    expect(within(facts).getByText(text.date)).toBeInTheDocument();
    expect(
      within(facts).getByText(locale === "en" ? "Citizens" : "Мирные", { selector: "dd" }),
    ).toBeInTheDocument();
    const owner = within(facts).getByRole("row", { name: /Snapshot owner/ });
    expect(within(owner).getAllByText("2")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Preview|Reset|Предпросмотр|Вернуть игру/ }),
    ).toBeNull();
    expect(replay).not.toHaveBeenCalled();
    expect(branch).not.toHaveBeenCalled();
    expect(JSON.stringify(original)).toBe(bytes);
  });

  it("keeps retained current v3 detail playable without fabricating result or date observations", async () => {
    const text = localized[locale];
    const sample = createSampleGameHistory();
    const original = session({
      initialGame: sample.baseline,
      events: sample.entries.map((entry) => ({ ...entry, gameId })),
      headEventId: sample.headEventId,
    });
    const bytes = JSON.stringify(original);
    const onPreview = vi.fn();
    const onReset = vi.fn();
    render(
      <I18nProvider locale={locale}>
        <GameTimelineScreen
          clubId="club"
          initialGameId={gameId}
          onBack={vi.fn()}
          players={[{ id: "sample-player-1", nickname: "Known sheriff" }]}
          loaders={{ listCompleted: async () => [summary], getSession: async () => original }}
          onPreviewCurrentEvent={onPreview}
          onResetCurrentEvent={onReset}
        />
      </I18nProvider>,
    );
    expect(
      await screen.findByRole("button", {
        name:
          locale === "en"
            ? "Don checked Known sheriff: Sheriff"
            : "Дон проверил Known sheriff: Шериф",
      }),
    ).toBeInTheDocument();
    const facts = screen.getByRole("region", { name: text.facts });
    expect(within(facts).getByText(text.unknown)).toBeInTheDocument();
    expect(within(facts).getByText(text.date)).toBeInTheDocument();
    expect(screen.queryByText(text.unavailable)).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Preview timeline checkpoint|Предпросмотр контрольной точки/,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Reset game to timeline checkpoint|Вернуть игру к контрольной точке/,
      }),
    ).toBeNull();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
    expect(JSON.stringify(original)).toBe(bytes);
  });

  it("rejects hash corruption in retained full current detail instead of hiding it as unavailable", async () => {
    const sample = createSampleGameHistory();
    const original = session({
      initialGame: sample.baseline,
      events: sample.entries.map((entry, index) => ({
        ...entry,
        gameId,
        ...(index === 3 ? { stateHashAfter: `sha256:${"0".repeat(64)}` } : {}),
      })),
      headEventId: sample.headEventId,
    });
    const bytes = JSON.stringify(original);
    render(
      <I18nProvider locale={locale}>
        <GameTimelineScreen
          clubId="club"
          initialGameId={gameId}
          onBack={vi.fn()}
          loaders={{ listCompleted: async () => [summary], getSession: async () => original }}
        />
      </I18nProvider>,
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(localized[locale].unavailable)).toBeNull();
    expect(JSON.stringify(original)).toBe(bytes);
  });

  it.each([
    { initialGame: { replayVersion: 3, game: {} }, events: [], headEventId: null },
    { events: [{ id: "broken" }], headEventId: "broken" },
    { events: "corrupt" },
  ])(
    "does not disguise corrupt retained canonical detail as ordinary absent history",
    async (state) => {
      const text = localized[locale];
      render(
        <I18nProvider locale={locale}>
          <GameTimelineScreen
            clubId="club"
            initialGameId={gameId}
            onBack={vi.fn()}
            loaders={{
              listCompleted: async () => [summary],
              getSession: async () => session(state),
            }}
          />
        </I18nProvider>,
      );
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByText(text.unavailable)).toBeNull();
    },
  );
});
