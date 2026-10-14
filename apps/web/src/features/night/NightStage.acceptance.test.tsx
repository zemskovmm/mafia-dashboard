import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyGameEvent,
  assignRoleForSeat,
  beginNight,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createInitialGameBaseline,
  createSeededRandom,
  createSetup,
  FEDERATION_RULES_EDITION,
  hashGameState,
  resolveMafiaShots,
  replayGameLog,
  type GameState,
} from "@mafia/game-domain";
import { ClubWorkspace } from "../../App.js";
import type {
  Club,
  GameSessionOperation,
  GameSessionState,
  PlayerProfile,
  RemoteGameSession,
} from "../../api/client.js";
import {
  GameSessionOutbox,
  gameSessionStorageKey,
  type CurrentGameSessionEnvelope,
} from "../../session-outbox.js";
import { clearErrorConsole, getErrorConsoleSnapshot } from "../console/error-console.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { expectServerAcceptsEvent } from "../../test-game-event-contract.js";

const api = vi.hoisted(() => ({
  listPlayers: vi.fn(),
  listActiveGameSessions: vi.fn(),
  listCompletedGameSessions: vi.fn(),
  getAppVersion: vi.fn(),
  checkServerReady: vi.fn(),
  getMusicAccountStatus: vi.fn(),
  saveGameSessionOperation: vi.fn(),
  getGameSession: vi.fn(),
}));
vi.mock(import("../../api/client.js"), async (original) => ({ ...(await original()), ...api }));
const club: Club = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Physical counts",
  city: "Test",
  headerLogo: null,
  cardLogo: null,
  language: "en",
  bestMoveEnabled: true,
  role: "manager",
  createdAt: "2026-10-14T16:00:00Z",
  updatedAt: "2026-10-14T16:00:00Z",
};
const hostPlayerId = "00000000-0000-4000-8000-000000000011";
const gameId = "00000000-0000-4000-8000-000000000399";
const initialNight = () => {
  let setup = beginRoleDraw(
    createSetup(
      Array.from({ length: 10 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        seat: i + 1,
      })),
      { rulesEdition: FEDERATION_RULES_EDITION },
    ),
    createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat++)
    setup = assignRoleForSeat(
      setup,
      seat,
      seat === 1 ? "sheriff" : seat === 10 ? "don" : seat >= 8 ? "mafia" : "citizen",
    );
  let game = createGame(completeRoleDraw(setup));
  game = applyGameEvent(game, { type: "phase.changed", payload: { to: "sheriff-identification" } });
  game = applyGameEvent(game, { type: "phase.changed", payload: { to: "day" } });
  return beginNight(game);
};
const session = (state: GameSessionState): RemoteGameSession => ({
  gameId,
  name: "Physical observations",
  revision: 1,
  duplicate: false,
  status: "active",
  rulesetId: "club-mafia",
  rulesetVersion: 2,
  updatedAt: "2026-10-14T16:00:00Z",
  state,
  results: null,
});
const activate = (remote: RemoteGameSession) =>
  new GameSessionOutbox({
    storage: window.localStorage,
    clubId: club.id,
    createId: () => crypto.randomUUID(),
    save: vi.fn(),
  }).activateRemote(remote);
const seed = (game: GameState) => {
  const root = createGameLogEntry({
    gameId,
    id: crypto.randomUUID(),
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-10-14T16:00:00Z",
    before: game,
    draft: { type: "game.checkpointed", payload: {} },
  });
  const state: GameSessionState = {
    setup: null,
    game,
    hostPlayerId,
    playlistId: "",
    log: [],
    undoHistory: [],
    undoBudget: 0,
    initialGame: createInitialGameBaseline(game),
    events: [root.entry],
    headEventId: root.entry.id,
    resetReturnEventId: null,
    legacyLog: [],
  };
  activate(session(state));
};
const envelope = (): CurrentGameSessionEnvelope =>
  JSON.parse(window.localStorage.getItem(gameSessionStorageKey)!);
const current = () => envelope().current!.state;
const game = () => current().game as GameState;
const renderWorkspace = (locale: "en" | "ru" = "en") =>
  render(
    <I18nProvider locale={locale}>
      <ClubWorkspace
        club={{ ...club, language: locale }}
        onExit={() => undefined}
        onEditClub={() => undefined}
        onDeleteClub={async () => undefined}
      />
    </I18nProvider>,
  );
let capturedRemote: RemoteGameSession;
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearErrorConsole();
  api.listPlayers.mockResolvedValue(
    Array.from({ length: 11 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      nickname: `Player ${i + 1}`,
      consent: false,
      clubAccess: "none",
      firstName: null,
      lastName: null,
      email: null,
      consentAt: null,
      createdAt: "2026-10-14T16:00:00Z",
      updatedAt: "2026-10-14T16:00:00Z",
      lastPlayedAt: null,
      statistics: {},
    })) as PlayerProfile[],
  );
  api.listActiveGameSessions.mockResolvedValue([]);
  api.listCompletedGameSessions.mockResolvedValue([]);
  api.getAppVersion.mockResolvedValue("1.0.0");
  api.checkServerReady.mockResolvedValue(undefined);
  api.getMusicAccountStatus.mockResolvedValue({
    configured: false,
    connected: false,
    accountLabel: null,
  });
  api.saveGameSessionOperation
    .mockReset()
    .mockImplementation(async (id: string, operation: GameSessionOperation) => {
      expect(id).toBe(gameId);
      capturedRemote = JSON.parse(JSON.stringify({ ...session(operation.state), revision: 2 }));
      return capturedRemote;
    });
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearErrorConsole();
  vi.restoreAllMocks();
});

describe("App physical-count acceptance and recovery", () => {
  it.each(["en", "ru"] as const)(
    "accepts displayed provisional assignments atomically in %s and restores the private facts",
    async (locale) => {
      const user = userEvent.setup();
      const initial = initialNight();
      seed(initial);
      const view = renderWorkspace(locale);
      await user.click(
        await screen.findByRole("button", {
          name:
            locale === "en"
              ? "Assign all Mafia shots to Player 9"
              : "Назначить все выстрелы мафии в игрока Player 9",
        }),
      );
      expect(game().shotAssignments).toEqual({ 8: 9, 9: 9, 10: 9 });
      expect(current().events).toHaveLength(1);
      const toggleLabel =
        locale === "en" ? "Observed multiple shooting" : "Зафиксирована многократная стрельба";
      await user.click(screen.getByRole("button", { name: toggleLabel }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(current().events).toHaveLength(1);
      expect(game().shotObservations).toBeUndefined();
      expect(resolveMafiaShots(game()).result).toEqual({ kind: "kill", targetSeat: 9 });
      const target = (seat: number) =>
        screen.getByRole("button", {
          name:
            locale === "en"
              ? `Record observed shot by #8 at Player ${seat}`
              : `Записать наблюдаемый выстрел №8 в игрока Player ${seat}`,
        });
      await user.click(target(9));
      await user.click(target(9));
      await user.click(target(7));
      expect(game().shotAssignments).toEqual({ 8: 9, 9: 9, 10: 9 });
      expect(game().shotObservations).toEqual([
        { shooterSeat: 8, targetSeat: 9, additional: true },
        { shooterSeat: 8, targetSeat: 9, additional: true },
        { shooterSeat: 8, targetSeat: 7, additional: true },
      ]);
      const accepted = current();
      expect(hashGameState(replayGameLog(accepted.initialGame!, accepted.events).game)).toBe(
        hashGameState(game()),
      );
      await expectServerAcceptsEvent(initial, {
        type: "mafia.shots-observed",
        payload: {
          shotAssignments: { 8: 9, 9: 9, 10: 9 },
          observations: [{ shooterSeat: 8, targetSeat: 9 }],
        },
      });
      await waitFor(() => expect(capturedRemote.state.events).toEqual(accepted.events));
      view.unmount();
      const recovered = renderWorkspace(locale);
      expect(game().shotObservations).toEqual((accepted.game as GameState).shotObservations);
      expect(screen.getByRole("button", { name: toggleLabel })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      recovered.unmount();
      // This is the real remote admission/local-cache path, with IO mocked only at the API boundary.
      window.localStorage.clear();
      activate(capturedRemote);
      renderWorkspace(locale);
      expect(game().shotAssignments).toEqual({ 8: 9, 9: 9, 10: 9 });
      expect(game().shotObservations).toEqual((accepted.game as GameState).shotObservations);
      // Ordinary corrections after restoration do not erase accepted physical facts.
      await user.click(
        await screen.findByRole("button", {
          name:
            locale === "en"
              ? "Assign all Mafia shots to Player 7"
              : "Назначить все выстрелы мафии в игрока Player 7",
        }),
      );
      expect(game().shotAssignments).toEqual({ 8: 7, 9: 7, 10: 7 });
      expect(game().shotObservations).toEqual((accepted.game as GameState).shotObservations);
      await user.click(
        await screen.findByRole("button", {
          name: locale === "en" ? "Evaluate Mafia shots" : "Определить результат выстрелов мафии",
        }),
      );
      expect(game().nightResult).toEqual({ kind: "miss" });
      expect(game().players.every((p) => p.status === "active")).toBe(true);
      expect(getErrorConsoleSnapshot()).toEqual([]);
    },
  );

  it("finishes zero support through the actual App acceptance, restoration and Undo path", async () => {
    const user = userEvent.setup();
    const initial = {
      ...initialNight(),
      phase: "car-crash-decision" as const,
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };
    seed(initial);
    const view = renderWorkspace();
    await user.click(await screen.findByRole("button", { name: "Resolve car crash" }));
    expect(game()).toMatchObject({
      phase: "car-crash-result",
      carCrashVotes: {},
      carCrashResult: { eliminate: false, yesVotes: 0, eligibleVoters: 10, seats: [4, 6] },
    });
    const accepted = current();
    expect(accepted.events.at(-1)?.type).toBe("car-crash.count-completed");
    expect(accepted.undoBudget).toBe(1);
    expect(hashGameState(replayGameLog(accepted.initialGame!, accepted.events).game)).toBe(
      hashGameState(game()),
    );
    view.unmount();
    renderWorkspace();
    expect(game().phase).toBe("car-crash-result");
    await user.click(screen.getByRole("button", { name: "Undo last action · 1 available" }));
    expect(game().phase).toBe("car-crash-decision");
    expect(game().carCrashVotes).toEqual({});
    expect(game().carCrashResult).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Resolve car crash" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(game().phase).toBe("night-mafia");
    expect(game().players.every((p) => p.status === "active")).toBe(true);
    expect(getErrorConsoleSnapshot()).toEqual([]);
  });

  it.each(["en", "ru"] as const)(
    "retains repeated seat-specific details in the private %s Log",
    async (locale) => {
      const user = userEvent.setup();
      seed(initialNight());
      renderWorkspace(locale);
      await user.click(
        await screen.findByRole("button", {
          name:
            locale === "en" ? "Observed multiple shooting" : "Зафиксирована многократная стрельба",
        }),
      );
      await user.click(
        screen.getByRole("button", {
          name:
            locale === "en"
              ? "Record observed shots by all Mafia at Player 9"
              : "Записать наблюдаемые выстрелы всей мафии в игрока Player 9",
        }),
      );
      await user.click(
        screen.getByRole("button", {
          name:
            locale === "en"
              ? "Record observed shots by all Mafia at Player 9"
              : "Записать наблюдаемые выстрелы всей мафии в игрока Player 9",
        }),
      );
      expect(game().shotObservations).toHaveLength(6);
      expect(
        game()
          .shotObservations?.slice(0, 3)
          .every((shot) => !shot.additional),
      ).toBe(true);
      expect(
        game()
          .shotObservations?.slice(3)
          .every((shot) => shot.additional),
      ).toBe(true);
      await user.click(
        screen.getByRole("button", {
          name: locale === "en" ? "Open game log" : "Открыть журнал игры",
        }),
      );
      const log = within(
        screen.getByRole("dialog", { name: locale === "en" ? "Game log" : "Журнал игры" }),
      );
      expect(
        log.getAllByText(
          locale === "en" ? "Physical shots observed" : "Зафиксированы физические выстрелы",
        ),
      ).toHaveLength(2);
      for (const [index, shooter] of [8, 9, 10].entries())
        expect(
          log.getAllByText(
            locale === "en"
              ? `Shot ${index + 1}: shooter #${shooter} → target #9`
              : `Выстрел ${index + 1}: стрелок №${shooter} → цель №9`,
          ),
        ).toHaveLength(2);
      await user.click(
        screen.getByRole("button", {
          name: locale === "en" ? "Close game log" : "Закрыть журнал игры",
        }),
      );
      await user.click(
        screen.getByRole("button", {
          name:
            locale === "en"
              ? "Undo last action · 2 available"
              : "Отменить последнее действие · доступно: 2",
        }),
      );
      expect(game().shotObservations).toHaveLength(3);
      expect(game().shotObservations?.every((shot) => !shot.additional)).toBe(true);
      await user.click(
        screen.getByRole("button", {
          name:
            locale === "en"
              ? "Undo last action · 1 available"
              : "Отменить последнее действие · доступно: 1",
        }),
      );
      expect(game().shotObservations).toBeUndefined();
      expect(game().shotAssignments).toEqual({});
    },
  );
});
