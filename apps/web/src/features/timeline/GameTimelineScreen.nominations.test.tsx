import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  createGameLogEntry,
  createInitialGameBaseline,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameLogEntry,
} from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { namedProfiles } from "../../test-player-directory.js";
import { GameTimelineScreen } from "./GameTimelineScreen.js";
import { createFederationSampleGameHistory } from "./sample-game-data.js";

const history = (empty: boolean) => {
  const initial = createFederationSampleGameHistory().frames.find(
    ({ entry }) => entry.type === "player.nominated",
  )!.before;
  const drafts: CanonicalGameEventDraft[] = [
    { type: "game.checkpointed", payload: {} },
    {
      type: "nomination.selection-set",
      payload: { nominatorSeat: 1, candidateSeat: 7, selected: true },
    },
    { type: "foul.issued", payload: { seat: 10, foulNumber: 1, redCarded: false } },
    {
      type: "nomination.selection-set",
      payload: { nominatorSeat: empty ? 1 : 2, candidateSeat: 7, selected: !empty },
    },
  ];
  let game = initial;
  const entries: GameLogEntry[] = [];
  for (const draft of drafts) {
    const accepted = createGameLogEntry({
      before: game,
      draft,
      gameId: "timeline-selections",
      id: `entry-${entries.length + 1}`,
      sequence: entries.length + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: "2026-10-15T16:00:00Z",
    });
    entries.push(accepted.entry);
    game = accepted.after;
  }
  return {
    frames: replayGameLog(createInitialGameBaseline(initial), entries).frames,
    headEventId: entries.at(-1)!.id,
  };
};

const props = {
  clubId: "club",
  onBack: vi.fn(),
  players: namedProfiles("sample-player-"),
  loaders: { listCompleted: async () => [], getSession: vi.fn() },
};

describe("nomination timeline checkpoints", () => {
  it.each(["en", "ru"] as const)(
    "renders surviving attribution and previews/resets the real collapsed checkpoint in %s",
    async (locale) => {
      const user = userEvent.setup();
      const retained = history(false);
      const bytes = JSON.stringify(retained);
      const onPreviewCurrentEvent = vi.fn();
      const onResetCurrentEvent = vi.fn();
      // Keep a later unrelated fact so this checkpoint remains eligible for Reset.
      const last = retained.frames.at(-1)!;
      const accepted = createGameLogEntry({
        before: last.after,
        gameId: last.entry.gameId,
        id: "later-foul",
        sequence: last.entry.sequence + 1,
        parentEventId: last.entry.id,
        createdAt: "2026-10-15T16:00:01Z",
        draft: { type: "foul.issued", payload: { seat: 9, foulNumber: 1, redCarded: false } },
      });
      const frames = [
        ...retained.frames,
        { before: last.after, entry: accepted.entry, after: accepted.after },
      ];
      render(
        <I18nProvider locale={locale}>
          <GameTimelineScreen
            {...props}
            currentHistory={{ label: "Selections", frames, headEventId: accepted.entry.id }}
            onPreviewCurrentEvent={onPreviewCurrentEvent}
            onResetCurrentEvent={onResetCurrentEvent}
          />
        </I18nProvider>,
      );
      const button = screen.getByRole("button", {
        name:
          locale === "en" ? /^Nomination selections: 1 candidate;/ : /^Выставления: 1 кандидат;/,
      });
      expect(button).toHaveAccessibleName(
        expect.stringContaining(
          locale === "en"
            ? "Additional supporters (+1): #2 Player 2"
            : "Дополнительно поддержали (+1): #2 Player 2",
        ),
      );
      await user.click(button);
      const inspector = within(
        screen.getByRole("complementary", {
          name: locale === "en" ? "Selected event details" : "Детали выбранного события",
        }),
      );
      expect(
        inspector.getByRole("heading", {
          name: locale === "en" ? "Nomination selections: 1 candidate" : "Выставления: 1 кандидат",
        }),
      ).toBeInTheDocument();
      expect(inspector.getByText(/#7 Player 7/)).toHaveTextContent("#1 Player 1");
      await user.click(
        inspector.getByRole("button", {
          name: locale === "en" ? "Preview timeline checkpoint" : "Предпросмотр контрольной точки",
        }),
      );
      await user.click(
        inspector.getByRole("button", {
          name:
            locale === "en"
              ? "Reset game to timeline checkpoint"
              : "Вернуть игру к контрольной точке",
        }),
      );
      expect(onPreviewCurrentEvent).toHaveBeenCalledExactlyOnceWith(retained.headEventId);
      expect(onResetCurrentEvent).toHaveBeenCalledExactlyOnceWith(retained.headEventId);
      expect(JSON.stringify(retained)).toBe(bytes);
    },
  );

  it("keeps a final cleared selection as the current checkpoint, not an earlier nominated state", () => {
    const retained = history(true);
    render(
      <GameTimelineScreen
        {...props}
        currentHistory={{ label: "Cleared", ...retained }}
        onPreviewCurrentEvent={vi.fn()}
        onResetCurrentEvent={vi.fn()}
      />,
    );
    const inspector = within(screen.getByRole("complementary", { name: "Selected event details" }));
    expect(
      inspector.getByRole("heading", { name: "No nomination selections" }),
    ).toBeInTheDocument();
    expect(
      inspector.getByRole("button", { name: "Reset game to timeline checkpoint" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Nomination:.*set.*for voting/ })).toBeNull();
  });
});
