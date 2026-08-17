import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  advanceSetupPhase,
  beginNight,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  setMusicState,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { NightStage } from "./NightStage.js";

const createNightGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `p-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(setMusicState(createSetup(players), "playing"), createSeededRandom(17));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  const day = advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
  return beginNight(day);
};

const Harness = ({ initial }: { initial: GameState }) => {
  const [game, setGame] = useState(initial);
  return <NightStage game={game} onGameChange={setGame} onEvent={() => undefined} />;
};

describe("NightStage", () => {
  it("guides every Mafia shot, Don check, Sheriff check, and next day", async () => {
    const user = userEvent.setup();
    const initial = createNightGame();
    const shooters = initial.players.filter(({ team }) => team === "black");
    const target = initial.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!;
    const sheriff = initial.players.find(({ role }) => role === "sheriff")!;
    const mafia = initial.players.find(({ role }) => role === "mafia")!;
    render(<Harness initial={initial} />);

    for (const shooter of shooters) {
      expect(screen.getByText(new RegExp(`Shooter: ${shooter.name}`, "i"))).toBeInTheDocument();
      await user.click(
        screen.getByRole("button", {
          name: new RegExp(`target ${target.name} for ${shooter.name}`, "i"),
        }),
      );
    }

    await user.click(screen.getByRole("button", { name: /resolve mafia shots/i }));
    expect(screen.getByRole("heading", { name: /don check/i })).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: new RegExp(`don check ${sheriff.name}`, "i") }),
    );
    expect(screen.getByText(/sheriff found/i)).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: /sheriff check/i })).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: new RegExp(`sheriff check ${mafia.name}`, "i") }),
    );
    expect(screen.getByText(/mafia found/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /begin day 2/i }));
    expect(screen.getByRole("heading", { name: /night complete/i })).toBeInTheDocument();
  });
});
