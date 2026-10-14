import { useState } from "react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  advanceSetupPhase,
  applyGameEvent,
  resolveVote,
  beginRoleDraw,
  completeCurrentTurn,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  nominate,
  selectVotingCandidate,
  startVoting,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState, PlayerInput } from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { VotingStage } from "./VotingStage.js";
import { GameUtilityPanels } from "../game/GameUtilityPanels.js";
import { FederationDisciplineControls } from "../game/FederationDisciplineControls.js";
import { expectServerAcceptsEvent } from "../../test-game-event-contract.js";
import { namedProfiles, renderWithProfiles } from "../../test-player-directory.js";

const render = (ui: Parameters<typeof renderWithProfiles>[0]) =>
  renderWithProfiles(ui, namedProfiles("p-"));

const votingGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `p-${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(9));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  let game = advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
  game = nominate(game, 1, 4);
  game = completeCurrentTurn(game);
  game = nominate(game, 2, 6);
  return startVoting(game);
};

const Harness = ({
  onResolved,
  showUtilities = false,
}: {
  onResolved: (game: GameState, seats: readonly number[]) => void;
  showUtilities?: boolean;
}) => {
  const [game, setGame] = useState(votingGame);
  return (
    <>
      <VotingStage
        game={game}
        onGameChange={setGame}
        onResolved={onResolved}
        onEvent={() => undefined}
      />
      {showUtilities ? (
        <GameUtilityPanels
          game={game}
          onSelectVotingCandidate={(seat) =>
            setGame((current) => selectVotingCandidate(current, seat))
          }
        />
      ) : null}
    </>
  );
};

const federationVotingGame = (nominees = [4, 6]): GameState => {
  const players = Array.from({ length: 10 }, (_, index) => ({
    id: `p-${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(
    createSetup(players, { rulesEdition: "mafgame-2026-07-01" }),
    createSeededRandom(9),
  );
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  let game = createGame(completeRoleDraw(setup));
  while (game.phase !== "day") game = advanceSetupPhase(game);
  for (const [index, seat] of nominees.entries()) {
    game = nominate(game, index + 1, seat);
    if (index < nominees.length - 1) game = completeCurrentTurn(game);
  }
  return startVoting(game);
};

const stoppedFederationBallot = (initial: GameState, votes: Record<number, number>): GameState => {
  let game = applyGameEvent(initial, { type: "voting.order-announced", payload: {} });
  game = applyGameEvent(game, { type: "voting.order-announced", payload: {} });
  for (const [index, candidateSeat] of game.turnOrder.entries()) {
    game = applyGameEvent(game, { type: "voting.candidate-mentioned", payload: { candidateSeat } });
    game = applyGameEvent(game, { type: "voting.candidate-mentioned", payload: { candidateSeat } });
    for (const [voter, candidate] of Object.entries(votes)) {
      if (candidate === candidateSeat && game.voteAssignments[Number(voter)] === undefined)
        game = applyGameEvent(game, {
          type: "vote.accepted",
          payload: { voterSeat: Number(voter), candidateSeat },
        });
    }
    game = applyGameEvent(game, { type: "voting.candidate-stopped", payload: { candidateSeat } });
    if (index < game.turnOrder.length - 1)
      game = applyGameEvent(game, {
        type: "voting.live-advanced",
        payload: { candidateSeat: game.turnOrder[index + 1]! },
      });
  }
  return game;
};

const repeatedFederationBallot = (initial: GameState, votes: Record<number, number>): GameState => {
  let game = stoppedFederationBallot(initial, votes);
  game = applyGameEvent(game, {
    type: "voting.resolved",
    payload: { voteAssignments: votes, result: resolveVote(game) },
  });
  while (game.phase === "car-crash") game = completeCurrentTurn(game);
  return stoppedFederationBallot(game, votes);
};

const FederationHarness = ({
  initial = federationVotingGame(),
  onAccepted = () => undefined,
}: {
  initial?: GameState;
  onAccepted?: (event: CanonicalGameEventDraft) => void;
}) => {
  const [game, setGame] = useState(initial);
  return (
    <>
      <output data-testid="federation-state">{JSON.stringify(game)}</output>
      <FederationDisciplineControls
        game={game}
        request={null}
        onGameChange={setGame}
        onEvent={() => undefined}
        onAcceptedEvent={(event) => {
          onAccepted(event);
          setGame((current) => applyGameEvent(current, event));
        }}
      />
      <VotingStage
        game={game}
        onGameChange={setGame}
        onResolved={() => undefined}
        onEvent={() => undefined}
        onAcceptedEvent={(event) => {
          onAccepted(event);
          setGame((current) => applyGameEvent(current, event));
        }}
        onFoul={() => undefined}
      />
      <GameUtilityPanels
        game={game}
        onSelectVotingCandidate={(seat) =>
          setGame((current) =>
            applyGameEvent(current, {
              type: "voting.candidate-selected",
              payload: { candidateSeat: seat },
            }),
          )
        }
      />
    </>
  );
};

const federationState = (): GameState =>
  JSON.parse(screen.getByTestId("federation-state").textContent!) as GameState;

describe("Federation voting", () => {
  it.each([
    ["en", "Rules", "Dispute count", "Dispute reason"],
    ["ru", "Правила", "Оспорить подсчёт", "Причина спора"],
  ] as const)(
    "keeps %s review drafts accessible across keyboard dismissal",
    async (locale, label, dispute, reason) => {
      const user = userEvent.setup();
      render(
        <I18nProvider locale={locale}>
          <FederationHarness />
        </I18nProvider>,
      );
      const toggle = screen.getByRole("button", { name: label });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      toggle.focus();
      await user.keyboard("{Enter}");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      await user.keyboard("{Escape}");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveFocus();
      await user.keyboard("{Enter}");
      const sheet = screen.getByRole("dialog", { name: label });
      await user.click(within(sheet).getByText(dispute));
      await user.type(within(sheet).getByLabelText(reason), "Recorded draft");
      await user.keyboard("{Escape}");
      expect(toggle).toHaveFocus();
      expect(sheet).not.toBeVisible();
      await user.keyboard("{Enter}");
      expect(sheet).toBeVisible();
      expect(within(sheet).getByLabelText(reason)).toHaveValue("Recorded draft");
    },
  );

  it("allows a host-recorded count to be disputed without announcement clicks", async () => {
    const user = userEvent.setup();
    render(<FederationHarness />);
    await user.click(screen.getByRole("button", { name: "Vote as Player 1 for Player 4" }));
    await user.click(screen.getByRole("button", { name: "Rules" }));
    await user.click(screen.getByText("Dispute count"));
    await user.type(screen.getByLabelText("Dispute reason"), "Count contested");
    const pause = screen.getByRole("button", { name: "Pause voting for review" });
    expect(pause).toBeEnabled();
    await user.click(pause);
    expect(federationState().ballot?.dispute?.candidateSeat).toBe(4);
  });

  it("uses the canonical federation resolver even without the accepted-event callback", async () => {
    const user = userEvent.setup();
    const game = stoppedFederationBallot(federationVotingGame(), {
      1: 4,
      2: 4,
      3: 4,
      4: 4,
      5: 4,
      6: 4,
    });
    const onGameChange = vi.fn();
    const onResolved = vi.fn();
    render(
      <VotingStage
        game={game}
        onGameChange={onGameChange}
        onResolved={onResolved}
        onEvent={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Finish voting" }));
    expect(onResolved).not.toHaveBeenCalled();
    expect(onGameChange.mock.calls[0]?.[0]).toMatchObject({
      phase: "goodbye-speech",
      goodbyeSeats: [4],
    });
  });

  it("names a legal disciplinary cancellation rather than presenting a generic host skip", () => {
    const game = applyGameEvent(federationVotingGame(), {
      type: "discipline.removal-observed",
      payload: {
        seat: 1,
        stage: "open-voting",
        rule: "6.2.1",
        reason: "Judge observed violation",
        checkInProgress: false,
      },
    });
    render(<FederationHarness initial={game} />);
    expect(federationState().phase).toBe("voting-cancelled");
    expect(
      screen.getByText(
        "A disciplinary removal cancels this day’s ballot under the rules. Proceed to night without a voted-out player or farewell speech.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Voting was skipped by the host.")).toBeNull();
  });

  it.each(["nine-three", "later-five"])(
    "permits a lift only at valid rule boundaries (%s)",
    (kind) => {
      const nominees = kind === "nine-three" ? [4, 6, 8] : [4, 6, 7, 8, 9];
      const initial = federationVotingGame(nominees);
      const active = kind === "nine-three" ? 9 : 10;
      const game: GameState = {
        ...initial,
        day: 3,
        completedGameNights: 3,
        sheriffChecksPerformed: 2,
        players: initial.players.map((p) =>
          active === 9 && p.seat === 10 ? { ...p, status: "eliminated" } : p,
        ),
      };
      const votes = Object.fromEntries(
        Array.from({ length: active }, (_, index) => [
          index + 1,
          nominees[Math.floor(index / (active / nominees.length))]!,
        ]),
      );
      const repeated = repeatedFederationBallot(game, votes);
      const decision = applyGameEvent(repeated, {
        type: "voting.resolved",
        payload: { voteAssignments: votes, result: resolveVote(repeated) },
      });
      render(<FederationHarness initial={decision} />);
      expect(federationState().phase).toBe("car-crash-decision");
      expect(screen.getByLabelText("Lift vote for #1 · Player 1")).toBeEnabled();
      expect(screen.getByRole("button", { name: "Resolve car crash" })).toBeEnabled();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it.each([0, 2, 5, 6])(
    "explicitly completes a permitted collective count with %i hands, preserving unknown votes",
    async (count) => {
      const user = userEvent.setup();
      const votes = Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [index + 1, index < 5 ? 4 : 6]),
      );
      const repeated = repeatedFederationBallot(federationVotingGame(), votes);
      const decision = applyGameEvent(repeated, {
        type: "voting.resolved",
        payload: { voteAssignments: votes, result: resolveVote(repeated) },
      });
      const events = vi.fn();
      render(<FederationHarness initial={decision} onAccepted={events} />);
      expect(screen.queryByRole("button", { name: "Skip voting" })).toBeNull();
      expect(screen.getByRole("button", { name: "Resolve car crash" })).toBeEnabled();
      for (let seat = 1; seat <= count; seat += 1) {
        await user.selectOptions(
          screen.getByLabelText(`Lift vote for #${seat} · Player ${seat}`),
          "yes",
        );
        expect(screen.getByRole("button", { name: "Resolve car crash" })).toBeEnabled();
      }
      const recorded = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [index + 1, true]),
      );
      expect(federationState().carCrashVotes).toEqual(recorded);
      await user.click(screen.getByRole("button", { name: "Resolve car crash" }));
      expect(federationState().phase).toBe("car-crash-result");
      expect(federationState().carCrashVotes).toEqual(recorded);
      expect(federationState().carCrashResult?.eliminate).toBe(count > 5);
      expect(events).toHaveBeenLastCalledWith({
        type: "car-crash.count-completed",
        payload: {
          votes: recorded,
          result: { eliminate: count > 5, seats: [4, 6], yesVotes: count, eligibleVoters: 10 },
        },
      });
      await expectServerAcceptsEvent(decision, events.mock.lastCall![0]);
      if (count <= 5) {
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(federationState().phase).toBe("night-mafia");
        expect(federationState().players.every((p) => p.status === "active")).toBe(true);
      }
    },
  );

  it("explains the zero-round five-way restriction after a complete repeat-vote journey", async () => {
    const user = userEvent.setup();
    const nominees = [4, 6, 7, 8, 9];
    const votes = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [index + 1, nominees[Math.floor(index / 2)]!]),
    );
    const game = repeatedFederationBallot(federationVotingGame(nominees), votes);
    render(<FederationHarness initial={game} />);
    await user.click(screen.getByRole("button", { name: "Finish voting" }));
    expect(federationState().phase).toBe("car-crash-skipped");
    expect(federationState().ballotSkipReason).toBe("zero-round-five");
    expect(
      screen.getByText(
        "Five players tied again on the zero round. No collective-lift ballot is held; proceed to night without elimination or farewell speeches.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "All active players are tied. Eliminating everyone would leave no way to determine a winner.",
      ),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve car crash" })).toBeNull();
    expect(screen.getByRole("button", { name: "Begin night" })).toBeEnabled();
    expect(screen.getByRole("region", { name: "Rule-specific skip explanation" })).toHaveAttribute(
      "tabindex",
      "0",
    );
  });

  it.each([
    [2, 2],
    [3, 1],
    [1, 0],
  ])(
    "explains the nine/three AND gate without exposing private counters (%i nights, %i checks)",
    (nights, checks) => {
      const initial = federationVotingGame([4, 6, 8]);
      const game: GameState = {
        ...initial,
        day: nights,
        completedGameNights: nights,
        sheriffChecksPerformed: checks,
        players: initial.players.map((p) => (p.seat === 10 ? { ...p, status: "eliminated" } : p)),
      };
      const votes = Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [index + 1, [4, 6, 8][Math.floor(index / 3)]!]),
      );
      const repeated = repeatedFederationBallot(game, votes);
      const skipped = applyGameEvent(repeated, {
        type: "voting.resolved",
        payload: { voteAssignments: votes, result: resolveVote(repeated) },
      });
      render(<FederationHarness initial={skipped} />);
      expect(
        screen.getByText(
          "Three tied players with nine active: collective lift is unavailable until the third official night is completed AND at least two actual Sheriff checks have been performed. Proceed to night without elimination or farewell speeches.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Checks performed:|Sheriff result|Sheriff target/)).toBeNull();
    },
  );
  it("permits nine/three lift only after both boundaries, with a strict majority", async () => {
    const user = userEvent.setup();
    const initial = federationVotingGame([4, 6, 8]);
    const game: GameState = {
      ...initial,
      day: 3,
      completedGameNights: 3,
      sheriffChecksPerformed: 2,
      players: initial.players.map((p) => (p.seat === 10 ? { ...p, status: "eliminated" } : p)),
    };
    const votes = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [index + 1, [4, 6, 8][Math.floor(index / 3)]!]),
    );
    render(<FederationHarness initial={repeatedFederationBallot(game, votes)} />);
    await user.click(screen.getByRole("button", { name: "Finish voting" }));
    expect(federationState().phase).toBe("car-crash-decision");
    expect(screen.queryByText(/Checks performed:|Sheriff result|Sheriff target/)).toBeNull();
    for (let seat = 1; seat <= 4; seat += 1)
      await user.selectOptions(
        screen.getByLabelText(`Lift vote for #${seat} · Player ${seat}`),
        "yes",
      );
    expect(screen.getByRole("button", { name: "Resolve car crash" })).toBeEnabled();
    await user.selectOptions(screen.getByLabelText("Lift vote for #5 · Player 5"), "yes");
    await user.click(screen.getByRole("button", { name: "Resolve car crash" }));
    expect(federationState().carCrashResult).toEqual({
      eliminate: true,
      seats: [4, 6, 8],
      yesVotes: 5,
      eligibleVoters: 9,
    });
    expect(Object.keys(federationState().carCrashVotes!)).toHaveLength(5);
  });

  it("permits a later five-way repeated tie rather than applying the zero-round restriction", async () => {
    const user = userEvent.setup();
    const nominees = [4, 6, 7, 8, 9];
    const votes = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [index + 1, nominees[Math.floor(index / 2)]!]),
    );
    const initial = { ...federationVotingGame(nominees), day: 2, completedGameNights: 2 };
    render(<FederationHarness initial={repeatedFederationBallot(initial, votes)} />);
    await user.click(screen.getByRole("button", { name: "Finish voting" }));
    expect(federationState().phase).toBe("car-crash-decision");
    expect(screen.getByRole("button", { name: "Resolve car crash" })).toBeEnabled();
    expect(screen.queryByText(/Five players tied again on the zero round/)).toBeNull();
  });

  it("retains nomination order for a shrinking tie instead of starting a collective lift", async () => {
    const user = userEvent.setup();
    const nominees = [4, 6, 7, 8, 9];
    const votes = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [index + 1, nominees[Math.floor(index / 2)]!]),
    );
    let game = stoppedFederationBallot(federationVotingGame(nominees), votes);
    game = applyGameEvent(game, {
      type: "voting.resolved",
      payload: { voteAssignments: votes, result: resolveVote(game) },
    });
    while (game.phase === "car-crash") game = completeCurrentTurn(game);
    const shrinkingVotes = { 1: 4, 2: 4, 3: 4, 4: 6, 5: 6, 6: 6, 7: 7, 8: 7, 9: 7, 10: 8 };
    render(<FederationHarness initial={stoppedFederationBallot(game, shrinkingVotes)} />);
    await user.click(screen.getByRole("button", { name: "Finish voting" }));
    expect(federationState().phase).toBe("car-crash");
    expect(federationState().turnOrder).toEqual([4, 6, 7]);
    expect(screen.queryByRole("button", { name: "Resolve car crash" })).toBeNull();
  });

  it("offers an explicit determined early close without STOP or fabricated uncast remainder", async () => {
    const user = userEvent.setup();
    let game = federationVotingGame();
    const drafts: CanonicalGameEventDraft[] = [
      { type: "voting.order-announced", payload: {} },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 4 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 4 } },
    ];
    for (const event of drafts) game = applyGameEvent(game, event);
    for (let voterSeat = 1; voterSeat <= 6; voterSeat += 1)
      game = applyGameEvent(game, {
        type: "vote.accepted",
        payload: { voterSeat, candidateSeat: 4 },
      });
    const events = vi.fn();
    render(<FederationHarness initial={game} onAccepted={events} />);
    expect(screen.getByRole("button", { name: "Finish voting" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Player 1 voted for seat 4" }));
    await user.click(screen.getByRole("button", { name: "Vote as Player 1 for Player 4" }));
    expect(
      within(screen.getByRole("region", { name: "Mafia table" })).getByRole("button", {
        name: "Finish voting",
      }),
    ).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Finish voting" }));
    expect(federationState().phase).toBe("goodbye-speech");
    expect(federationState().voteAssignments).toEqual({ 1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4 });
    expect(events).toHaveBeenLastCalledWith({
      type: "voting.resolved",
      payload: {
        voteAssignments: { 1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4 },
        result: { kind: "winner", seats: [4], totals: { 4: 6, 6: 0 } },
      },
    });
  });

  it("does not offer early close for a merely leading STOPped candidate", async () => {
    let game = federationVotingGame();
    const drafts: CanonicalGameEventDraft[] = [
      { type: "voting.order-announced", payload: {} },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 4 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 4 } },
    ];
    for (const event of drafts) game = applyGameEvent(game, event);
    for (let voterSeat = 1; voterSeat <= 5; voterSeat += 1)
      game = applyGameEvent(game, {
        type: "vote.accepted",
        payload: { voterSeat, candidateSeat: 4 },
      });
    game = applyGameEvent(game, {
      type: "voting.candidate-stopped",
      payload: { candidateSeat: 4 },
    });
    render(<FederationHarness initial={game} />);
    expect(screen.queryByRole("button", { name: "Close determined result" })).toBeNull();
    expect(screen.getByRole("button", { name: "Finish voting" })).toBeDisabled();
  });

  it("freezes a disputed count through restoration until an acknowledged external-review final ruling", async () => {
    const user = userEvent.setup();
    let game = federationVotingGame();
    const drafts: CanonicalGameEventDraft[] = [
      { type: "voting.order-announced", payload: {} },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 4 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 4 } },
      { type: "vote.accepted", payload: { voterSeat: 1, candidateSeat: 4 } },
    ];
    for (const event of drafts) game = applyGameEvent(game, event);
    const events = vi.fn();
    const { rerender } = render(<FederationHarness initial={game} onAccepted={events} />);
    await user.click(screen.getByRole("button", { name: "Rules" }));
    await user.click(screen.getByText("Dispute count"));
    expect(screen.getByRole("button", { name: "Pause voting for review" })).toBeDisabled();
    await user.type(screen.getByLabelText("Dispute reason"), "Count contested");
    await user.click(screen.getByRole("button", { name: "Pause voting for review" }));
    expect(federationState().ballot?.dispute).toEqual({
      candidateSeat: 4,
      reason: "Count contested",
    });
    const paused = JSON.parse(JSON.stringify(federationState())) as GameState;
    rerender(<FederationHarness key="restored" initial={paused} onAccepted={events} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Voting paused — technical dispute");

    expect(screen.getByRole("button", { name: "Next candidate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Finish voting" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Vote as Player 2 for Player 4" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Foul Player 2" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Rules" }));
    await user.selectOptions(screen.getByLabelText("Reviewed vote for #1 · Player 1"), "6");
    await user.type(screen.getByLabelText("Final ruling reason"), "Recording confirms seat six");
    const rule = screen.getByRole("button", { name: "Accept final reviewed count" });
    expect(rule).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "I reviewed the external recording" }));
    await user.click(rule);
    expect(federationState().voteAssignments).toEqual({ 1: 6 });
    expect(federationState().ballot?.dispute).toBeUndefined();
    expect(federationState().ballot?.finalRuling).toEqual({
      candidateSeat: 4,
      reason: "Recording confirms seat six",
      externalReviewAcknowledged: true,
    });
    expect(screen.getByRole("button", { name: "Next candidate" })).toBeEnabled();
    expect(
      screen.getByText(
        "Reviewed ruling is final for ordinary appeals. Clerical correction remains separate.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByText("Dispute count"));
    expect(screen.getByRole("button", { name: "Pause voting for review" })).toBeDisabled();
    expect(events).toHaveBeenCalledWith({
      type: "voting.count-ruled",
      payload: {
        voteAssignments: { 1: 6 },
        externalReviewAcknowledged: true,
        reason: "Recording confirms seat six",
      },
    });
  });

  it("requires a reasoned transcription correction without recasting or moving the live cursor", async () => {
    const user = userEvent.setup();
    let game = federationVotingGame();
    const drafts: CanonicalGameEventDraft[] = [
      { type: "voting.order-announced", payload: {} },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 4 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 4 } },
      { type: "vote.accepted", payload: { voterSeat: 1, candidateSeat: 4 } },
      { type: "voting.candidate-stopped", payload: { candidateSeat: 4 } },
      { type: "voting.live-advanced", payload: { candidateSeat: 6 } },
    ];
    for (const event of drafts) game = applyGameEvent(game, event);
    const events = vi.fn();
    render(<FederationHarness initial={game} onAccepted={events} />);
    await user.click(screen.getByRole("button", { name: "Rules" }));
    await user.click(screen.getByText("Correct transcription"));
    expect(screen.getByRole("button", { name: "Apply transcription correction" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Corrected vote"), "6");
    await user.type(screen.getByLabelText("Correction reason"), "Wrong seat entered");
    await user.click(screen.getByRole("button", { name: "Apply transcription correction" }));
    expect(federationState().voteAssignments).toEqual({ 1: 6 });
    expect(federationState().currentTurnIndex).toBe(1);
    expect(federationState().ballot?.mention).toBe(0);
    expect(events).toHaveBeenCalledWith({
      type: "vote.corrected",
      payload: { voterSeat: 1, candidateSeat: 6, reason: "Wrong seat entered" },
    });
    await user.selectOptions(screen.getByLabelText("Corrected vote"), "unassigned");
    await user.type(screen.getByLabelText("Correction reason"), "Duplicate entry");
    await user.click(screen.getByRole("button", { name: "Apply transcription correction" }));
    expect(federationState().voteAssignments).toEqual({});
  });

  it("records and corrects votes with direct taps and deliberate final-candidate selection", async () => {
    const user = userEvent.setup();
    const events = vi.fn();
    render(<FederationHarness onAccepted={events} />);
    expect(screen.queryByRole("button", { name: "Skip voting" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Announce full order|Mention candidate|STOP/ }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Next candidate" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Vote as Player 1 for Player 4" }));
    const accepted = screen.getByRole("button", { name: "Player 1 voted for seat 4" });
    await user.click(accepted);
    expect(federationState().voteAssignments).toEqual({});
    await user.click(screen.getByRole("button", { name: "Vote as Player 1 for Player 4" }));
    await user.click(screen.getByRole("button", { name: "Next candidate" }));
    expect(Object.keys(federationState().voteAssignments)).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: "Player 1 voted for seat 4" }));
    expect(federationState().voteAssignments[1]).toBe(6);
    await user.click(screen.getByRole("button", { name: "Player 1 voted for seat 6" }));
    expect(federationState().voteAssignments[1]).toBeUndefined();
    expect(federationState().ballot).toMatchObject({
      orderAnnouncements: 0,
      mention: 0,
      stopped: false,
    });
    expect(events).toHaveBeenCalledWith({
      type: "vote.recorded",
      payload: { voterSeat: 1, candidateSeat: 4 },
    });
    expect(events).toHaveBeenCalledWith({
      type: "voting.candidate-selected",
      payload: { candidateSeat: 6 },
    });
  });
});

describe("VotingStage", () => {
  it("does not enable Finish for a full-looking but invalid ballot", () => {
    const game = votingGame();
    const invalid = {
      ...game,
      voteAssignments: Object.fromEntries(game.players.map(({ seat }) => [seat, 9])),
    };
    render(
      <VotingStage
        game={invalid}
        onGameChange={() => undefined}
        onResolved={() => undefined}
        onEvent={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Finish voting" })).toBeDisabled();
  });

  it("submits an explicit completed ballot only once even if Finish is clicked twice", async () => {
    const user = userEvent.setup();
    const game = votingGame();
    const complete = {
      ...game,
      voteAssignments: Object.fromEntries(game.players.map(({ seat }) => [seat, 4])),
    };
    const onAcceptedEvent = vi.fn();
    render(
      <VotingStage
        game={complete}
        onGameChange={() => undefined}
        onResolved={() => undefined}
        onEvent={() => undefined}
        onAcceptedEvent={onAcceptedEvent}
      />,
    );
    const finish = screen.getByRole("button", { name: "Finish voting" });
    await user.click(finish);
    await user.click(finish);
    expect(onAcceptedEvent).toHaveBeenCalledTimes(1);
    expect(onAcceptedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "voting.resolved",
        payload: expect.objectContaining({ voteAssignments: complete.voteAssignments }),
      }),
    );
  });

  it("highlights the candidate only in voting order while board highlights track votes", async () => {
    const user = userEvent.setup();
    render(<Harness onResolved={() => undefined} showUtilities />);
    const table = screen.getByRole("region", { name: "Mafia table" });
    const order = screen.getByRole("region", { name: "Voting order" });
    const rows = within(order).getAllByRole("listitem");
    const candidate = screen.getByRole("button", { name: /vote as player 4 for player 4/i });

    expect(table.querySelector(".is-current")).toBeNull();
    expect(table.querySelector("[aria-current]")).toBeNull();
    expect(candidate).not.toHaveClass("is-voting-highlight");
    expect(rows[0]).toHaveClass("is-voting-highlight");
    expect(rows[0]).toHaveAttribute("aria-current", "step");
    expect(rows[1]).not.toHaveClass("is-voting-highlight");

    await user.click(candidate);
    expect(candidate).toHaveClass("is-voting-highlight");
    expect(candidate).not.toHaveClass("is-current");
    await user.click(candidate);
    expect(candidate).not.toHaveClass("is-voting-highlight");
    expect(rows[0]).toHaveClass("is-voting-highlight");

    await user.click(screen.getByRole("button", { name: /vote as player 1 for player 4/i }));
    const voter = screen.getByRole("button", { name: /player 1 voted for seat 4/i });
    expect(voter).toHaveClass("is-voting-highlight");
    await user.click(screen.getByRole("button", { name: "Next candidate" }));
    expect(rows[0]).not.toHaveClass("is-voting-highlight");
    expect(rows[0]).not.toHaveAttribute("aria-current");
    expect(rows[1]).toHaveClass("is-voting-highlight");
    expect(rows[1]).toHaveAttribute("aria-current", "step");
    expect(voter).not.toHaveClass("is-voting-highlight");
    expect(table.querySelector(".is-current")).toBeNull();
    expect(table.querySelectorAll(".is-voting-highlight")).toHaveLength(9);

    await user.click(screen.getByRole("button", { name: "Skip voting" }));
    expect(order.querySelector(".is-voting-highlight")).toBeNull();
    expect(order.querySelector("[aria-current]")).toBeNull();
  });

  it("emits a car-crash ballot that the server accepts unchanged", async () => {
    const user = userEvent.setup();
    const game: GameState = {
      ...votingGame(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };
    const onAcceptedEvent = vi.fn<(event: CanonicalGameEventDraft) => void>();
    render(
      <VotingStage
        game={game}
        onGameChange={() => undefined}
        onResolved={() => undefined}
        onEvent={() => undefined}
        onAcceptedEvent={onAcceptedEvent}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Resolve car crash" }));
    expect(onAcceptedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "car-crash.ballot-resolved" }),
    );
    await expectServerAcceptsEvent(game, onAcceptedEvent.mock.calls[0]![0]);
  });

  it("renders voting controls, labels, and plural status in Russian", () => {
    render(
      <I18nProvider locale="ru">
        <VotingStage
          game={votingGame()}
          onGameChange={() => undefined}
          onResolved={() => undefined}
          onEvent={() => undefined}
          onFoul={() => undefined}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("group", { name: "Кандидат голосования" })).toHaveTextContent(
      "Кандидат 1 из 2",
    );
    expect(screen.getByText("#4 Player 4")).toBeInTheDocument();
    expect(screen.getByText("0 голосов")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Следующий кандидат" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Завершить голосование" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Пропустить голосование" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Проголосовать игроком Player 1 за Player 4" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Фол: Player 1" })).toBeInTheDocument();
  });

  it("shows a cancellation step when the host skips voting", async () => {
    const user = userEvent.setup();
    const onGameChange = vi.fn<(game: GameState) => void>();
    const onEvent = vi.fn<(type: string, payload: Record<string, unknown>) => void>();
    render(
      <VotingStage
        game={votingGame()}
        onGameChange={onGameChange}
        onResolved={() => undefined}
        onEvent={onEvent}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Skip voting" }));

    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "voting-cancelled",
        votingCancellation: { reason: "host-skipped" },
      }),
    );
    expect(onEvent).toHaveBeenCalledWith("voting.skipped", {
      day: 1,
      reason: "host-skipped",
    });
  });

  it.each([
    ["voting", () => votingGame()],
    [
      "car-crash-decision",
      () => ({
        ...votingGame(),
        phase: "car-crash-decision" as const,
        carCrashSeats: [4, 6],
        carCrashVotes: {},
      }),
    ],
  ])("emits a replayable voting skip from %s", async (_phase, createState) => {
    const user = userEvent.setup();
    const game = createState();
    const onAcceptedEvent = vi.fn<(event: CanonicalGameEventDraft) => void>();
    render(
      <VotingStage
        game={game}
        onGameChange={() => undefined}
        onResolved={() => undefined}
        onEvent={() => undefined}
        onAcceptedEvent={onAcceptedEvent}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Skip voting" }));

    expect(onAcceptedEvent).toHaveBeenCalledWith({
      type: "voting.skipped",
      payload: { reason: "host-skipped" },
    });
    const event = onAcceptedEvent.mock.calls[0]?.[0];
    expect(event).toBeDefined();
    if (event === undefined) throw new Error("Expected an accepted voting event");
    expect(applyGameEvent(game, event)).toMatchObject({
      phase: "voting-cancelled",
      votingCancellation: { reason: "host-skipped" },
    });
  });

  it("explains why voting was cancelled before night begins", async () => {
    const user = userEvent.setup();
    const onGameChange = vi.fn<(game: GameState) => void>();
    render(
      <VotingStage
        game={{
          ...votingGame(),
          phase: "voting-cancelled",
          voteAssignments: {},
          votingCancellation: { reason: "red-card" },
        }}
        onGameChange={onGameChange}
        onResolved={() => undefined}
        onEvent={() => undefined}
      />,
    );

    expect(screen.getByRole("status", { name: "Voting cancelled" })).toHaveTextContent(
      "A player received a red card, so voting is cancelled for this day.",
    );
    await user.click(screen.getByRole("button", { name: "Begin night" }));
    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "night-mafia",
        nominations: [],
        votingCancellation: undefined,
      }),
    );
  });

  it("presents the same simple-majority ballot after a two-player repeated tie", () => {
    const game: GameState = {
      ...votingGame(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };

    render(
      <VotingStage
        game={game}
        onGameChange={() => undefined}
        onResolved={() => undefined}
        onEvent={() => undefined}
      />,
    );

    expect(screen.getByText("Eliminate all players voting")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Eliminate both nominees" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep both nominees" })).toBeNull();
  });

  it.each([
    {
      phase: "voting-cancelled" as const,
      state: { votingCancellation: { reason: "host-skipped" as const } },
    },
    {
      phase: "car-crash-decision" as const,
      state: { carCrashSeats: [4, 6], carCrashVotes: {} },
    },
    {
      phase: "car-crash-result" as const,
      state: {
        carCrashSeats: [4, 6],
        carCrashVotes: Object.fromEntries(
          Array.from({ length: 10 }, (_, index) => [index + 1, false]),
        ),
        carCrashResult: { eliminate: false, seats: [4, 6], yesVotes: 0, eligibleVoters: 10 },
      },
    },
    {
      phase: "car-crash-skipped" as const,
      state: { carCrashSeats: [4, 6], carCrashVotes: {} },
    },
  ])("keeps Foul controls visible during $phase", async ({ phase, state }) => {
    const user = userEvent.setup();
    const onFoul = vi.fn<(seat: number) => void>();
    render(
      <VotingStage
        game={{ ...votingGame(), phase, ...state }}
        onGameChange={() => undefined}
        onResolved={() => undefined}
        onEvent={() => undefined}
        onFoul={onFoul}
      />,
    );

    expect(screen.getAllByRole("button", { name: /^Foul Player/i })).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: "Foul Player 1" }));
    expect(onFoul).toHaveBeenCalledWith(1);
  });

  it("uses a zero-valid eliminate-all ballot without separate decision buttons", async () => {
    const user = userEvent.setup();
    const game: GameState = {
      ...votingGame(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6, 8],
      carCrashVotes: {},
    };

    const DecisionHarness = () => {
      const [current, setCurrent] = useState(game);
      return (
        <>
          <output data-testid="decision-phase">{current.phase}</output>
          <VotingStage
            game={current}
            onGameChange={setCurrent}
            onResolved={() => undefined}
            onEvent={() => undefined}
          />
        </>
      );
    };
    render(<DecisionHarness />);

    expect(screen.getByText("Eliminate all players voting")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Eliminate all nominees" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep all nominees" })).toBeNull();
    const resolve = screen.getByRole("button", { name: "Resolve car crash" });
    expect(resolve).toBeEnabled();
    await user.click(resolve);
    expect(screen.getByRole("status", { name: "Car-crash result" })).toHaveTextContent(
      "Players stay",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("decision-phase")).toHaveTextContent("night-mafia");
  });

  it("keeps Resolve and Skip voting enabled with zero eliminate-all votes", async () => {
    const user = userEvent.setup();
    const game: GameState = {
      ...votingGame(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6, 8],
      carCrashVotes: {},
    };
    const onGameChange = vi.fn<(game: GameState) => void>();
    const onEvent = vi.fn<(type: string, payload: Record<string, unknown>) => void>();
    render(
      <VotingStage
        game={game}
        onGameChange={onGameChange}
        onResolved={() => undefined}
        onEvent={onEvent}
      />,
    );

    expect(screen.getByRole("button", { name: "Resolve car crash" })).toBeEnabled();
    const skip = screen.getByRole("button", { name: "Skip voting" });
    expect(skip).toBeEnabled();
    await user.click(skip);

    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "voting-cancelled",
        votingCancellation: { reason: "host-skipped" },
      }),
    );
    expect(onEvent).toHaveBeenCalledWith("voting.skipped", {
      day: 1,
      reason: "host-skipped",
    });
  });

  it("keeps every active player available for the eliminate-all ballot", () => {
    const game: GameState = {
      ...votingGame(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };
    render(
      <VotingStage
        game={game}
        onGameChange={() => undefined}
        onResolved={() => undefined}
        onEvent={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /^vote as player 1 /i })).not.toHaveClass(
      "is-inactive",
    );
    expect(screen.getByRole("button", { name: /^vote as player 4 /i })).not.toHaveClass(
      "is-inactive",
    );
  });

  it("moves a tied vote into canonical car-crash speeches", async () => {
    const user = userEvent.setup();
    const base = votingGame();
    const tied: GameState = {
      ...base,
      currentTurnIndex: base.nominations.length - 1,
      voteAssignments: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [index + 1, index < 5 ? 4 : 6]),
      ),
    };
    const onGameChange = vi.fn<(game: GameState) => void>();
    const props = {
      onGameChange,
      onResolved: () => undefined,
      onEvent: () => undefined,
    };
    render(<VotingStage {...props} game={tied} />);

    await user.click(screen.getByRole("button", { name: /finish voting/i }));
    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "car-crash",
        turnOrder: [4, 6],
        currentTurnIndex: 0,
        voteAssignments: {},
      }),
    );
  });

  it("moves an all-player repeated tie to the skipped-ballot message", async () => {
    const user = userEvent.setup();
    const base = votingGame();
    const activeSeats = base.players
      .filter(({ status }) => status === "active")
      .map(({ seat }) => seat);
    const game: GameState = {
      ...base,
      nominations: activeSeats.map((seat, index) => ({
        nominatorSeat: seat,
        candidateSeat: seat,
        order: index + 1,
      })),
      turnOrder: activeSeats,
      currentTurnIndex: activeSeats.length - 1,
      votingRound: "repeat",
      carCrashSeats: activeSeats,
      voteAssignments: Object.fromEntries(activeSeats.map((seat) => [seat, seat])),
    };
    const onGameChange = vi.fn<(game: GameState) => void>();

    render(
      <VotingStage
        game={game}
        onGameChange={onGameChange}
        onResolved={() => undefined}
        onEvent={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Finish voting" }));

    expect(onGameChange).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "car-crash-skipped", carCrashSeats: activeSeats }),
    );
  });

  it("explains a skipped eliminate-all ballot before beginning night", async () => {
    const user = userEvent.setup();
    const base = votingGame();
    const activeSeats = base.players
      .filter(({ status }) => status === "active")
      .map(({ seat }) => seat);
    const game: GameState = {
      ...base,
      phase: "car-crash-skipped",
      carCrashSeats: activeSeats,
      carCrashVotes: undefined,
      voteAssignments: {},
    };
    const onAcceptedEvent = vi.fn<(event: CanonicalGameEventDraft) => void>();

    render(
      <VotingStage
        game={game}
        onGameChange={() => undefined}
        onResolved={() => undefined}
        onEvent={() => undefined}
        onAcceptedEvent={onAcceptedEvent}
      />,
    );

    expect(screen.getByText("Eliminate-all vote skipped")).toBeInTheDocument();
    expect(
      screen.getByText(
        "All active players are tied. Eliminating everyone would leave no way to determine a winner.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Eliminate all nominees" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Begin night" }));
    expect(onAcceptedEvent).toHaveBeenCalledWith({
      type: "phase.changed",
      payload: { to: "night-mafia" },
    });
    const event = onAcceptedEvent.mock.calls[0]?.[0];
    expect(event).toBeDefined();
    if (event === undefined) throw new Error("Expected an accepted phase change");
    expect(applyGameEvent(game, event)).toMatchObject({
      phase: "night-mafia",
      carCrashSeats: undefined,
      carCrashVotes: undefined,
    });
  });

  it("does not bypass an unresolved all-player car-crash decision", () => {
    const base = votingGame();
    const activeSeats = base.players
      .filter(({ status }) => status === "active")
      .map(({ seat }) => seat);
    const game: GameState = {
      ...base,
      phase: "car-crash-decision",
      carCrashSeats: activeSeats,
      carCrashVotes: {},
      voteAssignments: {},
    };

    render(
      <VotingStage
        game={game}
        onGameChange={() => undefined}
        onResolved={() => undefined}
        onEvent={() => undefined}
      />,
    );

    expect(screen.getByRole("group", { name: "Car-crash decision" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve car crash" })).toBeInTheDocument();
    expect(screen.queryByText("Eliminate-all vote skipped")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Begin night" })).not.toBeInTheDocument();
  });

  it("toggles a player's vote by tapping the same card again", async () => {
    const user = userEvent.setup();
    render(<Harness onResolved={() => undefined} />);

    await user.click(screen.getByRole("button", { name: /vote as player 1 for player 4/i }));
    const selectedCard = screen.getByRole("button", { name: /player 1 voted for seat 4/i });
    expect(selectedCard).toHaveClass("is-voting-highlight");
    expect(screen.getByText("1 vote")).toBeInTheDocument();

    await user.click(selectedCard);

    expect(screen.getByRole("button", { name: /vote as player 1 for player 4/i })).not.toHaveClass(
      "is-voting-highlight",
    );
    expect(screen.getByText("0 votes")).toBeInTheDocument();
  });

  it("corrects automatic votes and finishes a complete ballot from an earlier nominee", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn<(game: GameState, seats: readonly number[]) => void>();
    render(<Harness onResolved={onResolved} showUtilities />);

    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Voting candidate" })).toHaveTextContent(
      "#4 Player 4",
    );
    const finish = screen.getByRole("button", { name: "Finish voting" });
    expect(finish).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /vote as player 4 for player 4/i }));
    const firstSelected = screen.getByRole("button", { name: /player 4 voted for seat 4/i });
    expect(firstSelected).toHaveClass("is-voted", "is-voting-highlight");
    expect(firstSelected).not.toHaveClass("is-inactive");
    await user.click(screen.getByRole("button", { name: /vote as player 1 for player 4/i }));
    expect(screen.getByRole("button", { name: /player 1 voted for seat 4/i })).toHaveClass(
      "is-voting-highlight",
    );
    expect(firstSelected).toHaveClass("is-voting-highlight");
    for (const seat of [2, 3, 5, 6, 7]) {
      await user.click(
        screen.getByRole("button", {
          name: new RegExp(`vote as player ${seat} for player 4`, "i"),
        }),
      );
    }
    await user.click(screen.getByRole("button", { name: /next candidate/i }));

    const firstCandidateVoters = screen.getAllByRole("button", { name: /voted for seat 4/i });
    const autoAssignedVoters = screen.getAllByRole("button", { name: /voted for seat 6/i });
    expect(firstCandidateVoters).toHaveLength(7);
    expect(
      firstCandidateVoters.every((card) => !card.classList.contains("is-voting-highlight")),
    ).toBe(true);
    expect(autoAssignedVoters).toHaveLength(3);
    expect(autoAssignedVoters.every((card) => card.classList.contains("is-voting-highlight"))).toBe(
      true,
    );
    expect(screen.getByText("3 votes")).toBeInTheDocument();
    await user.click(autoAssignedVoters[0]!);
    expect(screen.getAllByRole("button", { name: /voted for seat 6/i })).toHaveLength(2);
    expect(finish).toBeDisabled();
    const order = screen.getByRole("region", { name: "Voting order" });
    await user.click(within(order).getByRole("button", { name: /player 4/i }));
    expect(finish).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /vote as player 8 for player 4/i }));
    expect(finish).toBeEnabled();
    await user.click(finish);

    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ voteAssignments: expect.objectContaining({ 8: 4 }) }),
      [4],
    );
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});
