import { useState } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as domain from "@mafia/game-domain";
import type {
  CanonicalGameEventDraft,
  GameLogEntry,
  GameState,
  ReplayFrame,
} from "@mafia/game-domain";
import { namedProfiles, renderWithProfiles } from "../../test-player-directory.js";
import { cancelDialog, swipeCard } from "../../test-card-gestures.js";
import { GameScreen } from "./GameScreen.js";

type View = "table" | "ledger";
const views = ["table", "ledger"] as const;
const otherView = (view: View): View => (view === "table" ? "ledger" : "table");
const planning = (): GameState => {
  let setup = domain.beginRoleDraw(
    domain.createSetup(
      Array.from({ length: 10 }, (_, index) => ({ id: `player-${index + 1}`, seat: index + 1 })),
    ),
    domain.createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  return domain.createGame(domain.completeRoleDraw(setup));
};
const day = () => {
  let game = planning();
  while (game.phase !== "day") game = domain.advanceOpeningPhase(game);
  return game;
};
const ballot = () =>
  domain.startVoting(
    domain.nominate(domain.completeCurrentTurn(domain.nominate(day(), 1, 2)), 2, 3),
  );
const closeTie = (initial: GameState) => {
  let game = domain.applyGameEvent(initial, {
    type: "voting.candidate-selected",
    payload: { candidateSeat: 2 },
  });
  for (let voterSeat = 1; voterSeat <= 5; voterSeat++)
    game = domain.applyGameEvent(game, {
      type: "vote.recorded",
      payload: { voterSeat, candidateSeat: 2 },
    });
  game = domain.applyGameEvent(game, {
    type: "voting.candidate-selected",
    payload: { candidateSeat: 3 },
  });
  return domain.applyGameEvent(game, {
    type: "voting.resolved",
    payload: {
      voteAssignments: game.voteAssignments as Record<number, number>,
      result: domain.resolveVote(game),
    },
  });
};
const collective = () => {
  let game = closeTie(ballot());
  while (game.phase === "car-crash") game = domain.completeCurrentTurn(game);
  return closeTie(game);
};
const bestMove = () => {
  let game = domain.beginNight(day());
  const victim = game.players.find((player) => player.role === "citizen")!;
  game = domain.completeMafiaShots(
    domain.resolveMafiaShots(domain.toggleAllMafiaShotsForTarget(game, victim.seat)).game,
  );
  return domain.completeNight(domain.skipSheriffCheck(domain.skipDonCheck(game)));
};
const phase = (to: GameState["phase"]): CanonicalGameEventDraft => ({
  type: "phase.changed",
  payload: { to },
});
// Build admitted history with the same canonical domain/replay boundary as the application.
const history = (initial: GameState) => {
  const baseline = domain.createInitialGameBaseline(initial);
  const entries: GameLogEntry[] = [];
  let game = initial;
  const h = {
    get game() {
      return game;
    },
    get frames(): readonly ReplayFrame[] {
      const replay = domain.replayGameLog(baseline, entries);
      expect(replay.game).toEqual(game);
      return replay.frames;
    },
    accept(draft: CanonicalGameEventDraft) {
      const accepted = domain.createGameLogEntry({
        gameId: "ledger-parity",
        id: `private-source-${entries.length + 1}`,
        sequence: entries.length + 1,
        parentEventId: entries.at(-1)?.id ?? null,
        createdAt: "2026-11-02T18:00:00.000Z",
        before: game,
        draft,
      });
      entries.push(accepted.entry);
      game = accepted.after;
      return game;
    },
  };
  h.accept({ type: "game.checkpointed", payload: {} });
  return h;
};
const kill = (game: GameState, targetSeat: number): CanonicalGameEventDraft => {
  const resolution = domain.resolveMafiaShots(
    domain.toggleAllMafiaShotsForTarget(game, targetSeat),
  );
  return {
    type: "mafia.shots-resolved",
    payload: { shots: resolution.secretShots, result: resolution.result },
  };
};
const deceasedOwners = () => {
  const h = history(day());
  const don = h.game.players.find((player) => player.role === "don")!.seat;
  const sheriff = h.game.players.find((player) => player.role === "sheriff")!.seat;
  h.accept(phase("night-mafia"));
  h.accept(kill(h.game, don));
  h.accept({ type: "don.check-skipped", payload: {} });
  h.accept({ type: "sheriff.check-skipped", payload: {} });
  h.accept(phase("best-move"));
  h.accept({ type: "best-move.skipped", payload: {} });
  h.accept(phase("goodbye-speech"));
  h.accept(phase("day"));
  h.accept({
    type: "player.nominated",
    payload: { nominatorSeat: h.game.turnOrder[0]!, candidateSeat: sheriff },
  });
  h.accept(phase("goodbye-speech"));
  h.accept(phase("night-mafia"));
  h.accept({ type: "mafia.shots-resolved", payload: { shots: [], result: { kind: "miss" } } });
  return h;
};

interface HarnessProps {
  initial: GameState;
  initialView: View;
  accepted: (draft: CanonicalGameEventDraft) => void;
  changed: (game: GameState) => void;
  finish: () => void;
  forcedView?: View;
  revision?: string;
  preview?: boolean;
  historyFrames?: readonly ReplayFrame[];
  finishGameState?: "ready" | "saved";
}
const Harness = ({
  initial,
  initialView,
  accepted,
  changed,
  finish,
  forcedView,
  revision,
  preview = false,
  historyFrames,
  finishGameState = "ready",
}: HarnessProps) => {
  const [game, setGame] = useState(initial);
  const [view, setView] = useState(initialView);
  const [phaseControlsTarget, setPhaseControlsTarget] = useState<HTMLDivElement | null>(null);
  const change = (next: GameState) => {
    setGame(next);
    changed(next);
  };
  return (
    <>
      <GameScreen
        game={game}
        phaseControlsTarget={phaseControlsTarget}
        gameName={revision}
        hostName="Host"
        privacyHidden
        hostView={forcedView ?? view}
        onHostViewChange={setView}
        historyFrames={historyFrames}
        mode={preview ? "preview" : "live"}
        onGameChange={change}
        onEvent={() => undefined}
        onFinishGame={finish}
        finishGameState={finishGameState}
        onAcceptedEvent={(draft) => {
          const next = domain.applyGameEvent(game, draft);
          accepted(draft);
          change(next);
          return next;
        }}
      />
      <aside className="live-side-panel">
        <div ref={setPhaseControlsTarget} />
      </aside>
    </>
  );
};
const mount = (initial: GameState, initialView: View, options: Partial<HarnessProps> = {}) => {
  let current = initial;
  const accepted = vi.fn<(draft: CanonicalGameEventDraft) => void>();
  const changed = vi.fn((next: GameState) => {
    current = next;
  });
  const finish = vi.fn();
  const props = { initial, initialView, accepted, changed, finish, ...options };
  const rendered = renderWithProfiles(<Harness {...props} />, namedProfiles("player-"));
  return {
    ...rendered,
    accepted,
    changed,
    finish,
    game: () => current,
    rerenderScreen: (overrides: Partial<HarnessProps>) =>
      rendered.rerender(<Harness {...props} {...overrides} />),
  };
};
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const click = (name: string | RegExp) => fireEvent.click(button(name));
const select = (name: string, value: string) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
const switchView = (view: View) => click(view === "table" ? "Table" : "Ledger");
const expectPhasePlacement = (view: View, control: HTMLElement) => {
  expect(
    control.closest(view === "ledger" ? ".live-side-panel" : ".table-workspace"),
  ).not.toBeNull();
  expect(document.querySelector(".game-ledger .ledger-phase-bar")).toBeNull();
};
const seat = (view: View, number: number) =>
  document.querySelector<HTMLElement>(
    view === "ledger" ? `[data-ledger-seat="${number}"]` : `.seat-anchor[data-seat="${number}"]`,
  )!;
const openPenalty = (view: View, number: number) => {
  if (view === "ledger") click(`Penalty for Player ${number}`);
  else swipeCard(seat(view, number).querySelector(".player-seat")!, 0, -80);
};
const expectLocked = (element: HTMLElement) => {
  // Table retains its gesture host; Ledger uses a disabled native row button.
  expect(element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true").toBe(
    true,
  );
};

describe.each(views)("%s host-controller parity", (view) => {
  it("advances the opening through accepted actions without creating checks or a view-change action", () => {
    const h = mount(planning(), view);
    expectPhasePlacement(view, button("Mafia asleep"));
    click("Mafia asleep");
    expect(h.game().phase).toBe("sheriff-identification");
    const greeting = h.game();
    switchView(otherView(view));
    switchView(view);
    expect(h.game()).toBe(greeting);
    expect(h.accepted).toHaveBeenCalledTimes(1);
    expect(h.changed).toHaveBeenCalledTimes(1);
    click("Begin round zero");
    expect(h.accepted.mock.calls.map(([draft]) => draft)).toEqual([
      phase("sheriff-identification"),
      phase("day"),
    ]);
    expect(h.game()).toMatchObject({
      phase: "day",
      day: 1,
      completedGameNights: 1,
      sheriffChecksPerformed: 0,
    });
    expect(h.game().players.every((player) => player.status === "active")).toBe(true);
  });

  it("records voters, freezes a disputed ballot, retains reviewed locks and accepts the ordinary result", () => {
    const h = mount(ballot(), view);
    expectPhasePlacement(view, button("Finish voting"));
    expect(button("Finish voting")).toBeDisabled();
    click("Vote as Player 1 for Player 2");
    click("Player 1 voted for seat 2");
    expect(h.game().voteAssignments).toEqual({});
    for (let voter = 1; voter <= 6; voter++) click(`Vote as Player ${voter} for Player 2`);
    openPenalty(view, 1);
    fireEvent.click(screen.getByText("Dispute count", { exact: true }));
    select("Dispute reason", "Count contested");
    click("Pause voting for review");
    cancelDialog(screen.getByRole("dialog"));
    expect(button("Next candidate")).toBeDisabled();
    expect(button("Finish voting")).toBeDisabled();
    expectLocked(button("Vote as Player 7 for Player 2"));
    const paused = h.game();
    fireEvent.click(button("Vote as Player 7 for Player 2"));
    switchView(otherView(view));
    switchView(view);
    expect(h.game()).toBe(paused);
    expectLocked(button("Vote as Player 7 for Player 2"));
    openPenalty(view, 1);
    select("Final ruling reason", "Recording confirms the count");
    expect(button("Accept final reviewed count")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I reviewed the external recording"));
    click("Accept final reviewed count");
    expect(h.game().ballot?.reviewedCandidateSeats).toEqual([2]);
    cancelDialog(screen.getByRole("dialog"));
    expectLocked(button("Player 1 voted for seat 2"));
    click("Next candidate");
    expect(h.accepted).toHaveBeenLastCalledWith({
      type: "voting.candidate-selected",
      payload: { candidateSeat: 3 },
    });
    expect(h.game().ballot?.selectedCandidateSeat).toBe(3);
    expectLocked(button("Player 1 voted for seat 2"));
    click("Player 7 voted for seat 3");
    expect(h.game().voteAssignments[7]).toBeUndefined();
    click("Vote as Player 7 for Player 3");
    const before = h.game();
    click("Finish voting");
    expect(h.accepted).toHaveBeenLastCalledWith({
      type: "voting.resolved",
      payload: {
        voteAssignments: before.voteAssignments,
        result: domain.resolveVote(before),
      },
    });
    expect(h.game()).toMatchObject({ phase: "goodbye-speech", goodbyeSeats: [2] });
  });

  it("preserves a partial collective draft both ways, continues and corrects it before explicit completion", () => {
    const initial = collective();
    expect(initial.phase).toBe("car-crash-decision");
    const h = mount(initial, view);
    click("Vote as Player 1 to eliminate all car-crash players");
    expectPhasePlacement(view, screen.getByLabelText("Lift vote for #2 · Player 2"));
    select("Lift vote for #2 · Player 2", "no");
    const partial = h.game();
    expect(partial.carCrashVotes).toEqual({ 1: true, 2: false });
    const changes = h.changed.mock.calls.length;
    switchView(otherView(view));
    expect(screen.getByLabelText("Lift vote for #1 · Player 1")).toHaveValue("yes");
    expectPhasePlacement(otherView(view), screen.getByLabelText("Lift vote for #1 · Player 1"));
    expect(screen.getByLabelText("Lift vote for #2 · Player 2")).toHaveValue("no");
    click("Vote as Player 3 to eliminate all car-crash players");
    switchView(view);
    expect(h.changed).toHaveBeenCalledTimes(changes + 1);
    expect(screen.getByLabelText("Lift vote for #3 · Player 3")).toHaveValue("yes");
    select("Lift vote for #1 · Player 1", "unassigned");
    expect(h.game().carCrashVotes?.[1]).toBeUndefined();
    click("Vote as Player 1 to eliminate all car-crash players");
    expect(h.accepted).not.toHaveBeenCalled();
    const draft = h.game();
    click("Resolve car crash");
    expect(h.accepted).toHaveBeenCalledExactlyOnceWith({
      type: "car-crash.count-completed",
      payload: {
        votes: { 1: true, 2: false, 3: true },
        result: domain.resolveCompletedCarCrashCount(draft),
      },
    });
    expect(h.game()).toMatchObject({
      phase: "car-crash-result",
      carCrashResult: { eliminate: false, yesVotes: 2, eligibleVoters: 10 },
    });
    expect(h.game().carCrashVotes?.[4]).toBeUndefined();
    click("Continue");
    expect(h.game().phase).toBe("night-mafia");
    expect(h.game().players.every((player) => player.status === "active")).toBe(true);
  });

  it.each(["living", "previously eliminated"] as const)(
    "completes Don and Sheriff checks for %s owners through their real windows",
    (owners) => {
      const previous = owners === "previously eliminated" ? deceasedOwners() : undefined;
      const initial =
        previous?.game ??
        domain.completeMafiaShots(domain.resolveMafiaShots(domain.beginNight(day())).game);
      const don = initial.players.find((player) => player.role === "don")!;
      const sheriff = initial.players.find((player) => player.role === "sheriff")!;
      const h = mount(initial, view, { historyFrames: previous?.frames });
      if (previous) {
        expect([don.status, sheriff.status]).toEqual(["eliminated", "eliminated"]);
        click("Continue night");
        expect(h.accepted).toHaveBeenLastCalledWith({
          type: "night.check-windows-opened",
          payload: { roles: ["don", "sheriff"] },
        });
      }
      expect(h.game().phase).toBe("night-don");
      click(`Don check Player ${sheriff.seat}`);
      expect(h.accepted).toHaveBeenLastCalledWith({
        type: "don.checked",
        payload: { targetSeat: sheriff.seat, match: true },
      });
      expect(screen.getByRole("status", { name: "Don check result" })).toHaveTextContent(
        "Sheriff found",
      );
      expectPhasePlacement(view, button("Proceed to Sheriff check"));
      const checked = h.game();
      switchView(otherView(view));
      switchView(view);
      expect(h.game()).toBe(checked);
      click("Proceed to Sheriff check");
      click(`Sheriff check Player ${don.seat}`);
      expect(h.accepted).toHaveBeenLastCalledWith({
        type: "sheriff.checked",
        payload: { targetSeat: don.seat, match: true },
      });
      expect(screen.getByRole("status", { name: "Sheriff check result" })).toHaveTextContent(
        "Mafia found",
      );
      click("Continue night");
      expect(h.game()).toMatchObject({ phase: "night-resolution", sheriffChecksPerformed: 1 });
      expect(h.game().players.find((player) => player.seat === don.seat)?.status).toBe(don.status);
      expect(h.game().players.find((player) => player.seat === sheriff.seat)?.status).toBe(
        sheriff.status,
      );
    },
  );

  it("keeps tentative Best Move selections through switches, records them and advances the morning goodbye", () => {
    const initial = bestMove();
    const targets = initial.players.filter(
      (player) => player.seat !== initial.bestMove!.playerSeat,
    );
    const h = mount(initial, view);
    const record = () => button("Record Best Move");
    expectPhasePlacement(view, record());
    expect(record()).toBeDisabled();
    expectLocked(button(`Select player ${initial.bestMove!.playerSeat} for Best Move`));
    click(`Select player ${targets[0]!.seat} for Best Move`);
    const partial = h.game();
    switchView(otherView(view));
    expect(h.game()).toBe(partial);
    click(`Select player ${targets[1]!.seat} for Best Move`);
    switchView(view);
    click(`Select player ${targets[2]!.seat} for Best Move`);
    expect(record()).toBeEnabled();
    expectLocked(button(`Select player ${targets[3]!.seat} for Best Move`));
    click(`Deselect player ${targets[0]!.seat} from Best Move`);
    expect(record()).toBeDisabled();
    click(`Select player ${targets[3]!.seat} for Best Move`);
    click("Record Best Move");
    expect(h.accepted).toHaveBeenLastCalledWith({ type: "best-move.recorded", payload: {} });
    expect(h.game()).toMatchObject({
      phase: "night-resolution",
      bestMove: {
        selectedSeats: targets.slice(1, 4).map((player) => player.seat),
        completionReason: "complete-list",
      },
    });
    click("Announce morning");
    expect(h.game()).toMatchObject({ phase: "goodbye-speech", day: 2 });
    click("Begin day 1");
    expect(h.game().phase).toBe("day");
    expect(
      h.accepted.mock.calls.filter(([draft]) => draft.type === "best-move.recorded"),
    ).toHaveLength(1);
  });

  it("preserves a valid penalty across parent rerenders/view changes, confirms it once and removes preview actions", () => {
    const h = mount(day(), view);
    openPenalty(view, 2);
    const dialog = screen.getByRole("dialog", { name: "Discipline penalty for #2 · Player 2" });
    select("Removal rule", "6.2.2");
    select("Discipline reason (optional)", "Observed misconduct");
    expect(button("Confirm discipline")).toBeEnabled();
    h.rerenderScreen({ revision: "Same game, refreshed parent", forcedView: otherView(view) });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByLabelText("Removal rule")).toHaveValue("6.2.2");
    expect(screen.getByLabelText("Discipline reason (optional)")).toHaveValue(
      "Observed misconduct",
    );
    expect(button("Confirm discipline")).toBeEnabled();
    expect(h.accepted).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
    click("Confirm discipline");
    expect(h.accepted).toHaveBeenCalledExactlyOnceWith({
      type: "discipline.removal-observed",
      payload: {
        seat: 2,
        stage: "day-discussion",
        rule: "6.2.2",
        reason: "Observed misconduct",
        checkInProgress: false,
      },
    });
    expect(h.game().players.find((player) => player.seat === 2)?.status).toBe("red-carded");
    const accepted = h.game();
    h.rerenderScreen({ preview: true, forcedView: "ledger" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector(".ledger-row-controls button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^(Penalty for|Foul|Nominate|Support) Player/ }),
    ).toBeNull();
    expect(button("Exit preview")).toBeEnabled();
    expectPhasePlacement("ledger", button("Exit preview"));
    h.rerenderScreen({ preview: true, forcedView: "table" });
    const card = seat("table", 3).querySelector(".player-seat")!;
    swipeCard(card, 0, -80);
    swipeCard(card, 0, 80);
    fireEvent.click(card);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.game()).toBe(accepted);
    expect(h.accepted).toHaveBeenCalledTimes(1);
  });

  it("keeps an accepted outcome distinct from Finish and retains the same Finish boundary in both views", () => {
    const initial = domain.completeNight(domain.skipBestMove(bestMove()));
    const offenderSeat = initial.players.find((player) => player.role === "don")!.seat;
    const h = mount(initial, view);
    expect(initial.phase).toBe("goodbye-speech");
    openPenalty(view, offenderSeat);
    select("Discipline action", "opponent-victory");
    select("Applicable rule", "6.3.5");
    select("Judge's reason", "Confirmed disciplinary loss");
    expect(button("Award victory to opposing team")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Required committee agreement obtained"));
    click("Award victory to opposing team");
    expect(h.accepted).toHaveBeenCalledExactlyOnceWith({
      type: "game.adjudicated",
      payload: {
        losingTeam: "black",
        offenderSeat,
        rule: "6.3.5",
        reason: "Confirmed disciplinary loss",
        committeeApproved: true,
      },
    });
    expect(h.game()).toMatchObject({ phase: "finished", winner: "red" });
    expect(h.finish).not.toHaveBeenCalled();
    const outcome = h.game();
    switchView(otherView(view));
    switchView(view);
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(h.accepted).toHaveBeenCalledTimes(1);
    expect(h.game()).toBe(outcome);
    expect(h.game().players).toEqual(initial.players);
    expectPhasePlacement(view, button("Finish the game"));
    click("Finish the game");
    expect(h.finish).toHaveBeenCalledOnce();
    h.rerenderScreen({ finishGameState: "saved" });
    expect(button("Game safely saved")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /^(Penalty for|Foul|Nominate) Player/ }),
    ).toBeNull();
  });
});

it.each(views)(
  "%s applies field-level DOM privacy through pending goodbye, night and completion exceptions",
  (view) => {
    const h = history(day());
    const victim = h.game.players.find((player) => player.role === "citizen")!.seat;
    const don = h.game.players.find((player) => player.role === "don")!.seat;
    const sheriff = h.game.players.find((player) => player.role === "sheriff")!.seat;
    h.accept(phase("night-mafia"));
    h.accept(kill(h.game, victim));
    h.accept(phase("night-don"));
    h.accept({ type: "don.checked", payload: { targetSeat: sheriff, match: true } });
    h.accept(phase("night-sheriff"));
    h.accept({ type: "sheriff.checked", payload: { targetSeat: don, match: true } });
    h.accept(phase("night-resolution"));
    const night = h.game;
    const nightFrames = h.frames;
    h.accept(phase("best-move"));
    h.accept({ type: "best-move.skipped", payload: {} });
    h.accept(phase("goodbye-speech"));
    const goodbye = h.game;
    const frames = h.frames;
    const props = {
      hostName: "Host",
      privacyHidden: true,
      hostView: view,
      onGameChange: vi.fn(),
      onEvent: vi.fn(),
      mode: "preview" as const,
    };
    const rendered = renderWithProfiles(
      <GameScreen {...props} game={goodbye} historyFrames={frames} />,
      namedProfiles("player-"),
    );
    for (const player of goodbye.players) {
      const row = seat(view, player.seat);
      expect(row.outerHTML).not.toMatch(
        /role-(?:citizen|sheriff|mafia|don)\b|data-role-glyph="(?:citizen|sheriff|mafia|don)"|aria-label="(?:Citizen|Sheriff|Mafia|Don)"/i,
      );
    }
    const victimRow = seat(view, victim);
    expect
      .soft(victimRow.outerHTML)
      .not.toMatch(/is-departed|status-eliminated|deceased-cross|\bEliminated\b/);
    expect(rendered.container.innerHTML).not.toMatch(
      /Don checked seat|Sheriff checked seat|Primary target:|Physical shot|Shooting result:|private-source-/,
    );
    rendered.rerender(<GameScreen {...props} game={night} historyFrames={nightFrames} />);
    expect(seat(view, don).innerHTML).toMatch(view === "ledger" ? /role-don/ : /aria-label="Don"/i);
    if (view === "ledger") {
      expect(
        within(seat(view, don)).getByText(`Don checked seat ${sheriff}: Sheriff`),
      ).toBeInTheDocument();
      expect(
        within(seat(view, sheriff)).getByText(`Sheriff checked seat ${don}: black team`),
      ).toBeInTheDocument();
    }
    const completed = domain.applyGameEvent(goodbye, {
      type: "game.adjudicated",
      payload: {
        losingTeam: "black",
        offenderSeat: don,
        rule: "6.3.5",
        reason: "Confirmed loss",
        committeeApproved: true,
      },
    });
    rendered.rerender(<GameScreen {...props} game={completed} historyFrames={frames} />);
    for (const player of completed.players) {
      expect(seat(view, player.seat).innerHTML).toMatch(
        new RegExp(view === "ledger" ? `role-${player.role}` : `aria-label="${player.role}"`, "i"),
      );
    }
    expect(props.onGameChange).not.toHaveBeenCalled();
    expect(props.onEvent).not.toHaveBeenCalled();
  },
);
