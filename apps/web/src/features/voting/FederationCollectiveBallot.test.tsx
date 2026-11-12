import { useState } from "react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as domain from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameLogEntry, GameState } from "@mafia/game-domain";
import { namedProfiles, renderWithProfiles } from "../../test-player-directory.js";
import { GameScreen } from "../game/GameScreen.js";
import type { HostView } from "../game/host-view-preferences.js";

const collectiveDecision = (): GameState => {
  let setup = domain.beginRoleDraw(
    domain.createSetup(
      Array.from({ length: 10 }, (_, index) => ({ id: `p-${index + 1}`, seat: index + 1 })),
    ),
    domain.createSeededRandom(9),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  let game = domain.createGame(domain.completeRoleDraw(setup));
  while (game.phase !== "day") game = domain.advanceOpeningPhase(game);
  game = domain.startVoting(
    domain.nominate(domain.completeCurrentTurn(domain.nominate(game, 1, 4)), 2, 6),
  );
  const finishTie = (initial: GameState) => {
    let ballot = domain.applyGameEvent(initial, {
      type: "voting.candidate-selected",
      payload: { candidateSeat: 4 },
    });
    for (let voterSeat = 1; voterSeat <= 5; voterSeat++)
      ballot = domain.applyGameEvent(ballot, {
        type: "vote.recorded",
        payload: { voterSeat, candidateSeat: 4 },
      });
    ballot = domain.applyGameEvent(ballot, {
      type: "voting.candidate-selected",
      payload: { candidateSeat: 6 },
    });
    return domain.applyGameEvent(ballot, {
      type: "voting.resolved",
      payload: {
        voteAssignments: ballot.voteAssignments as Record<number, number>,
        result: domain.resolveVote(ballot),
      },
    });
  };
  game = finishTie(game);
  while (game.phase === "car-crash") game = domain.completeCurrentTurn(game);
  return finishTie(game);
};

const mount = (view: HostView, initial = collectiveDecision(), preview = false) => {
  const baseline = domain.createInitialGameBaseline(initial);
  const root = domain.createGameLogEntry({
    gameId: "collective-card-regression",
    id: "root",
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-11-12T12:00:00.000Z",
    before: initial,
    draft: { type: "game.checkpointed", payload: {} },
  });
  const events: GameLogEntry[] = [root.entry];
  let canonical = root.after;
  let displayed = initial;
  const accepted = vi.fn<(draft: CanonicalGameEventDraft) => void>();
  const Harness = () => {
    const [game, setGame] = useState(initial);
    const [hostView, setHostView] = useState(view);
    displayed = game;
    return (
      <GameScreen
        game={game}
        hostView={hostView}
        onHostViewChange={setHostView}
        hostName="Host"
        privacyHidden
        mode={preview ? "preview" : "live"}
        historyFrames={domain.replayGameLog(baseline, events).frames}
        onGameChange={setGame}
        onEvent={() => undefined}
        onAcceptedEvent={(draft) => {
          accepted(draft);
          const created = domain.createGameLogEntry({
            gameId: "collective-card-regression",
            id: `accepted-${events.length + 1}`,
            sequence: events.length + 1,
            parentEventId: events.at(-1)?.id ?? null,
            createdAt: "2026-11-12T12:00:00.000Z",
            before: canonical,
            draft,
          });
          events.push(created.entry);
          canonical = created.after;
          setGame(created.after);
          return created.after;
        }}
      />
    );
  };
  renderWithProfiles(<Harness />, namedProfiles("p-"));
  return {
    game: () => displayed,
    accepted,
    replay: () => domain.replayGameLog(baseline, events).game,
  };
};
const card = (seat: number) =>
  screen.getByRole("button", {
    name: `Vote as Player ${seat} to eliminate all car-crash players`,
  });
const count = () => screen.getByRole("status", { name: "Car-crash decision" });

for (const view of ["table", "ledger"] as const) {
  describe(`${view} collective card actions through GameScreen`, () => {
    it("counts the first icon/name tap, toggles off/on, and preserves support feedback across views", async () => {
      const user = userEvent.setup();
      const h = mount(view);
      expect(h.game().phase).toBe("car-crash-decision");
      expect(h.game().carCrashVotes).toEqual({});
      const icon = view === "table" ? card(1).querySelector(".person-icon")! : card(1);
      await user.click(icon);
      expect(h.game().carCrashVotes).toEqual({ 1: true });
      expect(count()).toHaveTextContent("1 of 10 eliminate votes");
      expect(card(1)).toHaveAttribute("aria-pressed", "true");
      await user.click(card(1));
      expect(h.game().carCrashVotes).toEqual({ 1: false });
      expect(count()).toHaveTextContent("0 of 10 eliminate votes");
      expect(card(1)).toHaveAttribute("aria-pressed", "false");
      await user.click(screen.getByRole("button", { name: view === "table" ? "Ledger" : "Table" }));
      expect(card(1)).toHaveAttribute("aria-pressed", "false");
      await user.click(card(1));
      expect(h.game().carCrashVotes).toEqual({ 1: true });
      expect(card(1)).toHaveAttribute("aria-pressed", "true");
      expect(h.accepted).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Resolve car crash" }));
      expect(h.accepted).toHaveBeenCalledExactlyOnceWith({
        type: "car-crash.count-completed",
        payload: {
          votes: { 1: true },
          result: { eliminate: false, seats: [4, 6], yesVotes: 1, eligibleVoters: 10 },
        },
      });
      expect(h.game()).toEqual(h.replay());
      expect(h.game().carCrashVotes?.[2]).toBeUndefined();
    });

    it("finishes a toggled-off count at zero without assigning the untouched voters", async () => {
      const user = userEvent.setup();
      const h = mount(view);
      await user.click(card(1));
      await user.click(card(1));
      expect(card(1)).toHaveAttribute("aria-pressed", "false");
      if (view === "ledger") expect(card(1).closest("tr")).not.toHaveClass("is-selected");
      expect(count()).toHaveTextContent("0 of 10 eliminate votes");
      await user.click(screen.getByRole("button", { name: "Resolve car crash" }));
      expect(h.game()).toMatchObject({
        phase: "car-crash-result",
        carCrashVotes: { 1: false },
        carCrashResult: { eliminate: false, yesVotes: 0, eligibleVoters: 10 },
      });
      expect(h.game().carCrashVotes?.[2]).toBeUndefined();
      expect(h.game()).toEqual(h.replay());
    });

    it.each([0, 5, 6])(
      "explicitly completes %i supporting card taps without fabricating other votes",
      async (hands) => {
        const user = userEvent.setup();
        const h = mount(view);
        const finish = screen.getByRole("button", { name: "Resolve car crash" });
        expect(finish).toBeEnabled();
        for (let seat = 1; seat <= hands; seat++) await user.click(card(seat));
        expect(h.game().phase).toBe("car-crash-decision");
        expect(h.accepted).not.toHaveBeenCalled();
        expect(finish).toBeEnabled();
        await user.click(finish);
        expect(h.game()).toMatchObject({
          phase: "car-crash-result",
          carCrashVotes: Object.fromEntries(
            Array.from({ length: hands }, (_, index) => [index + 1, true]),
          ),
          carCrashResult: { eliminate: hands > 5, yesVotes: hands, eligibleVoters: 10 },
        });
        expect(h.game()).toEqual(h.replay());
        expect(h.game().carCrashVotes?.[10]).toBeUndefined();
        if (hands === 0) {
          expect(h.accepted).toHaveBeenCalledExactlyOnceWith({
            type: "car-crash.count-completed",
            payload: {
              votes: {},
              result: { eliminate: false, seats: [4, 6], yesVotes: 0, eligibleVoters: 10 },
            },
          });
          await user.click(screen.getByRole("button", { name: "Continue" }));
          expect(h.game().phase).toBe("night-mafia");
          expect(h.game().players.every((player) => player.status === "active")).toBe(true);
        }
      },
    );

    it("keeps correction in sync with card support, inactive voters disabled and roles private", async () => {
      const user = userEvent.setup();
      const initial = collectiveDecision();
      mount(view, {
        ...initial,
        players: initial.players.map((player) =>
          player.seat === 10 ? { ...player, status: "eliminated" } : player,
        ),
      });
      expect(card(10)).toBeDisabled();
      expect(screen.queryByText("Sheriff", { exact: true })).toBeNull();
      await user.click(screen.getByText("Correct transcription"));
      const correction = screen.getByLabelText("Lift vote for #1 · Player 1");
      await user.selectOptions(correction, "yes");
      expect(card(1)).toHaveAttribute("aria-pressed", "true");
      await user.selectOptions(correction, "no");
      expect(card(1)).toHaveAttribute("aria-pressed", "false");
      await user.selectOptions(correction, "unassigned");
      expect(card(1)).toHaveAttribute("aria-pressed", "false");
      expect(count()).toHaveTextContent("Unassigned votes: 9");
      if (view === "ledger") expect(within(card(1)).getByText("Role hidden")).toBeInTheDocument();
    });
  });
}
