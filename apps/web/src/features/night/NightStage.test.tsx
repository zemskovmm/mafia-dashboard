import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  advanceSetupPhase,
  beginNight,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { NightStage } from "./NightStage.js";

const createNightGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `p-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(17));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  const day = advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
  return beginNight(day);
};

const Harness = ({
  initial,
  onEvent = () => undefined,
}: {
  initial: GameState;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
}) => {
  const [game, setGame] = useState(initial);
  return <NightStage game={game} onGameChange={setGame} onEvent={onEvent} />;
};

describe("NightStage", () => {
  it("uses the table with one sorted shooter button per target", async () => {
    const user = userEvent.setup();
    const initial = createNightGame();
    const shooters = initial.players
      .filter(({ team }) => team === "black")
      .sort((left, right) => left.seat - right.seat);
    const target = initial.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!;
    const otherTarget = initial.players.find(
      ({ status, seat }) => status === "active" && seat !== target.seat,
    )!;
    render(<Harness initial={initial} />);

    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    for (const shooter of shooters) {
      expect(
        screen.getByRole("button", {
          name: `Assign all remaining Mafia shots to ${shooter.name}`,
        }),
      ).toHaveClass("is-mafia-shooter");
    }
    const targetButtons = shooters.map((shooter) =>
      screen.getByRole("button", {
        name: `Assign shooter ${shooter.seat} to target ${target.name}`,
      }),
    );
    expect(targetButtons.map((button) => button.textContent)).toEqual(
      shooters.map(({ seat }) => `#${seat}`),
    );

    await user.click(targetButtons[0]!);
    expect(
      screen.getByRole("button", {
        name: `Assign shooter ${shooters[0]!.seat} to target ${otherTarget.name}`,
      }),
    ).toBeDisabled();
  });

  it("allows every remaining shot to target a deceased player and reports no effect", async () => {
    const user = userEvent.setup();
    const base = createNightGame();
    const deceased = base.players.find(({ team }) => team === "red")!;
    const initial: GameState = {
      ...base,
      players: base.players.map((player) =>
        player.seat === deceased.seat ? { ...player, status: "eliminated" } : player,
      ),
    };
    render(<Harness initial={initial} />);

    await user.click(
      screen.getByRole("button", {
        name: new RegExp(`^Assign all remaining Mafia shots to ${deceased.name}$`),
      }),
    );
    expect(
      screen.getAllByRole("button", { name: new RegExp(`to target ${deceased.name}$`) }),
    ).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    expect(screen.getByRole("status", { name: "Mafia shots had no effect" })).toHaveTextContent(
      `${deceased.name} was already out`,
    );
    expect(
      screen.getByRole("button", { name: `Seat ${deceased.seat}: ${deceased.name}` }),
    ).toHaveClass("status-eliminated");
  });

  it("keeps check targets undimmed and permits checks on deceased players", async () => {
    const user = userEvent.setup();
    const base = createNightGame();
    const deceased = base.players.find(({ role }) => role === "citizen")!;
    const initial: GameState = {
      ...base,
      phase: "night-don",
      players: base.players.map((player) =>
        player.seat === deceased.seat ? { ...player, status: "eliminated" } : player,
      ),
    };
    const { container } = render(<Harness initial={initial} />);

    expect(container.querySelectorAll(".player-seat.is-dimmed")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: `Don check ${deceased.name}` }));
    expect(screen.getByText("Not the Sheriff")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Sheriff check ${deceased.name}` })).toBeNull();
    await user.click(screen.getByRole("button", { name: /proceed to sheriff check/i }));
    expect(container.querySelectorAll(".player-seat.is-dimmed")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: `Sheriff check ${deceased.name}` }));
    expect(screen.getByText("Not Mafia")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue night" }));
    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    expect(screen.getByText("Night complete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /begin day 2/i })).toBeInTheDocument();
  });

  it("re-evaluates without logging discarded shots, then confirms the deceased player", async () => {
    const user = userEvent.setup();
    const initial = createNightGame();
    const shooters = initial.players
      .filter(({ team }) => team === "black")
      .sort((left, right) => left.seat - right.seat);
    const target = initial.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!;
    const onEvent = vi.fn();
    render(<Harness initial={initial} onEvent={onEvent} />);

    const assignAll = async () => {
      for (const shooter of shooters) {
        await user.click(
          screen.getByRole("button", {
            name: `Assign shooter ${shooter.seat} to target ${target.name}`,
          }),
        );
      }
    };

    await assignAll();
    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    expect(screen.getByRole("group", { name: "Deceased player" })).toHaveTextContent(target.name);
    expect(screen.getByRole("button", { name: `Seat ${target.seat}: ${target.name}` })).toHaveClass(
      "is-provisional-deceased",
    );
    expect(onEvent).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /re-evaluate mafia shots/i }));
    expect(screen.queryByRole("group", { name: "Deceased player" })).toBeNull();
    expect(onEvent).not.toHaveBeenCalled();

    await assignAll();
    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    await user.click(screen.getByRole("button", { name: /continue night/i }));

    expect(onEvent.mock.calls.filter(([type]) => type === "mafia.shot-recorded")).toHaveLength(3);
    expect(onEvent.mock.calls.filter(([type]) => type === "mafia.shots-resolved")).toHaveLength(1);
    expect(screen.getByText("Don check")).toBeInTheDocument();
  });

  it("continues Don, Sheriff, and next-day stages after confirmed shots", async () => {
    const user = userEvent.setup();
    const initial = createNightGame();
    const shooters = initial.players.filter(({ team }) => team === "black");
    const target = initial.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!;
    const sheriff = initial.players.find(({ role }) => role === "sheriff")!;
    const mafia = initial.players.find(({ role }) => role === "mafia")!;
    render(<Harness initial={initial} />);

    for (const shooter of shooters) {
      await user.click(
        screen.getByRole("button", {
          name: `Assign shooter ${shooter.seat} to target ${target.name}`,
        }),
      );
    }

    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    await user.click(screen.getByRole("button", { name: /continue night/i }));
    expect(screen.getByText("Don check")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: new RegExp(`don check ${sheriff.name}`, "i") }),
    );
    expect(screen.getByText(/sheriff found/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /proceed to sheriff check/i }));

    expect(screen.getByText("Sheriff check")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: new RegExp(`sheriff check ${mafia.name}`, "i") }),
    );
    expect(screen.getByText(/mafia found/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue night" }));
    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /begin day 2/i }));
    expect(screen.getByRole("heading", { name: /night complete/i })).toBeInTheDocument();
  });
});
