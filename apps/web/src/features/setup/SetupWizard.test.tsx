import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SetupWizard } from "./SetupWizard.js";
import type { GameState } from "@mafia/game-domain";

const Harness = ({
  onComplete,
  onQueueChange = () => undefined,
}: {
  onComplete: (game: GameState) => void;
  onQueueChange?: (queue: readonly string[]) => void;
}) => {
  const [musicPlaying, setMusicPlaying] = useState(false);
  return (
    <SetupWizard
      musicPlaying={musicPlaying}
      musicStatus={musicPlaying ? "Playing" : "Stopped"}
      playlistId="test-playlist"
      onPlaylistIdChange={() => undefined}
      onStartMusic={() => setMusicPlaying(true)}
      onQuickStopMusic={() => setMusicPlaying(false)}
      onSlowStopMusic={() => setMusicPlaying(false)}
      onQueueChange={onQueueChange}
      onComplete={onComplete}
    />
  );
};

describe("SetupWizard", () => {
  it("gates ten players, music playback, and per-seat random role draws", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn<(game: GameState) => void>();
    render(<Harness onComplete={onComplete} />);

    expect(screen.getByRole("heading", { name: /select 10 players/i })).toBeInTheDocument();
    const continuePlayers = screen.getByRole("button", { name: /continue to music/i });
    expect(continuePlayers).toBeDisabled();

    const inputs = screen.getAllByRole("textbox", { name: /seat \d+ player/i });
    expect(inputs).toHaveLength(10);
    for (let index = 0; index < inputs.length; index += 1) {
      await user.type(inputs[index]!, `Player ${index + 1}`);
    }
    expect(continuePlayers).toBeEnabled();
    await user.click(continuePlayers);

    expect(screen.getByRole("heading", { name: /start table music/i })).toBeInTheDocument();
    const continueRoles = screen.getByRole("button", { name: /continue to role draw/i });
    expect(continueRoles).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /start.*fade in/i }));
    expect(screen.getByText(/^playing$/i)).toBeInTheDocument();
    expect(continueRoles).toBeEnabled();
    await user.click(continueRoles);

    expect(screen.getByRole("heading", { name: /draw roles at the table/i })).toBeInTheDocument();
    for (let seat = 1; seat <= 10; seat += 1) {
      await user.click(
        screen.getByRole("button", { name: new RegExp(`draw role for player ${seat}$`, "i") }),
      );
    }

    expect(screen.getByText(/roles remaining: 0/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /begin mafia negotiation/i }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[0].phase).toBe("mafia-negotiation");
  });

  it("normalizes a YouTube URL before exposing the playback queue", async () => {
    const user = userEvent.setup();
    const onQueueChange = vi.fn<(queue: readonly string[]) => void>();
    render(<Harness onComplete={() => undefined} onQueueChange={onQueueChange} />);

    const inputs = screen.getAllByRole("textbox", { name: /seat \d+ player/i });
    for (let index = 0; index < inputs.length; index += 1) {
      await user.type(inputs[index]!, `Player ${index + 1}`);
    }
    await user.click(screen.getByRole("button", { name: /continue to music/i }));
    await user.type(
      screen.getByRole("textbox", { name: /youtube video url or id/i }),
      "https://youtu.be/dQw4w9WgXcQ?t=12",
    );
    await user.click(screen.getByRole("button", { name: /^add$/i }));

    expect(onQueueChange).toHaveBeenLastCalledWith(["dQw4w9WgXcQ"]);
    expect(screen.getByText("dQw4w9WgXcQ")).toBeInTheDocument();
  });
});
