import { useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FEDERATION_RULES_EDITION,
  advanceSetupPhase,
  applyGameEvent,
  beginNight,
  beginRoleDraw,
  completeMafiaShots,
  completeNight,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  resolveMafiaShots,
  skipDonCheck,
  skipSheriffCheck,
  toggleAllMafiaShotsForTarget,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState } from "@mafia/game-domain";
import * as domain from "@mafia/game-domain";
import { I18nProvider, useMessages } from "../../i18n/I18nProvider.js";
import { votingMessages } from "../../i18n/messages/voting.js";
import { namedProfiles, renderWithProfiles } from "../../test-player-directory.js";
import { TimerControls } from "../timer/TimerControls.js";
import { GameScreen } from "./GameScreen.js";

const render = (ui: Parameters<typeof renderWithProfiles>[0]) =>
  renderWithProfiles(ui, namedProfiles("player-"));
afterEach(() => vi.useRealTimers());

const planning = (): GameState => {
  let setup = beginRoleDraw(
    createSetup(
      Array.from({ length: 10 }, (_, index) => ({
        id: `player-${index + 1}`,
        seat: index + 1,
      })),
    ),
    createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return createGame(completeRoleDraw(setup), { rulesEdition: FEDERATION_RULES_EDITION });
};
const day = () => {
  let game = planning();
  for (let i = 0; i < 5; i += 1) game = advanceSetupPhase(game);
  return game;
};
const bestMove = () => {
  let game = beginNight(day());
  const victim = game.players.find((p) => p.role === "citizen")!;
  game = completeMafiaShots(
    resolveMafiaShots(toggleAllMafiaShotsForTarget(game, victim.seat)).game,
  );
  game = skipSheriffCheck(skipDonCheck(game));
  return completeNight(game);
};
const Harness = ({
  initial,
  accepted = vi.fn(),
  changed = vi.fn(),
}: {
  initial: GameState;
  accepted?: (event: CanonicalGameEventDraft) => void;
  changed?: (game: GameState) => void;
}) => {
  const [game, setGame] = useState(initial);
  const [rulesFor, setRulesFor] = useState<GameState | null>(null);
  const { t } = useMessages(votingMessages);
  return (
    <>
      <button type="button" onClick={() => setRulesFor(game)}>
        {t("ballotRulesLabel")}
      </button>
      <GameScreen
        game={game}
        rulesOpen={rulesFor === game}
        onRulesClose={() => setRulesFor(null)}
        hostName="Host"
        privacyHidden
        onEvent={() => undefined}
        onGameChange={(next) => {
          setGame(next);
          changed(next);
        }}
        onAcceptedEvent={(event) => {
          const next = applyGameEvent(game, event);
          accepted(event);
          changed(next);
          setGame(next);
          return next;
        }}
      />
    </>
  );
};

const openPenalty = (seat = 2) => {
  const card = document.querySelector<HTMLElement>(`[data-seat="${seat}"] .player-seat`)!;
  if (card.matches(":disabled")) screen.getByRole("button", { name: "Rules" }).focus();
  else card.focus();
  const invoking = document.activeElement;
  fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 180 }] });
  fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
  return invoking;
};
const openGeneralRemoval = () => {
  const card = document.querySelector('[data-seat="1"] .player-seat')!;
  fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
  fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 180, clientY: 100 }] });
  fireEvent.click(document.querySelector(".table-swipe-red-card")!);
};

describe("federation GameScreen", () => {
  it.each(["en", "ru"] as const)(
    "returns from the real reference reader to the exact unchanged form in %s",
    async (locale) => {
      const user = userEvent.setup();
      const accepted = vi.fn();
      const changed = vi.fn();
      render(
        <I18nProvider locale={locale}>
          <Harness initial={day()} accepted={accepted} changed={changed} />
        </I18nProvider>,
      );
      openPenalty();
      const judge = screen.getByRole("dialog");
      const action = within(judge).getByLabelText(
        locale === "en" ? "Discipline action" : "Дисциплинарное действие",
      );
      const draft = () =>
        [
          ...judge.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            "input, select, textarea",
          ),
        ].map((field) => [field.value, "checked" in field ? field.checked : undefined]);
      for (const [selection, rule] of [
        ["removal", "6.2.11"],
        ["opponent-victory", "6.3.5"],
      ]) {
        await user.selectOptions(action, selection!);
        const selector = judge.querySelector<HTMLSelectElement>(".discipline-rule-picker select")!;
        await user.selectOptions(selector, rule!);
        await user.type(within(judge).getByRole("textbox"), "Unfinished / Незавершённый текст");
        if (selection === "opponent-victory") await user.click(within(judge).getByRole("checkbox"));
        const before = draft();
        const invoke = within(judge).getByRole("button", { name: new RegExp(rule!) });
        await user.click(invoke);
        const book = await screen.findByRole("dialog", {
          name: locale === "en" ? "Illustrated Mafia rulebook" : "Иллюстрированные правила Мафии",
        });
        expect(within(book).getByText(rule!, { selector: ".rs-reference" })).toBeVisible();
        expect(judge).toHaveAttribute("open");
        expect(judge).toHaveAttribute("inert");
        expect(judge).toHaveAttribute("aria-hidden", "true");
        await user.keyboard("{Escape}");
        expect(book).not.toHaveAttribute("open");
        expect(judge).toHaveAttribute("open");
        expect(judge).not.toHaveAttribute("inert");
        await waitFor(() => expect(invoke).toHaveFocus());
        expect(draft()).toEqual(before);
      }
      expect(accepted).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
    },
  );

  it("keeps ballot review open for its own accepted commands without reauthorizing a stale penalty", async () => {
    let game = domain.startVoting({
      ...day(),
      nominations: [2, 3].map((seat, index) => ({
        nominatorSeat: index + 1,
        candidateSeat: seat,
        order: index + 1,
      })),
    });
    game = applyGameEvent(game, {
      type: "voting.candidate-selected",
      payload: { candidateSeat: 2 },
    });
    const accepted = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={game} accepted={accepted} />);
    const card = document.querySelector<HTMLElement>('[data-seat="1"] .player-seat')!;
    fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 180, clientY: 100 }] });
    // A real click focuses the context action, which is removed before the modal opens.
    await user.click(document.querySelector<HTMLButtonElement>(".table-swipe-red-card")!);
    await user.click(screen.getByText("Dispute count", { exact: true }));
    await user.type(screen.getByLabelText("Dispute reason"), "Review this count");
    await user.click(screen.getByRole("button", { name: "Pause voting for review" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.type(screen.getByLabelText("Final ruling reason"), "Count confirmed");
    await user.click(screen.getByLabelText("I reviewed the external recording"));
    await user.click(screen.getByRole("button", { name: "Accept final reviewed count" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(accepted).toHaveBeenCalledTimes(2);
    within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(card).toHaveFocus();
  });

  it("preserves ballot-wide review edits across dismissal and different player shortcuts", async () => {
    let game = domain.startVoting({
      ...day(),
      nominations: [2, 3].map((seat, index) => ({
        nominatorSeat: index + 1,
        candidateSeat: seat,
        order: index + 1,
      })),
    });
    const drafts: CanonicalGameEventDraft[] = [
      { type: "voting.candidate-selected", payload: { candidateSeat: 2 } },
      { type: "vote.recorded", payload: { voterSeat: 1, candidateSeat: 2 } },
      { type: "voting.count-disputed", payload: { candidateSeat: 2, reason: "Review count" } },
    ];
    for (const draft of drafts) game = applyGameEvent(game, draft);
    const accepted = vi.fn();
    const user = userEvent.setup();
    await act(async () => {
      render(<Harness initial={game} accepted={accepted} />);
    });
    let invokingCard = openPenalty();
    expect(
      screen.getByRole("region", { name: "Ballot review · applies to the whole ballot" }),
    ).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Reviewed vote for #1 · Player 1"), "3");
    await user.click(screen.getByLabelText("I reviewed the external recording"));
    await user.type(screen.getByLabelText("Final ruling reason"), "Recording confirms seat three");
    for (const dismissal of ["Escape", "Close"]) {
      if (dismissal === "Escape") await user.keyboard("{Escape}");
      else
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(invokingCard).toHaveFocus();
      invokingCard = openPenalty(dismissal === "Escape" ? 3 : 2);
      expect(screen.getByLabelText("Reviewed vote for #1 · Player 1")).toHaveValue("3");
      expect(screen.getByLabelText("I reviewed the external recording")).toBeChecked();
      expect(screen.getByLabelText("Final ruling reason")).toHaveValue(
        "Recording confirms seat three",
      );
      expect(accepted).not.toHaveBeenCalled();
    }
    await user.click(screen.getByRole("button", { name: "Accept final reviewed count" }));
    expect(accepted).toHaveBeenCalledExactlyOnceWith({
      type: "voting.count-ruled",
      payload: {
        voteAssignments: { 1: 3 },
        externalReviewAcknowledged: true,
        reason: "Recording confirms seat three",
      },
    });
  });

  const stages = () => {
    const states: GameState[] = [];
    let opening = planning();
    while (opening.phase !== "day") {
      states.push(opening);
      opening = advanceSetupPhase(opening);
    }
    states.push(opening);
    const ballot = domain.startVoting({
      ...opening,
      nominations: [1, 2].map((seat) => ({
        nominatorSeat: seat,
        candidateSeat: seat,
        order: seat,
      })),
    });
    const tie = domain.beginCarCrash(ballot, [1, 2]);
    const repeated = domain.completeCurrentTurn(domain.completeCurrentTurn(tie));
    const collective = domain.beginCarCrashDecision(repeated, [1, 2]);
    const result = domain.acceptCompletedCarCrashCount(collective);
    const allSeats = opening.players.map((p) => p.seat);
    let allTie = domain.beginCarCrash(
      domain.startVoting({
        ...opening,
        nominations: allSeats.map((seat) => ({
          nominatorSeat: seat,
          candidateSeat: seat,
          order: seat,
        })),
      }),
      allSeats,
    );
    for (let i = 0; i < allSeats.length; i++) allTie = domain.completeCurrentTurn(allTie);
    const removed = applyGameEvent(opening, {
      type: "discipline.removal-observed",
      payload: {
        seat: 1,
        stage: "day-discussion",
        rule: "6.2.3",
        reason: "",
        checkInProgress: false,
      },
    });
    states.push(
      ballot,
      tie,
      collective,
      result,
      domain.beginSkippedCarCrashDecision(allTie, allSeats),
      domain.skipFederationVoting(
        applyGameEvent(removed, {
          type: "discipline.removals-announced",
          payload: { seats: [1] },
        }),
        "disciplinary-cancellation",
      ),
    );
    const shooting = beginNight(opening);
    const shootingResult = resolveMafiaShots(shooting).game;
    const don = completeMafiaShots(shootingResult);
    const sheriff = skipDonCheck(don);
    states.push(
      shooting,
      shootingResult,
      don,
      domain.performDonCheck(don, 1).game,
      sheriff,
      domain.performSheriffCheck(sheriff, 1).game,
      skipSheriffCheck(sheriff),
    );
    const best = bestMove();
    states.push(best, completeNight(domain.finalizeBestMove(best, "declined", true)));
    return states;
  };

  it.each(stages().map((game) => [game.phase, game] as const))(
    "opens and confirms the player shortcut at %s",
    (_phase, initial) => {
      // Validate real editioned preconditions, not merely a phase string.
      domain.createGameLogEntry({
        gameId: "penalty-matrix",
        id: "root",
        sequence: 1,
        parentEventId: null,
        createdAt: "2026-10-15T12:00:00.000Z",
        before: initial,
        draft: { type: "game.checkpointed", payload: {} },
      });
      const accepted = vi.fn();
      const changed = vi.fn();
      render(<Harness initial={initial} accepted={accepted} changed={changed} />);
      const seat = initial.players.find((p) => p.status === "active" && p.role === "citizen")!.seat;
      const card = document.querySelector(`[data-seat="${seat}"] .player-seat`)!;
      const swipe = () => {
        fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 180 }] });
        fireEvent.touchEnd(card, {
          changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }],
        });
      };
      swipe();
      expect(screen.getByRole("dialog")).toHaveAccessibleName(
        `Discipline penalty for #${seat} · Player ${seat}`,
      );
      expect(screen.getByLabelText("Discipline action")).toHaveValue("removal");
      expect(screen.queryByRole("option", { name: "Foul" })).toBeNull();
      expect(accepted).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      swipe();
      fireEvent.change(screen.getByLabelText("Removal rule"), { target: { value: "6.2.3" } });
      const confirm = screen.getByRole("button", { name: "Confirm discipline" });
      expect(confirm).toBeEnabled();
      fireEvent.click(confirm);
      expect(accepted).toHaveBeenCalledOnce();
      expect(accepted.mock.lastCall?.[0]).toMatchObject({
        type: "discipline.removal-observed",
        payload: { seat, checkInProgress: false },
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("dismisses a penalty when state or authority changes and leaves preview non-interactive", () => {
    const accepted = vi.fn();
    const initial = day();
    const props = {
      game: initial,
      hostName: "Host",
      privacyHidden: true,
      onGameChange: vi.fn(),
      onEvent: vi.fn(),
      onAcceptedEvent: accepted,
    };
    const { rerender } = render(<GameScreen {...props} />);
    const swipe = () => {
      const card = document.querySelector('[data-seat="2"] .player-seat')!;
      fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 180 }] });
      fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
    };
    swipe();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(<GameScreen {...props} game={{ ...initial }} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    swipe();
    rerender(<GameScreen {...props} finishGameState="blocked" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    swipe();
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<GameScreen {...props} mode="preview" />);
    swipe();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(accepted).not.toHaveBeenCalled();
  });
  it("opens a player penalty without a nomination and pre-fills removal timing", () => {
    const accepted = vi.fn();
    const changed = vi.fn();
    render(<Harness initial={day()} accepted={accepted} changed={changed} />);
    const card = document.querySelector('[data-seat="2"] .player-seat')!;
    fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 180 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
    expect(
      screen.getByRole("dialog", { name: "Discipline penalty for #2 · Player 2" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Player")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Occurrence timing" })).toBeNull();
    expect(screen.getByText("Day discussion")).toBeInTheDocument();
    expect(screen.getByLabelText("Discipline action")).toHaveValue("removal");
    expect(accepted).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Removal rule"), { target: { value: "6.2.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm discipline" }));
    expect(accepted).toHaveBeenCalledExactlyOnceWith({
      type: "discipline.removal-observed",
      payload: {
        seat: 2,
        stage: "day-discussion",
        rule: "6.2.3",
        reason: "",
        checkInProgress: false,
      },
    });
  });

  it("awards the opponent from the same penalty menu without revealing teams or changing players", () => {
    const initial = day();
    const offender = initial.players.find((p) => p.team === "black")!;
    const accepted = vi.fn();
    const changed = vi.fn();
    render(<Harness initial={initial} accepted={accepted} changed={changed} />);
    const card = document.querySelector(`[data-seat="${offender.seat}"] .player-seat`)!;
    fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 180 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
    fireEvent.change(screen.getByLabelText("Discipline action"), {
      target: { value: "opponent-victory" },
    });
    expect(screen.queryByLabelText("Losing team")).toBeNull();
    expect(screen.queryByText(/Result: (Red|Black) wins/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Applicable rule"), { target: { value: "6.3.5" } });
    const award = screen.getByRole("button", { name: "Award victory to opposing team" });
    expect(award).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Judge's reason"), {
      target: { value: "Confirmed misconduct" },
    });
    expect(award).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Required committee agreement obtained"));
    fireEvent.click(award);
    expect(accepted).toHaveBeenCalledExactlyOnceWith({
      type: "game.adjudicated",
      payload: {
        losingTeam: "black",
        offenderSeat: offender.seat,
        rule: "6.3.5",
        reason: "Confirmed misconduct",
        committeeApproved: true,
      },
    });
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      phase: "finished",
      winner: "red",
      players: initial.players,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it.each(["en", "ru"] as const)(
    "shows short removal rules and accepts no extra reason in %s",
    async (locale) => {
      const user = userEvent.setup();
      const accepted = vi.fn();
      render(
        <I18nProvider locale={locale}>
          <Harness initial={day()} accepted={accepted} />
        </I18nProvider>,
      );
      openGeneralRemoval();
      expect(screen.queryByRole("button", { name: /Judge discipline|Дисциплина/ })).toBeNull();
      const rule = screen.getByLabelText(locale === "en" ? "Removal rule" : "Пункт удаления");
      expect(screen.queryByText(locale === "en" ? "Rule reference" : "Справка правил")).toBeNull();
      const help = screen.getByRole("button", {
        name: locale === "en" ? "Choose a rule to read" : "Сначала выберите пункт правил",
      });
      expect(help).toBeDisabled();
      expect(help).toHaveAttribute("type", "button");
      expect(help.closest(".discipline-rule-picker")).toContainElement(rule);
      expect(screen.getByRole("dialog")).toHaveClass("is-discipline");
      const options = within(rule).getAllByRole("option").slice(1);
      expect(options).toHaveLength(13);
      for (const option of options) {
        const [number, description = ""] = (option.textContent ?? "").split(" · ");
        expect(number).toMatch(/^6\.2\.(?:[1-9]|1[0-3])$/);
        expect(description.trim().split(/\s+/).length).toBeLessThanOrEqual(2);
        expect(description.trim().length).toBeGreaterThan(0);
      }
      expect(options[1]).toHaveTextContent(
        locale === "en" ? "6.2.2 · Insults" : "6.2.2 · Оскорбления",
      );
      await user.selectOptions(rule, "6.2.2");
      const confirm = screen.getByRole("button", {
        name: locale === "en" ? "Confirm discipline" : "Подтвердить взыскание",
      });
      expect(confirm).toBeDisabled();
      await user.selectOptions(
        screen.getByLabelText(locale === "en" ? "Occurrence timing" : "Момент нарушения"),
        "day-discussion",
      );
      expect(confirm).toBeEnabled();
      await user.click(confirm);
      expect(accepted.mock.lastCall?.[0]).toMatchObject({
        type: "discipline.removal-observed",
        payload: { rule: "6.2.2", reason: "" },
      });
    },
  );
  it.each(["en", "ru"] as const)(
    "takes two opening advances in %s with a separate Sheriff greeting and no checks or kills",
    async (locale) => {
      const user = userEvent.setup();
      const accepted = vi.fn();
      const changed = vi.fn();
      const headings =
        locale === "en"
          ? ["Night one · Mafia agreement", "Night one · Sheriff greeting", "Zero round"]
          : ["Первая ночь · договорка мафии", "Первая ночь · приветствие Шерифа", "Нулевой круг"];
      const buttons =
        locale === "en"
          ? ["Mafia asleep", "Begin round zero"]
          : ["Мафия уснула", "Начать нулевой круг"];
      render(
        <I18nProvider locale={locale}>
          <Harness initial={planning()} accepted={accepted} changed={changed} />
        </I18nProvider>,
      );
      for (let i = 0; i < 2; i += 1) {
        expect(screen.getByRole("heading", { level: 1, name: headings[i] })).toBeInTheDocument();
        expect(document.querySelector(".game-shell")).toHaveClass("is-table-cycle-night");
        expect(document.querySelector(".table-center")).not.toHaveTextContent(/masked|маск/i);
        if (i === 1)
          expect(
            screen.getByText(
              locale === "en"
                ? "Wake the Sheriff. Give them 10 seconds to look around the table and greet the host."
                : "Разбудите Шерифа. Дайте ему 10 секунд, чтобы осмотреть стол и поприветствовать ведущего.",
            ),
          ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: buttons[i] }));
      }
      expect(screen.getByRole("heading", { name: headings[2] })).toBeInTheDocument();
      expect(changed.mock.lastCall?.[0]).toMatchObject({
        day: 1,
        completedGameNights: 1,
        sheriffChecksPerformed: 0,
      });
      expect(
        changed.mock.lastCall?.[0].players.every((p: { status: string }) => p.status === "active"),
      ).toBe(true);
      expect(accepted.mock.calls.map(([event]) => event)).toEqual(
        ["sheriff-identification", "day"].map((to) => ({ type: "phase.changed", payload: { to } })),
      );
    },
  );

  it.each([
    "mafia-planning",
    "mafia-sleep",
    "don-identification",
    "sheriff-identification",
    "free-seating",
  ] as const)(
    "continues %s through the direct-state callback without changing state on render",
    async (phase) => {
      const user = userEvent.setup();
      const changed = vi.fn();
      const event = vi.fn();
      let initial = planning();
      while (initial.phase !== phase) initial = advanceSetupPhase(initial);
      const original = JSON.stringify(initial);
      render(
        <GameScreen
          game={initial}
          hostName="Host"
          privacyHidden
          onGameChange={changed}
          onEvent={event}
        />,
      );
      expect(changed).not.toHaveBeenCalled();
      expect(event).not.toHaveBeenCalled();
      expect(JSON.stringify(initial)).toBe(original);
      const toDay = phase === "sheriff-identification" || phase === "free-seating";
      await user.click(
        screen.getByRole("button", {
          name: toDay
            ? "Begin round zero"
            : phase === "mafia-planning"
              ? "Mafia asleep"
              : "Wake the Sheriff",
        }),
      );
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls[0]?.[0]).toEqual(
        toDay ? day() : { ...initial, phase: "sheriff-identification" },
      );
      expect(JSON.stringify(initial)).toBe(original);
    },
  );

  it("keeps the Sheriff greeting manual when its ten-second timer expires", () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const accepted = vi.fn();
    render(
      <>
        <Harness
          initial={{ ...planning(), phase: "sheriff-identification" }}
          changed={changed}
          accepted={accepted}
        />
        <TimerControls />
      </>,
    );
    expect(screen.getByText(/Wake the Sheriff. Give them 10 seconds/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start 10 second timer" }));
    expect(screen.getByRole("button", { name: "Pause timer" })).toHaveTextContent("10");
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("button", { name: "Timer face" })).toHaveTextContent("00");
    expect(changed).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Begin round zero" })).toBeEnabled();
  });

  it.each(["live", "preview"] as const)(
    "omits the dated badge and deviation notices in Russian %s",
    (mode) => {
      render(
        <I18nProvider locale="ru">
          <GameScreen
            game={day()}
            hostName="Host"
            privacyHidden
            mode={mode}

            onGameChange={vi.fn()}
            onEvent={vi.fn()}
          />
        </I18nProvider>,
      );
      expect(screen.queryByText("MAFGAME · 1 июля 2026")).toBeNull();
      expect(screen.queryByText("Нестандартные клубные отклонения")).toBeNull();
      expect(document.querySelector(".federation-rules-notice")).toBeNull();
    },
  );

  it.each(["live", "preview"] as const)("omits empty rules notices in English %s", (mode) => {
    render(
      <GameScreen
        game={day()}
        hostName="Host"
        privacyHidden
        mode={mode}
        onGameChange={vi.fn()}
        onEvent={vi.fn()}
      />,
    );
    expect(screen.queryByText("MAFGAME · 1 July 2026")).toBeNull();
    expect(document.querySelector(".federation-rules-notice")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Zero round");
  });

  it.each([0, 1, 2, 3])(
    "accepts a %i-number prefix at night before a separate morning action",
    async (count) => {
      const user = userEvent.setup();
      const initial = bestMove();
      const accepted = vi.fn();
      const changed = vi.fn();
      render(<Harness initial={initial} accepted={accepted} changed={changed} />);
      expect(document.querySelector(".game-shell")).toHaveClass("is-table-cycle-night");
      expect(
        screen.getByText("20 seconds · record only judge-accepted numbers"),
      ).toBeInTheDocument();
      for (const seat of [7, initial.bestMove!.playerSeat, 7].slice(0, count)) {
        await user.click(screen.getByRole("button", { name: `Accept number ${seat}` }));
      }
      const numbers = within(screen.getByRole("list", { name: "Accepted Best Move numbers" }));
      expect(numbers.queryAllByRole("listitem").map((li) => li.textContent)).toEqual(
        [7, initial.bestMove!.playerSeat, 7].slice(0, count).map((seat) => `#${seat}`),
      );
      expect(screen.queryByRole("button", { name: "Skip Best Move" })).toBe(
        count === 0 ? screen.getByRole("button", { name: "Skip Best Move" }) : null,
      );
      const finish = screen.getByRole("button", {
        name: count === 0 ? "Skip Best Move" : count === 3 ? "Accept Best Move" : "Finish early",
      });
      expect(finish).toBeDisabled();
      await user.click(
        screen.getByRole("checkbox", { name: "Numbers read back and accepted; player sleeps" }),
      );
      await user.click(finish);
      expect(changed.mock.lastCall?.[0]).toMatchObject({
        phase: "night-resolution",
        day: 1,
        bestMoveEnabled: true,
        bestMove: {
          selectedSeats: [7, initial.bestMove!.playerSeat, 7].slice(0, count),
          completionReason:
            count === 0 ? "declined" : count === 3 ? "complete-list" : "finished-early",
          readbackAcknowledged: true,
        },
      });
      expect(screen.queryByRole("button", { name: /^Accept number / })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Announce morning" }));
      expect(changed.mock.lastCall?.[0]).toMatchObject({
        phase: "goodbye-speech",
        day: 2,
        completedGameNights: 2,
      });
      expect(
        accepted.mock.calls.filter(([event]) => event.type === "best-move.finalized"),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["interrupted", 1],
    ["time-expired", 2],
    ["time-expired", 0],
  ] as const)("records the judge's %s cutoff with %i accepted numbers", async (reason, count) => {
    const user = userEvent.setup();
    const changed = vi.fn();
    const accepted = vi.fn();
    const initial = bestMove();
    render(
      <Harness
        initial={{
          ...initial,
          bestMove: { ...initial.bestMove!, selectedSeats: [3, 6].slice(0, count) },
        }}
        changed={changed}
        accepted={accepted}
      />,
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Numbers read back and accepted; player sleeps" }),
    );
    await user.click(screen.getByRole("button", { name: "Choose Best Move cutoff" }));
    expect(screen.getByRole("dialog", { name: "Choose Best Move cutoff" })).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: reason === "interrupted" ? "Finish: interrupted" : "Finish: time expired",
      }),
    );
    expect(accepted.mock.lastCall?.[0]).toEqual({
      type: "best-move.finalized",
      payload: { reason, readbackAcknowledged: true },
    });
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      phase: "night-resolution",
      bestMove: { selectedSeats: [3, 6].slice(0, count), completionReason: reason },
    });
  });

  it("keeps the accepted Best Move prefix unchanged when the local twenty-second timer expires", () => {
    vi.useFakeTimers();
    const initial = bestMove();
    const changed = vi.fn();
    const accepted = vi.fn();
    render(
      <>
        <Harness
          initial={{ ...initial, bestMove: { ...initial.bestMove!, selectedSeats: [8, 3] } }}
          changed={changed}
          accepted={accepted}
        />
        <TimerControls />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start 20 second timer" }));
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole("button", { name: "Timer face" })).toHaveTextContent("00");
    expect(changed).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "Accepted Best Move numbers" })).toHaveTextContent(
      "#8#3",
    );
    expect(document.querySelector(".game-shell")).toHaveClass("is-table-cycle-night");
    expect(screen.queryByRole("button", { name: "Skip Best Move" })).toBeNull();
  });

  it("does not enable Finish Game while a terminal removal still needs its public announcement", async () => {
    const user = userEvent.setup();
    let initial = day();
    for (const player of initial.players.filter((p) => p.role === "mafia")) {
      initial = applyGameEvent(initial, {
        type: "discipline.removal-observed",
        payload: {
          seat: player.seat,
          stage: "day-discussion",
          rule: "6.2.2",
          reason: "Observed disqualifying misconduct",
          checkInProgress: false,
        },
      });
      initial = applyGameEvent(initial, {
        type: "discipline.removals-announced",
        payload: { seats: [player.seat] },
      });
    }
    initial = completeMafiaShots(resolveMafiaShots(beginNight(initial)).game);
    const don = initial.players.find((p) => p.role === "don")!;
    initial = applyGameEvent(initial, {
      type: "discipline.removal-observed",
      payload: {
        seat: don.seat,
        stage: "don-check",
        rule: "6.2.2",
        reason: "Disqualified before the private check began",
        checkInProgress: false,
      },
    });
    expect(initial.phase).toBe("finished");
    const finish = vi.fn();
    render(
      <GameScreen
        game={initial}
        hostName="Host"
        privacyHidden
        onGameChange={vi.fn()}
        onEvent={vi.fn()}
        onFinishGame={finish}
        finishGameState="ready"
      />,
    );
    expect(screen.getByRole("button", { name: "Finish the game" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Finish the game" }));
    expect(finish).not.toHaveBeenCalled();
  });

  it("corrects an obvious slip explicitly after readback, without reopening ordinary entry", async () => {
    const user = userEvent.setup();
    const initial = bestMove();
    const changed = vi.fn();
    render(<Harness initial={initial} changed={changed} />);
    await user.click(screen.getByRole("button", { name: "Accept number 3" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Numbers read back and accepted; player sleeps" }),
    );
    await user.click(screen.getByRole("button", { name: "Finish early" }));
    await user.click(screen.getByText("Correct an obvious slip"));
    await user.selectOptions(screen.getByLabelText("Accepted entry"), "0");
    await user.selectOptions(screen.getByLabelText("Correct number"), "8");
    await user.type(screen.getByLabelText("Slip correction reason"), "Misheard eight as three");
    await user.click(screen.getByRole("button", { name: "Confirm slip correction" }));
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      phase: "night-resolution",
      bestMove: { selectedSeats: [8], completionReason: "finished-early" },
    });
    expect(screen.queryByRole("button", { name: "Accept number 3" })).toBeNull();
  });

  it("shows nomination-only entitlement without consuming it on timer expiry", () => {
    vi.useFakeTimers();
    const initial = day();
    const restricted: GameState = {
      ...initial,
      currentSpeechRestricted: true,
      players: initial.players.map((p) =>
        p.seat === 1 ? { ...p, fouls: 3, mutePending: true } : p,
      ),
    };
    const changed = vi.fn();
    render(
      <>
        <Harness initial={restricted} changed={changed} />
        <TimerControls />
      </>,
    );
    expect(screen.getByText("Nomination only · no ordinary speech")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nominate Player 2" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Start 20 second timer" }));
    act(() => vi.advanceTimersByTime(20_000));
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Next player" })).toBeEnabled();
  });

  it("shows the short-table thirty-second entitlement and does not shorten a current speech at foul three", () => {
    const initial = day();
    const short: GameState = {
      ...initial,
      currentSpeechRestricted: true,
      players: initial.players.map((p) => ({
        ...p,
        status: p.seat <= 4 ? "active" : "eliminated",
        ...(p.seat === 1 ? { fouls: 3, mutePending: true } : {}),
      })),
    };
    const { unmount } = render(<Harness initial={short} />);
    expect(screen.getByText("30-second speech · short-table exception")).toBeInTheDocument();
    unmount();
    render(
      <Harness
        initial={{
          ...initial,
          players: initial.players.map((p) => (p.seat === 1 ? { ...p, fouls: 2 } : p)),
        }}
      />,
    );
    fireEvent.keyDown(document.querySelector('.seat-anchor[data-seat="1"] > .player-seat')!, {
      key: "f",
    });
    expect(screen.getByText("60-second speech")).toBeInTheDocument();
    expect(screen.queryByText("Nomination only · no ordinary speech")).toBeNull();
  });

  it.each(["before-shooting-count", "shooting-count"])(
    "records judge-selected %s occurrence and waits for a legal public announcement",
    async (stage) => {
      const user = userEvent.setup();
      const initial = beginNight(day());
      const changed = vi.fn();
      const accepted = vi.fn();
      render(<Harness initial={initial} changed={changed} accepted={accepted} />);
      openGeneralRemoval();
      await user.selectOptions(screen.getByLabelText("Discipline player"), "1");
      expect(screen.getByRole("button", { name: "Confirm discipline" })).toBeDisabled();
      await user.selectOptions(screen.getByLabelText("Occurrence timing"), stage);
      await user.selectOptions(screen.getByLabelText("Removal rule"), "6.2.2");
      await user.type(
        screen.getByLabelText("Discipline reason (optional)"),
        "Judge observed a violation",
      );
      await user.click(screen.getByRole("button", { name: "Confirm discipline" }));
      expect(accepted.mock.lastCall?.[0]).toEqual({
        type: "discipline.removal-observed",
        payload: {
          seat: 1,
          stage,
          rule: "6.2.2",
          reason: "Judge observed a violation",
          checkInProgress: false,
        },
      });
      expect(changed.mock.lastCall?.[0]).toMatchObject({
        disciplinaryRemovals: [
          {
            seat: 1,
            announcement: "pending",
            departure: stage === "shooting-count" ? "pending" : "departed",
          },
        ],
      });
      const announce = screen.getByRole("button", { name: "Announce removal of Player 1" });
      if (stage === "before-shooting-count") {
        expect(screen.getByRole("button", { name: "Evaluate Mafia shots" })).toBeDisabled();
        await user.click(announce);
        expect(screen.getByRole("button", { name: "Evaluate Mafia shots" })).toBeEnabled();
        expect(accepted.mock.lastCall?.[0]).toEqual({
          type: "discipline.removals-announced",
          payload: { seats: [1] },
        });
      } else {
        expect(announce).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Evaluate Mafia shots" }));
        expect(screen.getByRole("button", { name: "Announce removal of Player 1" })).toBeEnabled();
      }
    },
  );

  it("requires explicit fourth-foul timing and records the foul and removal atomically", async () => {
    const user = userEvent.setup();
    const initial = day();
    const changed = vi.fn();
    const accepted = vi.fn();
    render(
      <Harness
        initial={{
          ...initial,
          players: initial.players.map((p) =>
            p.seat === 2 ? { ...p, fouls: 3, mutePending: true } : p,
          ),
        }}
        changed={changed}
        accepted={accepted}
      />,
    );
    const card = document.querySelector('.seat-anchor[data-seat="2"] > .player-seat')!;
    fireEvent.touchStart(card, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ clientX: 100, clientY: 170 }] });
    expect(changed).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText("Occurrence timing"), "day-discussion");
    await user.type(
      screen.getByLabelText("Discipline reason (optional)"),
      "Fourth foul for speaking out of turn",
    );
    await user.click(screen.getByRole("button", { name: "Confirm discipline" }));
    expect(accepted.mock.lastCall?.[0]).toEqual({
      type: "discipline.foul-issued",
      payload: {
        seat: 2,
        foulNumber: 4,
        redCarded: true,
        removal: {
          seat: 2,
          stage: "day-discussion",
          rule: "6.2.1",
          reason: "Fourth foul for speaking out of turn",
          checkInProgress: false,
        },
      },
    });
    expect(changed.mock.lastCall?.[0]).toMatchObject({ ballotCancellationDay: 1 });
    expect(
      changed.mock.lastCall?.[0].players.find((p: { seat: number }) => p.seat === 2),
    ).toMatchObject({ fouls: 4, status: "red-carded" });
    expect(screen.getByRole("button", { name: "Next player" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Announce removal of Player 2" }));
    expect(screen.getByRole("button", { name: "Next player" })).toBeEnabled();
  });

  it("preserves an underway Don check then requires a separate public announcement before morning", async () => {
    const user = userEvent.setup();
    const initial = completeMafiaShots(resolveMafiaShots(beginNight(day())).game);
    const owner = initial.players.find((p) => p.role === "don")!;
    const changed = vi.fn();
    render(<Harness initial={initial} changed={changed} />);
    openGeneralRemoval();
    await user.selectOptions(screen.getByLabelText("Discipline player"), String(owner.seat));
    await user.selectOptions(screen.getByLabelText("Occurrence timing"), "don-check");
    await user.selectOptions(screen.getByLabelText("Removal rule"), "6.2.2");
    await user.type(
      screen.getByLabelText("Discipline reason (optional)"),
      "Check already physically underway",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "This player's check was already underway" }),
    );
    await user.click(screen.getByRole("button", { name: "Confirm discipline" }));
    expect(
      screen.getByRole("button", { name: "Announce removal of Player " + owner.seat }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip Don check" })).toBeDisabled();
    const target = initial.players.find((p) => p.seat !== owner.seat)!;
    await user.click(screen.getByRole("button", { name: "Don check Player " + target.seat }));
    await user.click(screen.getByRole("button", { name: "Proceed to Sheriff check" }));
    await user.click(screen.getByRole("button", { name: "Skip Sheriff check" }));
    expect(screen.getByRole("button", { name: "Announce morning" })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Announce removal of Player " + owner.seat }),
    );
    await user.click(screen.getByRole("button", { name: "Announce morning" }));
    expect(changed.mock.lastCall?.[0]).toMatchObject({
      phase: "day",
      day: 2,
      ballotCancellationDay: 2,
    });
  });

  it("allows a reasoned sanction on a departing shot victim without fabricating another departure", async () => {
    const user = userEvent.setup();
    let initial = bestMove();
    initial = applyGameEvent(initial, {
      type: "best-move.finalized",
      payload: { reason: "declined", readbackAcknowledged: true },
    });
    initial = completeNight(initial);
    const victim = initial.goodbyeSeats![0]!;
    const changed = vi.fn();
    render(<Harness initial={initial} changed={changed} />);
    openPenalty(victim);
    expect(screen.getByText("Farewell / night resolution")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Removal rule"), "6.2.2");
    await user.type(
      screen.getByLabelText("Discipline reason (optional)"),
      "Disqualified during farewell",
    );
    await user.click(screen.getByRole("button", { name: "Confirm discipline" }));
    expect(changed.mock.lastCall?.[0].ballotCancellationDay).toBeUndefined();
    expect(
      changed.mock.lastCall?.[0].players.filter((p: { status: string }) => p.status !== "active"),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: `Announce removal of Player ${victim}` }));
    expect(screen.getByRole("button", { name: "Begin day 1" })).toBeEnabled();
  });

  it("labels a later sole nominee departure instead of promising an unnecessary open ballot", () => {
    const initial = day();
    render(
      <Harness
        initial={{
          ...initial,
          day: 2,
          completedGameNights: 2,
          currentTurnIndex: 9,
          nominations: [{ nominatorSeat: 1, candidateSeat: 3, order: 1 }],
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Accept sole nominee departure" }),
    ).toBeInTheDocument();
  });
});
