import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGameLogEntry,
  createInitialGameBaseline,
  type CanonicalGameEventDraft,
  type GameLogEntry,
} from "@mafia/game-domain";
import type { Club, PlayerProfile, RemoteGameSession } from "../../api/client.js";
import type * as ApiClient from "../../api/client.js";
import type * as RulesBookAssets from "../rules/rules-book-assets.js";
import { ClubWorkspace } from "../../App.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { GameSessionOutbox } from "../../session-outbox.js";
import { DEFAULT_FANCY_STUFF_SETTINGS } from "../effects/fancy-stuff-preferences.js";
import { createSampleGameHistory } from "./sample-game-data.js";

const profiles = vi.hoisted(() => ({ current: [] as PlayerProfile[] }));
vi.mock("../../api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  checkServerReady: vi.fn(async () => undefined),
  getAppVersion: vi.fn(async () => "test"),
  listPlayers: vi.fn(async () => profiles.current),
  listActiveGameSessions: vi.fn(async () => []),
  listCompletedGameSessions: vi.fn(async () => []),
  listTournaments: vi.fn(async () => []),
  getMusicAccountStatus: vi.fn(async () => ({
    configured: false,
    connected: false,
    accountLabel: null,
  })),
}));
vi.mock("../game/GameScreen.js", () => ({ GameScreen: () => <main>Saved game</main> }));
vi.mock("../music/YouTubePlaylistPlayer.js", () => ({ YouTubePlaylistPlayer: () => null }));
vi.mock("../rules/rules-book-assets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RulesBookAssets>()),
  preloadRulesBookAssets: () => Promise.resolve(),
}));

const club: Club = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "History club",
  city: "Málaga",
  headerLogo: null,
  cardLogo: null,
  language: "en",
  bestMoveEnabled: false,
  role: "manager",
  createdAt: "2026-11-12T12:00:00.000Z",
  updatedAt: "2026-11-12T12:00:00.000Z",
};
const reasons = [
  { reason: "voted-out", en: "voted out", ru: "выбыл по голосованию" },
  { reason: "mafia-kill", en: "killed by Mafia", ru: "убит мафией" },
  { reason: "other", en: "other reason", ru: "другая причина" },
] as const;

beforeEach(() => window.localStorage.clear());

describe.each(["en", "ru"] as const)("manual departure Log in %s", (locale) => {
  it.each(reasons)(
    "shows player and human $reason after restoring canonical history, including under privacy",
    async ({ reason, ...labels }) => {
      const initial = createSampleGameHistory().frames.find(
        ({ after }) => after.phase === "day",
      )!.after;
      const seat = initial.players.find((player) => player.role === "citizen")!.seat;
      const gameId = "00000000-0000-4000-8000-000000000090";
      const entries: GameLogEntry[] = [];
      let game = initial;
      const drafts: readonly CanonicalGameEventDraft[] = [
        { type: "game.checkpointed", payload: {} },
        { type: "player.manually-removed", payload: { seat, reason } },
      ];
      for (const draft of drafts) {
        const next = createGameLogEntry({
          gameId,
          id: `00000000-0000-4000-8000-${String(entries.length + 91).padStart(12, "0")}`,
          sequence: entries.length + 1,
          parentEventId: entries.at(-1)?.id ?? null,
          createdAt: "2026-11-12T12:00:00.000Z",
          before: game,
          draft,
        });
        entries.push(next.entry);
        game = next.after;
      }
      profiles.current = initial.players.map((player) => ({
        id: player.id,
        nickname: `Player ${player.seat}`,
        consent: false,
        clubAccess: "none",
        managerLocked: false,
        firstName: null,
        lastName: null,
        email: null,
        consentAt: null,
        createdAt: "2026-11-12T12:00:00.000Z",
        updatedAt: "2026-11-12T12:00:00.000Z",
        lastPlayedAt: null,
        statistics: {
          hostedGames: 0,
          gamesPlayed: 0,
          wins: 0,
          losses: 0,
          redGames: 0,
          redWins: 0,
          blackGames: 0,
          blackWins: 0,
          sheriffGames: 0,
          citizenGames: 0,
          mafiaGames: 0,
          donGames: 0,
          totalFouls: 0,
          eliminations: 0,
          redCards: 0,
          bestMoves: 0,
          bestMoveMafiaHits: 0,
        },
      }));
      const remote: RemoteGameSession = {
        gameId,
        name: "Manual removal history",
        revision: 1,
        duplicate: false,
        status: "active",
        updatedAt: "2026-11-12T12:00:00.000Z",
        results: null,
        state: {
          setup: null,
          game,
          hostPlayerId: null,
          playlistId: "",
          log: [],
          undoHistory: [],
          undoBudget: 0,
          initialGame: createInitialGameBaseline(initial),
          events: entries,
          headEventId: entries.at(-1)!.id,
          resetReturnEventId: null,
          legacyLog: [],
        },
      };
      const outbox = new GameSessionOutbox({
        storage: window.localStorage,
        clubId: club.id,
        createId: () => gameId,
        save: vi.fn(),
      });
      outbox.activateRemote(remote);
      const bytes = JSON.stringify(entries);
      render(
        <I18nProvider locale={locale}>
          <ClubWorkspace
            club={{ ...club, language: locale }}
            fancyStuff={{ ...DEFAULT_FANCY_STUFF_SETTINGS, enabled: false }}
            onFancyStuffChange={vi.fn()}
            onExit={vi.fn()}
            onEditClub={vi.fn()}
            onDeleteClub={async () => undefined}
          />
        </I18nProvider>,
      );
      fireEvent.click(
        await screen.findByRole("button", {
          name: locale === "en" ? "Open game log" : "Открыть журнал игры",
        }),
      );
      const log = within(
        screen.getByRole("dialog", { name: locale === "en" ? "Game log" : "Журнал игры" }),
      );
      const label =
        locale === "en"
          ? `Player ${seat} manually removed: ${labels.en}`
          : `Игрок Player ${seat} удалён вручную: ${labels.ru}`;
      expect(await log.findByText(label, { selector: "strong" })).toBeInTheDocument();
      expect(log.queryByText(/player\.manually-removed/)).toBeNull();
      expect(log.queryByText(/Foul|Red card|discipline|Фол|красную карточку|нарушени/)).toBeNull();
      expect(JSON.stringify(entries)).toBe(bytes);
    },
  );
});
