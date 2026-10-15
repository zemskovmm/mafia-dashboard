import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  createGameLogEntry,
  createInitialGameBaseline,
  replayGameLog,
  resolveMafiaShots,
  type ReplayFrame,
} from "@mafia/game-domain";
import { namedProfiles } from "../../test-player-directory.js";
import { GameTimelineScreen } from "./GameTimelineScreen.js";
import { createFederationSampleGameHistory } from "./sample-game-data.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";

const props = {
  clubId: "00000000-0000-4000-8000-000000000101",
  onBack: () => undefined,
  players: namedProfiles("sample-player-"),
  loaders: { listCompleted: () => Promise.resolve([]), getSession: vi.fn() },
};

describe("federation current-history screen", () => {
  it.each(["en", "ru"] as const)(
    "reviews repeated same-target shots privately in %s without duplicate list keys",
    async (locale) => {
      const user = userEvent.setup();
      const initial = createFederationSampleGameHistory().frames.find(
        ({ entry }) => entry.type === "mafia.multiple-shot-observed",
      )!.before;
      const shooterSeat = initial.players.find(
        (p) => p.status === "active" && p.team === "black",
      )!.seat;
      const root = createGameLogEntry({
        gameId: "observations",
        id: "root",
        sequence: 1,
        parentEventId: null,
        createdAt: "2026-10-14T16:00:00Z",
        before: initial,
        draft: { type: "game.checkpointed", payload: {} },
      });
      const observed = createGameLogEntry({
        gameId: "observations",
        id: "observed",
        sequence: 2,
        parentEventId: "root",
        createdAt: "2026-10-14T16:00:01Z",
        before: root.after,
        draft: {
          type: "mafia.shots-observed",
          payload: {
            shotAssignments: { [shooterSeat]: 9 },
            observations: [
              { shooterSeat, targetSeat: 9 },
              { shooterSeat, targetSeat: 9 },
              { shooterSeat, targetSeat: 10 },
            ],
          },
        },
      });
      const resolution = resolveMafiaShots(observed.after);
      const resolved = createGameLogEntry({
        gameId: "observations",
        id: "resolved",
        sequence: 3,
        parentEventId: "observed",
        createdAt: "2026-10-14T16:00:02Z",
        before: observed.after,
        draft: {
          type: "mafia.shots-resolved",
          payload: { shots: resolution.secretShots, result: resolution.result },
        },
      });
      const { frames } = replayGameLog(createInitialGameBaseline(initial), [
        root.entry,
        observed.entry,
        resolved.entry,
      ]);
      const errors = vi.spyOn(console, "error");
      const view = render(
        <I18nProvider locale={locale}>
          <GameTimelineScreen
            {...props}
            currentHistory={{ label: "Physical shots", frames, headEventId: "resolved" }}
          />
        </I18nProvider>,
      );
      const inspector = within(
        screen.getByRole("complementary", {
          name: locale === "en" ? "Selected event details" : "Детали выбранного события",
        }),
      );
      expect(
        inspector.getByRole("heading", {
          name: locale === "en" ? "Mafia miss" : "Мафия промахнулась",
        }),
      ).toBeInTheDocument();
      const original = inspector.getAllByRole("listitem");
      expect(original).toHaveLength(1);
      expect(original[0]).toHaveTextContent(`Player ${shooterSeat} → Player 9`);
      await user.click(
        screen.getByRole("button", {
          name:
            locale === "en"
              ? /^3 physical shots observed;/
              : /^Зафиксировано 3 физических выстрела;/,
        }),
      );
      const items = inspector.getAllByRole("listitem");
      expect(items).toHaveLength(3);
      expect(items[0]).toHaveTextContent(`#${shooterSeat}`);
      expect(items[0]).toHaveTextContent("#9");
      expect(items[1]).toHaveTextContent("2:");
      expect(items[2]).toHaveTextContent("#10");
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
      view.unmount();
    },
  );
  it("previews and resets the selected accepted Best Move prefix rather than the final transcript", async () => {
    const history = createFederationSampleGameHistory();
    const retainedBytes = JSON.stringify(history);
    const onPreviewCurrentEvent = vi.fn();
    const onResetCurrentEvent = vi.fn();
    const user = userEvent.setup();
    render(
      <GameTimelineScreen
        {...props}
        currentHistory={{
          label: history.label,
          frames: history.frames,
          headEventId: history.headEventId,
        }}
        onPreviewCurrentEvent={onPreviewCurrentEvent}
        onResetCurrentEvent={onResetCurrentEvent}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Best Move number 2 accepted: Player 8" }));
    const inspector = within(screen.getByRole("complementary", { name: "Selected event details" }));
    expect(
      inspector.getByRole("heading", { name: "Best Move number 2 accepted: Player 8" }),
    ).toBeInTheDocument();
    const checkpoint = history.activeEntries.filter(
      ({ type }) => type === "best-move.number-accepted",
    )[1]!;
    await user.click(inspector.getByRole("button", { name: "Preview timeline checkpoint" }));
    await user.click(inspector.getByRole("button", { name: "Reset game to timeline checkpoint" }));
    expect(onPreviewCurrentEvent).toHaveBeenCalledWith(checkpoint.id);
    expect(onResetCurrentEvent).toHaveBeenCalledWith(checkpoint.id);
    await user.click(
      screen.getByRole("button", { name: /Best Move by Player 2: Player 8 and Player 9/ }),
    );
    expect(inspector.getByText(/readback acknowledged/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /Adjudicated win: red team/ }).at(-1)!);
    expect(inspector.getByText(/Committee-approved disciplinary loss/)).toBeInTheDocument();
    expect(JSON.stringify(history)).toBe(retainedBytes);
  });

  it("renders the known collective-lift prohibition result rather than an unknown-result placeholder", () => {
    const base = createFederationSampleGameHistory().frames.find(
      ({ entry }) => entry.type === "voting.resolved",
    )!;
    const frame = {
      ...base,
      entry: {
        ...base.entry,
        payload: {
          voteAssignments: {},
          result: {
            kind: "eliminate-all-skipped",
            seats: [1, 2, 3],
            totals: { 1: 3, 2: 3, 3: 3 },
            skipReason: "nine-three-restricted",
          },
        },
      },
    } as ReplayFrame;
    render(
      <GameTimelineScreen
        {...props}
        currentHistory={{
          label: "Accepted restricted tie",
          frames: [frame],
          headEventId: frame.entry.id,
        }}
      />,
    );
    const inspector = within(screen.getByRole("complementary", { name: "Selected event details" }));
    expect(inspector.queryByText(/Unknown result/)).not.toBeInTheDocument();
    expect(inspector.getByText("Collective lift prohibited")).toBeInTheDocument();
  });
});
