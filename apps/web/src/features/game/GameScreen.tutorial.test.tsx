import { StrictMode } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  advanceOpeningPhase,
  applyGameEvent,
  beginNight,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  performDonCheck,
  performSheriffCheck,
  resolveMafiaShots,
  startVoting,
  type GameState,
} from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { namedProfiles, renderWithProfiles } from "../../test-player-directory.js";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { GameUtilityPanels } from "./GameUtilityPanels.js";
import { GameScreen } from "./GameScreen.js";

const day = (): GameState => {
  let setup = beginRoleDraw(
    createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `player-${i + 1}`, seat: i + 1 }))),
    createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat++) setup = drawRoleForSeat(setup, seat);
  let game = createGame(completeRoleDraw(setup));
  while (game.phase !== "day") game = advanceOpeningPhase(game);
  return game;
};
const ballot = () =>
  startVoting({
    ...day(),
    nominations: [4, 6].map((candidateSeat, i) => ({
      nominatorSeat: i + 1,
      candidateSeat,
      order: i + 1,
    })),
  });
const callbacks = () => ({ onGameChange: vi.fn(), onEvent: vi.fn(), onAcceptedEvent: vi.fn() });
const renderGame = (ui: Parameters<typeof renderWithProfiles>[0]) =>
  renderWithProfiles(ui, namedProfiles("player-"));

const finishGuide = async (
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  next = "Next",
  done = "Done",
) => {
  for (let i = 0; i < 8 && within(dialog).queryByRole("button", { name: next }); i++)
    await user.click(within(dialog).getByRole("button", { name: next }));
  await user.click(within(dialog).getByRole("button", { name: done }));
};

describe("essential-screen tutorials", () => {
  it.each(["en", "ru"] as const)(
    "manually explains day gestures without changing any game input in %s",
    async (locale) => {
      const game = day();
      const snapshot = JSON.stringify(game);
      const handlers = callbacks();
      const user = userEvent.setup();
      const labels =
        locale === "en"
          ? {
              help: "Day table help",
              title: "Day table tutorial",
              first: "Tap to nominate or support",
              next: "Next",
              back: "Back",
              done: "Done",
              close: "Close tutorial",
              down: "Swipe down for a foul",
              up: "Swipe up for discipline",
            }
          : {
              help: "Помощь с дневным столом",
              title: "Подсказки для дневного стола",
              first: "Нажмите для выставления или поддержки",
              next: "Далее",
              back: "Назад",
              done: "Готово",
              close: "Закрыть подсказки",
              down: "Смахните вниз для фола",
              up: "Смахните вверх для санкций",
            };
      renderGame(
        <I18nProvider locale={locale}>
          <GameScreen {...handlers} game={game} hostName="Host" privacyHidden />
        </I18nProvider>,
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      const help = screen.getByRole("button", { name: labels.help });
      expect(help.closest(".game-header")).not.toBeNull();
      await user.click(help);
      let dialog = screen.getByRole("dialog", { name: labels.title });
      expect(within(dialog).getByRole("heading", { name: labels.first })).toBeVisible();
      expect(within(dialog).getByRole("button", { name: labels.back })).toBeDisabled();
      await user.click(within(dialog).getByRole("button", { name: labels.next }));
      expect(within(dialog).getByRole("heading", { name: labels.down })).toBeVisible();
      expect(dialog).toHaveAttribute("data-gesture", "down");
      await user.click(within(dialog).getByRole("button", { name: labels.next }));
      expect(within(dialog).getByRole("heading", { name: labels.up })).toBeVisible();
      expect(dialog).toHaveAttribute("data-gesture", "up");
      await user.click(within(dialog).getByRole("button", { name: labels.back }));
      await finishGuide(user, dialog, labels.next, labels.done);
      await user.click(help);
      dialog = screen.getByRole("dialog", { name: labels.title });
      expect(within(dialog).getByRole("heading", { name: labels.first })).toBeVisible();
      fireEvent(dialog, new Event("cancel", { cancelable: true }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await user.click(help);
      await user.click(screen.getByRole("button", { name: labels.close }));
      expect(JSON.stringify(game)).toBe(snapshot);
      for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
    },
  );

  it("dismisses on visibility, phase, game and speaker-context changes and never auto-opens", async () => {
    const game = day();
    const handlers = callbacks();
    const props = { ...handlers, hostName: "Host", privacyHidden: true };
    const user = userEvent.setup();
    const { rerender } = renderGame(<GameScreen {...props} game={game} />);
    await user.click(screen.getByRole("button", { name: "Day table help" }));
    rerender(<GameScreen {...props} game={game} showTutorialHelp={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Day table help" })).toBeNull();
    rerender(<GameScreen {...props} game={game} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    for (const next of [
      { ...game, currentTurnIndex: 1 },
      { ...game, players: game.players.map((player) => ({ ...player, id: `other-${player.id}` })) },
      beginNight(game),
    ]) {
      await user.click(screen.getByRole("button", { name: "Day table help" }));
      rerender(<GameScreen {...props} game={next} />);
      expect(screen.queryByRole("dialog")).toBeNull();
      rerender(<GameScreen {...props} game={game} />);
    }
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it.each(["preview", "finished", "draw", "cancelled", "goodbye-speech", "best-move"] as const)(
    "does not expose tutorial help in %s",
    (state) => {
      const game = day();
      renderGame(
        <GameScreen
          {...callbacks()}
          hostName="Host"
          privacyHidden
          game={
            state === "preview"
              ? game
              : { ...game, phase: state, winner: state === "finished" ? "red" : null }
          }
          mode={state === "preview" ? "preview" : "live"}
        />,
      );
      expect(screen.queryByRole("button", { name: /help|помощь/i })).toBeNull();
    },
  );

  it("preserves the native StrictMode stale-close guard and static Fancy-off presentation", async () => {
    const user = userEvent.setup();
    renderGame(
      <StrictMode>
        <FancyFeaturesContext.Provider value={false}>
          <GameScreen {...callbacks()} hostName="Host" privacyHidden game={day()} />
        </FancyFeaturesContext.Provider>
      </StrictMode>,
    );
    await user.click(screen.getByRole("button", { name: "Day table help" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-animated", "false");
    fireEvent(dialog, new Event("close"));
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("dialog")).toBe(dialog);
    dialog.removeAttribute("open");
    fireEvent(dialog, new Event("close"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not refill cleared final-candidate votes while explaining ordinary voting", async () => {
    let game = applyGameEvent(ballot(), {
      type: "voting.candidate-selected",
      payload: { candidateSeat: 6 },
    });
    game = applyGameEvent(game, {
      type: "vote.recorded",
      payload: { voterSeat: 1, candidateSeat: null },
    });
    const snapshot = JSON.stringify(game);
    const handlers = callbacks();
    const user = userEvent.setup();
    renderGame(<GameScreen {...handlers} hostName="Host" privacyHidden game={game} />);
    await user.click(screen.getByRole("button", { name: "Voting help" }));
    const dialog = screen.getByRole("dialog", { name: "Voting tutorial" });
    expect(dialog).toHaveTextContent("Choose the current nominee");
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(dialog).toHaveTextContent("clear or reassign");
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(dialog).toHaveTextContent(
      "Deliberately selecting the last candidate assigns remaining votes",
    );
    await finishGuide(user, dialog);
    expect(game.voteAssignments[1]).toBeUndefined();
    expect(JSON.stringify(game)).toBe(snapshot);
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["car-crash", "Tie speeches", { turnOrder: [4, 6], carCrashSeats: [4, 6] }],
    [
      "car-crash-decision",
      "Record the collective count",
      { carCrashSeats: [4, 6], carCrashVotes: {} },
    ],
    ["voting-cancelled", "Voting is cancelled", {}],
    ["car-crash-skipped", "The collective ballot is skipped", { carCrashSeats: [4, 6] }],
    [
      "car-crash-result",
      "Read the accepted ballot result",
      { carCrashResult: { eliminate: false, seats: [4, 6], yesVotes: 0, eligibleVoters: 10 } },
    ],
  ] satisfies readonly (readonly [GameState["phase"], string, Partial<GameState>])[])(
    "explains %s without pretending an ordinary ballot exists",
    async (phase, title, state) => {
      const game = { ...day(), ...state, phase };
      const snapshot = JSON.stringify(game);
      const handlers = callbacks();
      const user = userEvent.setup();
      renderGame(<GameScreen {...handlers} hostName="Host" privacyHidden game={game} />);
      await user.click(screen.getByRole("button", { name: "Voting help" }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByRole("heading", { name: title })).toBeVisible();
      expect(dialog).not.toHaveTextContent("Choose the current nominee");
      await finishGuide(user, dialog);
      expect(JSON.stringify(game)).toBe(snapshot);
      for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
    },
  );

  it("explains a disputed ballot as paused without selecting or completing it", async () => {
    let game = ballot();
    game = applyGameEvent(game, {
      type: "vote.recorded",
      payload: { voterSeat: 1, candidateSeat: 4 },
    });
    game = applyGameEvent(game, {
      type: "voting.count-disputed",
      payload: { candidateSeat: 4, reason: "Review" },
    });
    const user = userEvent.setup();
    const handlers = callbacks();
    renderGame(<GameScreen {...handlers} hostName="Host" privacyHidden game={game} />);
    await user.click(screen.getByRole("button", { name: "Voting help" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Voting is paused for external review");
    await finishGuide(user, dialog);
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "explains the actual shooting mode (observation: %s) without recording shots",
    async (observing) => {
      const game = beginNight(day());
      const snapshot = JSON.stringify(game);
      const handlers = callbacks();
      const user = userEvent.setup();
      renderGame(<GameScreen {...handlers} hostName="Host" privacyHidden game={game} />);
      if (observing)
        await user.click(screen.getByRole("button", { name: "Observed multiple shooting" }));
      await user.click(screen.getByRole("button", { name: "Night help" }));
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByRole("heading", {
          name: observing ? "Record physical shot observations" : "Transcribe Mafia shots",
        }),
      ).toBeVisible();
      expect(dialog).toHaveTextContent(
        observing
          ? "Each tap records another physical shot"
          : "Tap a target card to assign all eligible shooters",
      );
      await finishGuide(user, dialog);
      expect(screen.getByRole("button", { name: "Observed multiple shooting" })).toHaveAttribute(
        "aria-pressed",
        String(observing),
      );
      expect(JSON.stringify(game)).toBe(snapshot);
      for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(["night-don", "night-sheriff"] as const)(
    "keeps %s eligibility including same-night victims and never performs a check",
    async (phase) => {
      const base = beginNight(day());
      const role = phase === "night-don" ? "don" : "sheriff";
      const owner = base.players.find((p) => p.role === role)!;
      const game: GameState = {
        ...base,
        phase,
        nightResult: { kind: "kill", targetSeat: owner.seat },
        players: base.players.map((p) =>
          p.seat === owner.seat ? { ...p, status: "eliminated" } : p,
        ),
      };
      const snapshot = JSON.stringify(game);
      const handlers = callbacks();
      const user = userEvent.setup();
      renderGame(<GameScreen {...handlers} hostName="Host" privacyHidden game={game} />);
      await user.click(screen.getByRole("button", { name: "Night help" }));
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent("Inactive targets remain available");
      expect(dialog).not.toHaveTextContent("This check is unavailable");
      await finishGuide(user, dialog);
      expect(JSON.stringify(game)).toBe(snapshot);
      for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
    },
  );

  it("explains unavailable checks without claiming a target can be selected", async () => {
    const base = beginNight(day());
    const game: GameState = {
      ...base,
      phase: "night-don",
      nightCheckEligibility: { don: false, sheriff: true },
      players: base.players.map((p) => (p.role === "don" ? { ...p, status: "eliminated" } : p)),
    };
    const user = userEvent.setup();
    renderGame(<GameScreen {...callbacks()} hostName="Host" privacyHidden game={game} />);
    await user.click(screen.getByRole("button", { name: "Night help" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("This check is unavailable");
  });

  it("dismisses stale instructions when current-speaker or check eligibility changes in place", async () => {
    const game = day();
    const props = { ...callbacks(), hostName: "Host", privacyHidden: true };
    const user = userEvent.setup();
    const { rerender } = renderGame(<GameScreen {...props} game={game} />);
    await user.click(screen.getByRole("button", { name: "Day table help" }));
    rerender(
      <GameScreen
        {...props}
        game={{
          ...game,
          players: game.players.map((p) =>
            p.seat === game.turnOrder[game.currentTurnIndex] ? { ...p, status: "eliminated" } : p,
          ),
        }}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    const night = {
      ...beginNight(game),
      phase: "night-don" as const,
      nightCheckEligibility: undefined,
    };
    rerender(<GameScreen {...props} game={night} />);
    await user.click(screen.getByRole("button", { name: "Night help" }));
    rerender(
      <GameScreen
        {...props}
        game={{
          ...night,
          players: night.players.map((p) =>
            p.role === "don" ? { ...p, status: "eliminated" } : p,
          ),
        }}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["don", "sheriff"] as const)(
    "never copies a live %s result or target identity into tutorial content",
    async (role) => {
      const base = { ...beginNight(day()), phase: `night-${role}` as const };
      const game =
        role === "don" ? performDonCheck(base, 1).game : performSheriffCheck(base, 1).game;
      const snapshot = JSON.stringify(game);
      const handlers = callbacks();
      const user = userEvent.setup();
      renderGame(<GameScreen {...handlers} hostName="Host" privacyHidden game={game} />);
      await user.click(screen.getByRole("button", { name: "Night help" }));
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent("Read the private result");
      expect(dialog).not.toHaveTextContent(
        /Player 1|player-1|Sheriff found|Not the Sheriff|Mafia found|Not Mafia/,
      );
      await finishGuide(user, dialog);
      expect(JSON.stringify(game)).toBe(snapshot);
      for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["mafia-planning", "Mafia agreement"],
    ["mafia-sleep", "Confirm Mafia is asleep"],
    ["don-identification", "Continue the opening"],
    ["sheriff-identification", "Sheriff greeting"],
    ["free-seating", "Begin round zero"],
    ["night-mafia-result", "Review the shooting result"],
    ["night-resolution", "Complete the night"],
  ] as const)("uses current prompt guidance for %s", async (phase, title) => {
    const game: GameState = { ...resolveMafiaShots(beginNight(day())).game, phase };
    const handlers = callbacks();
    const user = userEvent.setup();
    renderGame(<GameScreen {...handlers} hostName="Host" privacyHidden game={game} />);
    await user.click(screen.getByRole("button", { name: "Night help" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: title })).toBeVisible();
    expect(dialog).not.toHaveTextContent("Transcribe Mafia shots");
    await finishGuide(user, dialog);
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it("anchors the nominee guide in the sibling workspace rail, never another workspace", async () => {
    const game = ballot();
    const user = userEvent.setup();
    renderGame(
      <>
        <div className="app-shell" data-testid="workspace">
          <GameScreen {...callbacks()} hostName="Host" privacyHidden game={game} />
          <aside>
            <GameUtilityPanels game={game} onSelectVotingCandidate={vi.fn()} />
          </aside>
        </div>
        <div className="app-shell">
          <button className="nomination-row-target">Unrelated</button>
        </div>
      </>,
    );
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.matches("dialog")) return new DOMRect(0, 0, 1200, 800);
        if (this.matches(".role-tutorial-callout")) return new DOMRect(0, 0, 340, 310);
        return new DOMRect(this.closest("aside") ? 900 : 20, 100, 100, 100);
      });
    try {
      await user.click(screen.getByRole("button", { name: "Voting help" }));
      const target = document.querySelector<HTMLElement>(".role-tutorial-target")!;
      expect(target).toHaveAttribute("data-example", "false");
      expect(target.style.left).toBe("900px");
    } finally {
      bounds.mockRestore();
    }
  });
});
