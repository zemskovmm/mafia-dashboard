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
import { GameTimelineScreen } from "./features/timeline/GameTimelineScreen.js";
import type {
  CompletedGameSessionFilters,
  CompletedGameSessionSummary,
  RemoteGameSession,
} from "./api/client.js";

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
    if (action === "red-card") {
      const card = view.getByRole("button", { name: `Seat ${seat}: Anonymous player` });
      fireEvent.touchStart(card, { touches: [{ clientX: 20, clientY: 50 }] });
      fireEvent.touchEnd(card, { changedTouches: [{ clientX: 82, clientY: 52 }] });
    }
    const actionName =
      action === "ballot"
        ? "Resolve car crash"
        : `${action === "foul" ? "Foul" : "Red card"} Anonymous player`;
    const controls = view.getAllByRole("button", { name: actionName });
    // Anonymous seats can share a control label; the table keeps seat order.
    fireEvent.click(controls.length === 1 ? controls[0]! : controls[seat - 1]!);
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
  const { gameSessionMutationSchema } = (await import(modulePath)) as {
    gameSessionMutationSchema: { parse: (input: unknown) => unknown };
  };
  // UI event drafts are seat-based. Supply permanent IDs for the server
  // transport fixture without changing the event emitted by the control.
  const transportGame: GameState = {
    ...before,
    players: before.players.map((player) => ({
      ...player,
      id:
        player.id === "casper"
          ? player.id
          : `00000000-0000-4000-8000-${String(player.seat).padStart(12, "0")}`,
    })),
  };
  const { entry } = createGameLogEntry({
    gameId: "00000000-0000-4000-8000-000000000090",
    id: "00000000-0000-4000-8000-000000000091",
    sequence: 2,
    parentEventId: "00000000-0000-4000-8000-000000000092",
    createdAt: "2026-09-07T00:00:00.000Z",
    before: transportGame,
    draft,
  });
  const request = {
    name: "Contract game",
    mutationId: "00000000-0000-4000-8000-000000000093",
    state: {
      setup: null,
      game: transportGame,
      hostPlayerId: null,
      playlistId: "",
      log: [],
      undoHistory: [],
      undoBudget: 0,
      initialGame: null,
      events: [entry],
      headEventId: entry.id,
      resetReturnEventId: null,
      legacyLog: [],
    },
    results: null,
  };
  expect(gameSessionMutationSchema.parse(request)).toEqual(request);
};

// The caller supplies serialized real API readbacks, not fixture directory names.
export const observeSavedTimeline = async (
  clubId: string,
  gameId: string,
  players: readonly { readonly id: string; readonly nickname: string }[],
  loaders: {
    listCompleted: (
      id: string,
      filters: CompletedGameSessionFilters,
    ) => Promise<readonly CompletedGameSessionSummary[]>;
    getSession: (id: string, club: string) => Promise<RemoteGameSession>;
  },
): Promise<{ foulLabel: string; text: string }> => {
  const view = render(
    createElement(GameTimelineScreen, { clubId, players, loaders, onBack: () => undefined }),
  );
  try {
    const selector = await view.findByRole("combobox", { name: "Completed game" });
    await view.findByRole("option", { name: /UI history/ });
    fireEvent.change(selector, { target: { value: gameId } });
    const marker = await view.findByRole("button", { name: /Foul 1:/ });
    return {
      foulLabel: marker.getAttribute("aria-label") ?? marker.textContent ?? "",
      text: view.container.textContent ?? "",
    };
  } finally {
    cleanup();
  }
};
