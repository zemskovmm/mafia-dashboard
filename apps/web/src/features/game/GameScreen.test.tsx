import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  advanceSetupPhase,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { GameScreen } from "./GameScreen.js";

const createNegotiationGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(13));
  for (let seat = 1; seat <= 10; seat += 1) {
    setup = drawRoleForSeat(setup, seat);
  }
  return createGame(completeRoleDraw(setup));
};

const Harness = ({
  onEvent,
  onUndo = () => undefined,
  undoCount = 0,
}: {
  onEvent: (type: string, payload: Record<string, unknown>) => void;
  onUndo?: () => void;
  undoCount?: number;
}) => {
  const [game, setGame] = useState(createNegotiationGame);
  return (
    <GameScreen
      game={game}
      hostName="Host Player"
      onGameChange={setGame}
      onEvent={onEvent}
      onUndo={onUndo}
      undoCount={undoCount}
    />
  );
};

describe("GameScreen", () => {
  it("shows the selected host at the table", () => {
    render(<Harness onEvent={() => undefined} />);
    expect(screen.getByText("Host Player")).toBeInTheDocument();
  });

  it("offers the available game action undo history", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const { rerender } = render(
      <Harness onEvent={() => undefined} onUndo={onUndo} undoCount={2} />,
    );

    await user.click(screen.getByRole("button", { name: /undo last action.*2 available/i }));
    expect(onUndo).toHaveBeenCalledOnce();

    rerender(<Harness onEvent={() => undefined} onUndo={onUndo} undoCount={0} />);
    expect(screen.getByRole("button", { name: /undo last action.*0 available/i })).toBeDisabled();
  });

  it("enters and exits fullscreen from the live header", async () => {
    const user = userEvent.setup();
    let fullscreenElement: Element | null = null;
    const requestFullscreen = vi.fn(async () => {
      fullscreenElement = document.documentElement;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    const exitFullscreen = vi.fn(async () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitFullscreen,
    });

    render(<Harness onEvent={() => undefined} />);
    const enter = screen.getByRole("button", { name: "Enter fullscreen" });
    expect(enter).toHaveAttribute("aria-pressed", "false");
    await user.click(enter);

    expect(requestFullscreen).toHaveBeenCalledOnce();
    const exit = screen.getByRole("button", { name: "Exit fullscreen" });
    expect(exit).toHaveAttribute("aria-pressed", "true");
    await user.click(exit);
    expect(exitFullscreen).toHaveBeenCalledOnce();

    Reflect.deleteProperty(document, "fullscreenElement");
    Reflect.deleteProperty(document.documentElement, "requestFullscreen");
    Reflect.deleteProperty(document, "exitFullscreen");
  });

  it("signals setup phases and enters the rotating first day", async () => {
    const user = userEvent.setup();
    const onEvent = vi.fn<(type: string, payload: Record<string, unknown>) => void>();
    render(<Harness onEvent={onEvent} />);

    expect(screen.getByRole("heading", { name: /mafia negotiation/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /seat \d+: player/i })).toHaveLength(10);
    expect(screen.getByRole("group", { name: /host: host player/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /continue to sheriff wake-up/i }));

    expect(screen.getByRole("heading", { name: /sheriff wake-up/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /begin day one/i }));

    expect(screen.getByRole("heading", { name: /day 1/i })).toBeInTheDocument();
    expect(screen.getByText(/current turn: player 1/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /seat 1: player 1/i })).toHaveAttribute(
      "aria-current",
      "step",
    );

    await user.click(screen.getByRole("button", { name: /start player 1 turn/i }));
    expect(onEvent).not.toHaveBeenCalledWith("turn.started", expect.anything());
  });

  it("does not present an inactive restored current speaker as the active turn", () => {
    const dayGame = advanceSetupPhase(advanceSetupPhase(createNegotiationGame()));
    const restored = {
      ...dayGame,
      players: dayGame.players.map((player) =>
        player.seat === 1 ? { ...player, status: "red-carded" as const } : player,
      ),
    };

    render(
      <GameScreen
        game={restored}
        hostName="Host Player"
        onGameChange={() => undefined}
        onEvent={() => undefined}
        onUndo={() => undefined}
        undoCount={0}
      />,
    );

    expect(screen.queryByText(/current turn:/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start player 1 turn/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /seat 1: player 1/i })).not.toHaveAttribute(
      "aria-current",
    );
  });
});
