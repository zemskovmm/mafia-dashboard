import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  advanceSetupPhase,
  applyGameEvent,
  beginRoleDraw,
  completeCurrentTurn,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  nominate,
  startVoting,
} from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState, PlayerInput } from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { VotingStage } from "./VotingStage.js";
import { GameUtilityPanels } from "../game/GameUtilityPanels.js";
import { expectServerAcceptsEvent } from "../../test-game-event-contract.js";

const votingGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `p-${index + 1}`,
    name: `Player ${index + 1}`,
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
      {showUtilities ? <GameUtilityPanels game={game} /> : null}
    </>
  );
};

describe("VotingStage", () => {
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

    await user.click(screen.getByRole("button", { name: /resolve voting/i }));
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
    await user.click(screen.getByRole("button", { name: "Resolve voting" }));

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

  it("keeps voting on the table and gives the last candidate every remaining vote", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn<(game: GameState, seats: readonly number[]) => void>();
    render(<Harness onResolved={onResolved} />);

    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Voting candidate" })).toHaveTextContent(
      "#4 Player 4",
    );
    await user.click(screen.getByRole("button", { name: /vote as player 4 for player 4/i }));
    const firstSelected = screen.getByRole("button", { name: /player 4 voted for seat 4/i });
    expect(firstSelected).toHaveClass("is-inactive", "is-voting-highlight");
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
    expect(screen.getAllByRole("button", { name: /voted for seat 6/i })).toHaveLength(3);
    expect(screen.getByRole("button", { name: /resolve voting/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /resolve voting/i }));

    expect(onResolved).toHaveBeenCalledWith(expect.any(Object), [4]);
  });
});
