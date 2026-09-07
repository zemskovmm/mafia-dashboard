import {
  createGameLogEntry,
  type CanonicalGameEventDraft,
  type GameState,
} from "@mafia/game-domain";
import { expect } from "vitest";
import { resolve } from "node:path";
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GameScreen } from "./features/game/GameScreen.js";

export const captureUiEvent = (
  game: GameState,
  action: "foul" | "red-card" | "ballot",
  seat = 1,
): CanonicalGameEventDraft => {
  const drafts: CanonicalGameEventDraft[] = [];
  const view = render(
    createElement(GameScreen, {
      game,
      hostName: "Contract host",
      privacyHidden: false,
      onGameChange: () => undefined,
      onEvent: () => undefined,
      onAcceptedEvent: (draft) => drafts.push(draft),
    }),
  );
  try {
    const player = game.players.find((candidate) => candidate.seat === seat)!;
    if (action === "red-card") {
      const card = view.getByRole("button", { name: `Seat ${seat}: ${player.name}` });
      fireEvent.touchStart(card, { touches: [{ clientX: 20, clientY: 50 }] });
      fireEvent.touchEnd(card, { changedTouches: [{ clientX: 82, clientY: 52 }] });
    }
    fireEvent.click(
      view.getByRole("button", {
        name:
          action === "ballot"
            ? "Resolve car crash"
            : `${action === "foul" ? "Foul" : "Red card"} ${player.name}`,
      }),
    );
    expect(drafts).toHaveLength(1);
    return drafts[0]!;
  } finally {
    cleanup();
  }
};

// Exercise the server contract with the actual draft emitted by a rendered UI control.
export const expectServerAcceptsEvent = async (
  before: GameState,
  draft: CanonicalGameEventDraft,
) => {
  const modulePath = resolve("../server/src/game-session-validation.ts");
  // eslint-disable-next-line no-unsanitized/method -- Fixed repository-local test module, not user input.
  const { gameSessionEventMutationSchema } = (await import(modulePath)) as {
    gameSessionEventMutationSchema: { parse: (input: unknown) => unknown };
  };
  const { entry } = createGameLogEntry({
    gameId: "00000000-0000-4000-8000-000000000090",
    id: "00000000-0000-4000-8000-000000000091",
    sequence: 2,
    parentEventId: "00000000-0000-4000-8000-000000000092",
    createdAt: "2026-09-07T00:00:00.000Z",
    before,
    draft,
  });
  const request = {
    mutationId: "00000000-0000-4000-8000-000000000093",
    baseRevision: 1,
    event: entry,
  };
  expect(gameSessionEventMutationSchema.parse(request)).toEqual(request);
};
