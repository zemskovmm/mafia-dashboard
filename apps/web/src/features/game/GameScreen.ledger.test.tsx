import { useState } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  advanceOpeningPhase,
  applyGameEvent,
  beginNight,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createInitialGameBaseline,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type GameState,
} from "@mafia/game-domain";
import { namedProfiles, renderWithProfiles } from "../../test-player-directory.js";
import { GameScreen } from "./GameScreen.js";
import { createSampleGameHistory } from "../timeline/sample-game-data.js";
import { projectLedger } from "../ledger/ledger-model.js";

const planningGame = () => {
  let setup = beginRoleDraw(
    createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `player-${i + 1}`, seat: i + 1 }))),
    createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat++) setup = drawRoleForSeat(setup, seat);
  return createGame(completeRoleDraw(setup));
};
const dayGame = () => {
  let game = planningGame();
  while (game.phase !== "day") game = advanceOpeningPhase(game);
  return game;
};
const recordedHistory = (initial: GameState, drafts: readonly CanonicalGameEventDraft[]) => {
  const baseline = createInitialGameBaseline(initial);
  const entries: GameLogEntry[] = [];
  let game = initial;
  const checkpoint: CanonicalGameEventDraft = { type: "game.checkpointed", payload: {} };
  for (const draft of [checkpoint, ...drafts]) {
    const result = createGameLogEntry({
      gameId: "ledger-presentation-test",
      id: `entry-${entries.length + 1}`,
      sequence: entries.length + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: "2026-11-02T18:00:00.000Z",
      before: game,
      draft,
    });
    entries.push(result.entry);
    game = result.after;
  }
  return replayGameLog(baseline, entries);
};
const Harness = ({
  initial = dayGame(),
  accepted = vi.fn(),
  preview = false,
}: {
  initial?: GameState;
  accepted?: (event: CanonicalGameEventDraft) => void;
  preview?: boolean;
}) => {
  const [game, setGame] = useState(initial);
  const [hostView, setHostView] = useState<"table" | "ledger">("table");
  return (
    <>
      <output data-testid="game-state">{JSON.stringify(game)}</output>
      <GameScreen
        game={game}
        hostName="Host"
        privacyHidden={false}
        hostView={hostView}
        onHostViewChange={setHostView}
        mode={preview ? "preview" : "live"}
        onGameChange={setGame}
        onEvent={() => undefined}
        onAcceptedEvent={(event) => {
          accepted(event);
          const next = applyGameEvent(game, event);
          setGame(next);
          return next;
        }}
      />
    </>
  );
};
const render = (ui: Parameters<typeof renderWithProfiles>[0]) =>
  renderWithProfiles(ui, namedProfiles("player-"));
const snapshot = () => screen.getByTestId("game-state").textContent;

describe("interchangeable host presentations", () => {
  it.each(["opening", "zero round", "unavailable history"])(
    "reserves four blank day/night pairs without a planning column during %s",
    (stage) => {
      const game = stage === "opening" ? planningGame() : dayGame();
      const before = JSON.stringify(game);
      render(
        <GameScreen
          game={game}
          hostName="Host"
          hostView="ledger"
          historyFrames={stage === "unavailable history" ? undefined : []}
          privacyHidden={false}
          onGameChange={vi.fn()}
          onEvent={vi.fn()}
        />,
      );
      const ledger = screen.getByRole("table", { name: "Game ledger" });
      const headings = within(ledger).getAllByRole("columnheader");
      expect(headings).toHaveLength(10);
      expect(ledger).not.toHaveTextContent(/Planning|Night 1\b/);
      expect(headings[2]).toHaveTextContent("Zero round");
      expect(headings[2]).not.toHaveTextContent("Night");
      expect(headings[3]).toHaveTextContent("Night 2");
      expect(headings[8]).toHaveTextContent("Day 3");
      expect(headings[9]).toHaveTextContent("Night 5");
      for (const heading of headings.slice(stage === "opening" ? 2 : 3)) {
        expect(heading).not.toHaveClass("ledger-current-day");
      }
      expect(ledger.querySelectorAll("thead .ledger-current-day")).toHaveLength(
        stage === "opening" ? 0 : 1,
      );
      expect(ledger.querySelectorAll("tbody td[data-ledger-period]")).toHaveLength(80);
      for (const cell of ledger.querySelectorAll("tbody td:not(.ledger-actions)")) {
        expect(cell).toBeEmptyDOMElement();
      }
      if (stage === "unavailable history") {
        expect(screen.getByText("Earlier history unavailable")).toBeInTheDocument();
      }
      expect(JSON.stringify(game)).toBe(before);
    },
  );
  it.each(["live", "preview"] as const)("marks only the active day or night in %s", (mode) => {
    for (const period of ["day", "night"] as const) {
      const game = period === "day" ? dayGame() : beginNight(dayGame());
      const view = render(
        <GameScreen
          game={game}
          hostName="Host"
          hostView="ledger"
          mode={mode}
          privacyHidden={false}
          onGameChange={vi.fn()}
          onEvent={vi.fn()}
        />,
      );
      const ledger = screen.getByRole("table", { name: "Game ledger" });
      const current = ledger.querySelectorAll("thead .ledger-current-day");
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveAttribute("data-ledger-period", period);
      expect(current[0]).toHaveAttribute("data-ledger-day", "1");
      view.unmount();
    }
  });
  it("keeps a recorded kill visible without filling other cells with placeholders in live and Preview", () => {
    const sample = createSampleGameHistory();
    const index = sample.frames.findIndex(
      ({ entry }) => entry.type === "mafia.shots-resolved" && entry.payload.result.kind === "kill",
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const source = sample.frames[index]!;
    if (source.entry.type !== "mafia.shots-resolved") throw new Error("Expected a shooting result");
    const { game, frames } = recordedHistory(source.before, [
      { type: "mafia.shots-resolved", payload: source.entry.payload },
    ]);
    const before = JSON.stringify({ game, frames });
    const model = projectLedger({ game, frames, privacyHidden: false });
    const expectedFacts = model.rows.flatMap(({ cells }) =>
      cells.filter(({ day }) => day > 0).flatMap(({ facts }) => facts),
    );
    for (const mode of ["live", "preview"] as const) {
      const view = render(
        <GameScreen
          game={game}
          hostName="Host"
          hostView="ledger"
          privacyHidden={false}
          historyFrames={frames}
          mode={mode}
          onGameChange={vi.fn()}
          onEvent={vi.fn()}
        />,
      );
      const ledger = screen.getByRole("table", { name: "Game ledger" });
      expect(ledger).not.toHaveTextContent(/Planning|Night 1\b/);
      expect(ledger.querySelectorAll(".ledger-fact")).toHaveLength(expectedFacts.length);
      expect(
        within(ledger).getAllByText(/Shooting result: seat \d+ killed/).length,
      ).toBeGreaterThan(0);
      const empty = [...ledger.querySelectorAll("tbody td:not(.ledger-actions)")].filter(
        (cell) => !cell.querySelector(".ledger-fact"),
      );
      expect(empty.length).toBeGreaterThan(0);
      for (const cell of empty) expect(cell).toBeEmptyDOMElement();
      view.unmount();
    }
    expect(JSON.stringify({ game, frames })).toBe(before);
  });
  it.each(["live", "preview"] as const)(
    "leaves non-voting player cells clean in %s without removing history or personal actions",
    (mode) => {
      const { game, frames } = recordedHistory(dayGame(), [
        { type: "foul.issued", payload: { seat: 2, foulNumber: 1, redCarded: false } },
        { type: "voting.legally-skipped", payload: { reason: "no-nominees" } },
      ]);
      expect(frames.at(-1)!.entry.type).toBe("voting.legally-skipped");
      const before = JSON.stringify({ game, frames });
      render(
        <GameScreen
          game={game}
          historyFrames={frames}
          hostView="ledger"
          hostName="Host"
          privacyHidden={false}
          mode={mode}
          onGameChange={vi.fn()}
          onEvent={vi.fn()}
        />,
      );
      const ledger = screen.getByRole("table", { name: "Game ledger" });
      expect(ledger).not.toHaveTextContent(/Ballot.*skipped/);
      expect(ledger.querySelectorAll(".ledger-fact")).toHaveLength(1);
      const foulCell = ledger.querySelector('[data-ledger-seat="2"] td[data-ledger-period="day"]');
      expect(foulCell).toHaveTextContent("Foul 1");
      for (const cell of ledger.querySelectorAll("tbody td[data-ledger-period]")) {
        if (cell !== foulCell) expect(cell).toBeEmptyDOMElement();
      }
      expect(JSON.stringify({ game, frames })).toBe(before);
    },
  );
  it("separates mixed player history into matching day/night cells without repeated ballot notices", () => {
    const { game, frames } = createSampleGameHistory();
    const model = projectLedger({ game, frames, privacyHidden: false });
    const before = JSON.stringify({ game, frames });
    render(
      <GameScreen
        game={game}
        historyFrames={frames}
        hostView="ledger"
        hostName="Host"
        privacyHidden={false}
        onGameChange={vi.fn()}
        onEvent={vi.fn()}
      />,
    );
    const ledger = screen.getByRole("table", { name: "Game ledger" });
    expect(ledger).not.toHaveTextContent(/Ballot \d+: (skipped|closed|cancelled|count disputed)/);
    for (const row of model.rows) {
      for (const cell of row.cells.filter(({ day }) => day > 0)) {
        for (const period of ["day", "night"] as const) {
          const rendered = ledger.querySelector(
            `[data-ledger-seat="${row.seat}"] td[data-ledger-day="${cell.day}"][data-ledger-period="${period}"]`,
          )!;
          expect(rendered).not.toBeNull();
          const expected = cell.facts.filter(
            (fact) => fact.period === period && !fact.kind.startsWith("ballot"),
          );
          expect(rendered.querySelectorAll(".ledger-fact")).toHaveLength(expected.length);
          expect(rendered).not.toHaveTextContent(
            period === "day"
              ? /Shooting result|Primary target|Don checked|Sheriff checked/
              : /Nominated seat|voted for seat|collective removal/,
          );
          if (!expected.length) expect(rendered).toBeEmptyDOMElement();
        }
      }
    }
    expect(JSON.stringify({ game, frames })).toBe(before);
  });
  it("switches the same game and routes ledger nomination/foul actions through the existing controller", () => {
    const accepted = vi.fn();
    render(<Harness accepted={accepted} />);
    const before = snapshot();
    fireEvent.click(screen.getByRole("button", { name: "Ledger" }));
    expect(screen.getByRole("table", { name: "Game ledger" })).toBeInTheDocument();
    expect(screen.getByText("Earlier history unavailable")).toBeInTheDocument();
    expect(document.querySelector(".ledger-footnote")).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(11);
    expect(snapshot()).toBe(before);
    expect(accepted).not.toHaveBeenCalled();
    const row = document.querySelector('[data-ledger-seat="2"]')! as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /^Nominate / }));
    expect(accepted).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "nomination.selection-set" }),
    );
    fireEvent.click(within(row).getByRole("button", { name: /^Foul / }));
    expect(accepted).toHaveBeenLastCalledWith(expect.objectContaining({ type: "foul.issued" }));
    const after = snapshot();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(document.querySelector(".round-table")).not.toBeNull();
    expect(snapshot()).toBe(after);
    expect(accepted).toHaveBeenCalledTimes(2);
  });
  it("keeps the shooting draft and phase-owned observation mode across renderer changes", () => {
    render(<Harness initial={beginNight(dayGame())} />);
    fireEvent.click(screen.getByRole("button", { name: "Ledger" }));
    const row = document.querySelector('[data-ledger-seat="2"]')! as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /assign all/i }));
    const draft = snapshot();
    const observation = screen.getByRole("button", { name: /multiple shooting/i });
    fireEvent.click(observation);
    expect(observation).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(snapshot()).toBe(draft);
    expect(screen.getByRole("button", { name: /multiple shooting/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Ledger" }));
    expect(snapshot()).toBe(draft);
    expect(screen.getByRole("button", { name: /multiple shooting/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  it("keeps history preview non-mutating in either view", () => {
    const accepted = vi.fn();
    render(<Harness accepted={accepted} preview />);
    const before = snapshot();
    fireEvent.click(screen.getByRole("button", { name: "Ledger" }));
    expect(screen.getByRole("button", { name: "Exit preview" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^Foul / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Nominate / })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(snapshot()).toBe(before);
    expect(accepted).not.toHaveBeenCalled();
  });
});
