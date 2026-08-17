import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  setMusicState,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { GameScreen } from "./GameScreen.js";

const createNegotiationGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(setMusicState(createSetup(players), "playing"), createSeededRandom(13));
  for (let seat = 1; seat <= 10; seat += 1) {
    setup = drawRoleForSeat(setup, seat);
  }
  return createGame(completeRoleDraw(setup));
};

const Harness = ({
  onEvent,
}: {
  onEvent: (type: string, payload: Record<string, unknown>) => void;
}) => {
  const [game, setGame] = useState(createNegotiationGame);
  return <GameScreen game={game} onGameChange={setGame} onEvent={onEvent} />;
};

describe("GameScreen", () => {
  it("signals setup phases, runs timers, and enters the rotating first day", async () => {
    const user = userEvent.setup();
    const onEvent = vi.fn<(type: string, payload: Record<string, unknown>) => void>();
    render(<Harness onEvent={onEvent} />);

    expect(screen.getByRole("heading", { name: /mafia negotiation/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /seat \d+: player/i })).toHaveLength(10);
    expect(screen.getByLabelText(/host position/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /start 60 second timer/i }));
    expect(onEvent).toHaveBeenCalledWith("timer.started", { seconds: 60 });
    await user.click(screen.getByRole("button", { name: /continue to sheriff wake-up/i }));

    expect(screen.getByRole("heading", { name: /sheriff wake-up/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /start 10 second timer/i }));
    expect(onEvent).toHaveBeenCalledWith("timer.started", { seconds: 10 });
    await user.click(screen.getByRole("button", { name: /begin day one/i }));

    expect(screen.getByRole("heading", { name: /day 1/i })).toBeInTheDocument();
    expect(screen.getByText(/current turn: player 1/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /seat 1: player 1/i })).toHaveAttribute(
      "aria-current",
      "step",
    );

    await user.click(screen.getByRole("button", { name: /start player 1 turn/i }));
    expect(onEvent).toHaveBeenCalledWith("turn.started", { seat: 1, seconds: 60 });
  });
});
