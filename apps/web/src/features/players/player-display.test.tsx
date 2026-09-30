import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  hashGameState,
} from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { GameScreen } from "../game/GameScreen.js";
import { PlayerDirectoryProvider } from "./player-display.js";

const createIdentityOnlyGame = () => {
  const roster = Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(roster), createSeededRandom(13));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return createGame(completeRoleDraw(setup));
};

describe("live player display directory", () => {
  it("renames and retires the visible player without changing canonical state or replay hash", () => {
    const game = createIdentityOnlyGame();
    const bytes = JSON.stringify(game);
    const hash = hashGameState(game);
    const Harness = () => {
      const [profiles, setProfiles] = useState([{ id: "player-1", nickname: "Original nickname" }]);
      return (
        <I18nProvider locale="en">
          <PlayerDirectoryProvider profiles={profiles}>
            <button onClick={() => setProfiles([{ id: "player-1", nickname: "Renamed nickname" }])}>
              Rename
            </button>
            <button onClick={() => setProfiles([])}>Retire</button>
            <GameScreen
              game={game}
              hostName="Host"
              onGameChange={() => undefined}
              onEvent={() => undefined}
              privacyHidden={false}
            />
          </PlayerDirectoryProvider>
        </I18nProvider>
      );
    };
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Seat 1: Original nickname" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("button", { name: "Seat 1: Renamed nickname" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    expect(screen.getByRole("button", { name: "Seat 1: Anonymous player" })).toBeInTheDocument();
    expect(JSON.stringify(game)).toBe(bytes);
    expect(bytes).not.toContain("Original nickname");
    expect(bytes).not.toContain('"name"');
    expect(hashGameState(game)).toBe(hash);
  });
});
