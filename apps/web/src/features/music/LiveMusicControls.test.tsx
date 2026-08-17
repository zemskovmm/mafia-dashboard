import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LiveMusicControls } from "./LiveMusicControls.js";

describe("LiveMusicControls", () => {
  it("exposes all three table-safe fade actions", async () => {
    const user = userEvent.setup();
    const onFadeIn = vi.fn();
    const onQuickFadeOut = vi.fn();
    const onSlowFadeOut = vi.fn();
    render(
      <LiveMusicControls
        isPlaying
        onFadeIn={onFadeIn}
        onQuickFadeOut={onQuickFadeOut}
        onSlowFadeOut={onSlowFadeOut}
      />,
    );

    await user.click(screen.getByRole("button", { name: /music fade in/i }));
    await user.click(screen.getByRole("button", { name: /quick music fade out/i }));
    await user.click(screen.getByRole("button", { name: /slow music fade out/i }));

    expect(onFadeIn).toHaveBeenCalledOnce();
    expect(onQuickFadeOut).toHaveBeenCalledOnce();
    expect(onSlowFadeOut).toHaveBeenCalledOnce();
  });
});
