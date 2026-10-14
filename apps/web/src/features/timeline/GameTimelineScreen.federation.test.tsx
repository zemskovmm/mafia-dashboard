import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReplayFrame } from "@mafia/game-domain";
import { namedProfiles } from "../../test-player-directory.js";
import { GameTimelineScreen } from "./GameTimelineScreen.js";
import { createFederationSampleGameHistory } from "./sample-game-data.js";

const props = {
  clubId: "00000000-0000-4000-8000-000000000101",
  onBack: () => undefined,
  players: namedProfiles("sample-player-"),
  loaders: { listCompleted: () => Promise.resolve([]), getSession: vi.fn() },
};

describe("federation current-history screen", () => {
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
