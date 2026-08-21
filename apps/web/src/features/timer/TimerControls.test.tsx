import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TimerControls } from "./TimerControls.js";

describe("TimerControls", () => {
  it("stops and resets the active timer instead of pausing it", async () => {
    const user = userEvent.setup();
    render(<TimerControls />);

    await user.click(screen.getByRole("button", { name: "Start 60 second timer" }));
    expect(screen.getByText("60")).toBeInTheDocument();

    const timerFace = screen.getByRole("button", { name: "Stop timer" });
    expect(timerFace).toHaveClass("timer-display");
    await user.click(timerFace);

    expect(screen.getByText("00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Timer face" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /pause|resume/i })).toBeNull();
  });
});
