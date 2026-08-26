import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimerControls } from "./TimerControls.js";

interface FakeOscillator {
  readonly frequency: { value: number };
  readonly connect: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
}

interface FakeGain {
  readonly gain: {
    readonly setValueAtTime: ReturnType<typeof vi.fn>;
    readonly exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  readonly connect: ReturnType<typeof vi.fn>;
}

class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = [];

  readonly currentTime = 4;
  readonly destination = {};
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  readonly resume = vi.fn(() => Promise.resolve());

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createOscillator = vi.fn(() => {
    const oscillator: FakeOscillator = {
      frequency: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    this.oscillators.push(oscillator);
    return oscillator as unknown as OscillatorNode;
  });

  createGain = vi.fn(() => {
    const gain: FakeGain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    this.gains.push(gain);
    return gain as unknown as GainNode;
  });
}

beforeEach(() => {
  FakeAudioContext.instances.length = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TimerControls", () => {
  it.each([
    [60, 50],
    [30, 20],
    [10, 0],
  ] as const)(
    "pre-schedules exactly one ten-second warning for the %i second preset",
    (seconds, expectedOffset) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-26T10:00:00Z"));
      render(<TimerControls />);

      fireEvent.click(screen.getByRole("button", { name: `Start ${seconds} second timer` }));

      expect(FakeAudioContext.instances).toHaveLength(1);
      const context = FakeAudioContext.instances[0]!;
      expect(context.resume).toHaveBeenCalledTimes(1);
      expect(context.oscillators).toHaveLength(1);
      const oscillator = context.oscillators[0]!;
      const warningTime = context.currentTime + expectedOffset;
      expect(oscillator.start).toHaveBeenCalledWith(warningTime);
      expect(oscillator.stop).toHaveBeenCalledWith(warningTime + 0.18);

      act(() => {
        vi.advanceTimersByTime(expectedOffset * 1_000 + 400);
      });
      expect(context.oscillators).toHaveLength(1);
    },
  );

  it("cancels the old warning and reuses its audio context when restarted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T10:00:00Z"));
    render(<TimerControls />);

    fireEvent.click(screen.getByRole("button", { name: "Start 60 second timer" }));
    const context = FakeAudioContext.instances[0]!;
    const firstOscillator = context.oscillators[0]!;

    fireEvent.click(screen.getByRole("button", { name: "Start 30 second timer" }));

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(context.oscillators).toHaveLength(2);
    expect(firstOscillator.stop).toHaveBeenCalledTimes(2);
    expect(firstOscillator.stop).toHaveBeenNthCalledWith(2);
    expect(firstOscillator.disconnect).toHaveBeenCalledTimes(1);
    expect(context.oscillators[1]!.start).toHaveBeenCalledWith(context.currentTime + 20);
  });

  it("cancels the scheduled warning when the timer is stopped", () => {
    render(<TimerControls />);
    fireEvent.click(screen.getByRole("button", { name: "Start 60 second timer" }));
    const oscillator = FakeAudioContext.instances[0]!.oscillators[0]!;

    fireEvent.click(screen.getByRole("button", { name: "Stop timer" }));

    expect(oscillator.stop).toHaveBeenCalledTimes(2);
    expect(oscillator.stop).toHaveBeenNthCalledWith(2);
    expect(oscillator.disconnect).toHaveBeenCalledTimes(1);
  });

  it("cancels the scheduled warning when unmounted", () => {
    const { unmount } = render(<TimerControls />);
    fireEvent.click(screen.getByRole("button", { name: "Start 60 second timer" }));
    const oscillator = FakeAudioContext.instances[0]!.oscillators[0]!;

    unmount();

    expect(oscillator.stop).toHaveBeenCalledTimes(2);
    expect(oscillator.stop).toHaveBeenNthCalledWith(2);
    expect(oscillator.disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps the timer usable when Web Audio initialization is blocked", () => {
    class BlockedAudioContext {
      constructor() {
        throw new Error("Web Audio is blocked");
      }
    }
    vi.stubGlobal("AudioContext", BlockedAudioContext);
    render(<TimerControls />);

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Start 10 second timer" })),
    ).not.toThrow();
    expect(screen.getByText("10")).toBeInTheDocument();
  });

  it("keeps the timer usable when AudioContext is unavailable", () => {
    vi.stubGlobal("AudioContext", undefined);
    render(<TimerControls />);

    fireEvent.click(screen.getByRole("button", { name: "Start 10 second timer" }));

    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop timer" })).toBeEnabled();
  });

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
