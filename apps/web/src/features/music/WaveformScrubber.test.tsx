import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WaveformScrubber } from "./WaveformScrubber.js";

describe("WaveformScrubber", () => {
  it("renders real peak bars and changes the chosen start position", () => {
    const onChange = vi.fn();
    render(
      <WaveformScrubber
        label="Next track start position"
        waveform={[0.1, 0.8, 0.35, 1]}
        durationSeconds={120}
        value={30}
        onChange={onChange}
      />,
    );

    expect(screen.getAllByTestId("waveform-peak")).toHaveLength(4);
    const slider = screen.getByRole("slider", { name: "Next track start position" });
    expect(slider).toHaveValue("30");
    fireEvent.change(slider, { target: { value: "72.5" } });
    expect(onChange).toHaveBeenCalledWith(72.5);
  });

  it("does not allow cue changes while its deck is transitioning", () => {
    const onChange = vi.fn();
    render(
      <WaveformScrubber
        label="Queued cue"
        waveform={[0.2, 0.6]}
        durationSeconds={20}
        value={4}
        onChange={onChange}
        disabled
      />,
    );

    const slider = screen.getByRole("slider", { name: "Queued cue" });
    expect(slider).toBeDisabled();
    fireEvent.change(slider, { target: { value: "8" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
