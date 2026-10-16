import { act, fireEvent, render, screen } from "@testing-library/react";
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
  it.each([false, true])(
    "double tap resets to stopped zero from paused=%s and cancels audio",
    (paused) => {
      vi.useFakeTimers();
      render(<TimerControls />);
      fireEvent.click(screen.getByRole("button", { name: "Start 30 second timer" }));
      act(() => vi.advanceTimersByTime(5_000));
      const face = screen.getByRole("button", { name: "Pause timer" });
      if (paused) fireEvent.click(face);
      fireEvent.click(face, { detail: 1 });
      act(() => vi.advanceTimersByTime(150));
      // iPad compatibility clicks may each have detail=1 rather than emitting dblclick.
      fireEvent.click(face, { detail: 1 });
      expect(face).toHaveTextContent("00");
      expect(face).toBeDisabled();
      expect(face).not.toHaveClass("is-warning");
      const context = FakeAudioContext.instances[0]!;
      const count = context.oscillators.length;
      for (const oscillator of context.oscillators)
        expect(oscillator.disconnect).toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(120_000));
      fireEvent.click(face);
      expect(face).toHaveTextContent("00");
      expect(context.oscillators).toHaveLength(count);
      fireEvent.click(screen.getByRole("button", { name: "Start 20 second timer" }));
      act(() => vi.advanceTimersByTime(1_000));
      expect(face).toHaveTextContent("19");
    },
  );

  it("keeps separated pointer clicks and rapid keyboard activations as pause/resume", () => {
    vi.useFakeTimers();
    render(<TimerControls />);
    fireEvent.click(screen.getByRole("button", { name: "Start 60 second timer" }));
    const face = screen.getByRole("button", { name: "Pause timer" });
    fireEvent.click(face, { detail: 1 });
    act(() => vi.advanceTimersByTime(600));
    fireEvent.click(face, { detail: 1 });
    expect(face).toHaveAccessibleName("Pause timer");
    fireEvent.click(face, { detail: 0 });
    fireEvent.click(face, { detail: 0 });
    expect(face).toHaveAccessibleName("Pause timer");
    expect(face).toHaveTextContent("60");
  });

  it("a fresh preset clears the preceding tap sequence", () => {
    vi.useFakeTimers();
    render(<TimerControls />);
    fireEvent.click(screen.getByRole("button", { name: "Start 60 second timer" }));
    const face = screen.getByRole("button", { name: "Pause timer" });
    fireEvent.click(face, { detail: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Start 30 second timer" }));
    fireEvent.click(face, { detail: 1 });
    expect(face).toHaveAccessibleName("Resume timer");
    expect(face).toHaveTextContent("30");
  });

  it("explicitly replaces the countdown with twenty seconds and preserves pause/resume through expiry", () => {
    vi.useFakeTimers();
    render(<TimerControls />);

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("button", { name: "Timer face" })).toHaveTextContent("00");
    fireEvent.click(screen.getByRole("button", { name: "Start 60 second timer" }));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("button", { name: "Pause timer" })).toHaveTextContent("55");

    fireEvent.click(screen.getByRole("button", { name: "Start 20 second timer" }));
    expect(screen.getByRole("button", { name: "Pause timer" })).toHaveTextContent("20");
    act(() => vi.advanceTimersByTime(3_250));
    fireEvent.click(screen.getByRole("button", { name: "Pause timer" }));
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByRole("button", { name: "Resume timer" })).toHaveTextContent("17");

    fireEvent.click(screen.getByRole("button", { name: "Resume timer" }));
    act(() => vi.advanceTimersByTime(6_800));
    expect(screen.getByRole("button", { name: "Pause timer" })).toHaveTextContent("10");
    expect(screen.getByRole("button", { name: "Pause timer" })).toHaveClass("is-warning");
    act(() => vi.advanceTimersByTime(9_800));
    expect(screen.getByRole("button", { name: "Pause timer" })).toHaveTextContent("01");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("button", { name: "Timer face" })).toHaveTextContent("00");
    expect(screen.getByRole("button", { name: "Timer face" })).toBeDisabled();
  });

  it.each([
    [60, 50],
    [30, 20],
    [20, 10],
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

  it("cancels the scheduled warning when the timer is paused", () => {
    render(<TimerControls />);
    fireEvent.click(screen.getByRole("button", { name: "Start 60 second timer" }));
    const oscillator = FakeAudioContext.instances[0]!.oscillators[0]!;

    fireEvent.click(screen.getByRole("button", { name: "Pause timer" }));

    expect(oscillator.stop).toHaveBeenCalledTimes(2);
    expect(oscillator.stop).toHaveBeenNthCalledWith(2);
    expect(oscillator.disconnect).toHaveBeenCalledTimes(1);
  });

  it("reschedules a pending warning from the exact remaining time after a long pause", () => {
    vi.useFakeTimers();
    render(<TimerControls />);
    fireEvent.click(screen.getByRole("button", { name: "Start 60 second timer" }));
    const context = FakeAudioContext.instances[0]!;
    act(() => vi.advanceTimersByTime(12_250));
    fireEvent.click(screen.getByRole("button", { name: "Pause timer" }));
    act(() => vi.advanceTimersByTime(120_000));
    expect(context.oscillators).toHaveLength(1);
    expect(context.oscillators[0]!.disconnect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Resume timer" }));
    expect(context.oscillators).toHaveLength(2);
    expect(context.oscillators[1]!.start).toHaveBeenCalledWith(context.currentTime + 37.75);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it.each([
    [60, 50_050],
    [30, 20_050],
    [20, 10_050],
    [10, 0],
  ])(
    "does not replay the %i second preset warning when paused after its threshold between ticks",
    (seconds, elapsed) => {
      vi.useFakeTimers();
      render(<TimerControls />);
      fireEvent.click(screen.getByRole("button", { name: `Start ${seconds} second timer` }));
      const context = FakeAudioContext.instances[0]!;
      // Move the clock without refreshing the display: audio runs independently of UI ticks.
      vi.setSystemTime(Date.now() + elapsed);
      fireEvent.click(screen.getByRole("button", { name: "Pause timer" }));
      act(() => vi.advanceTimersByTime(120_000));
      fireEvent.click(screen.getByRole("button", { name: "Resume timer" }));
      expect(context.oscillators).toHaveLength(1);
    },
  );

  it.each([60, 30, 20, 10])("starts a fresh %i second preset while paused", (seconds) => {
    vi.useFakeTimers();
    render(<TimerControls />);
    fireEvent.click(screen.getByRole("button", { name: "Start 60 second timer" }));
    act(() => vi.advanceTimersByTime(5_000));
    fireEvent.click(screen.getByRole("button", { name: "Pause timer" }));
    fireEvent.click(screen.getByRole("button", { name: `Start ${seconds} second timer` }));
    expect(screen.getByText(String(seconds))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause timer" })).toBeEnabled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(String(seconds - 1).padStart(2, "0"))).toBeInTheDocument();
    expect(FakeAudioContext.instances[0]!.oscillators).toHaveLength(2);
  });

  it("expires rather than pausing when clicked after the deadline before a display tick", () => {
    vi.useFakeTimers();
    render(<TimerControls />);
    fireEvent.click(screen.getByRole("button", { name: "Start 10 second timer" }));
    vi.setSystemTime(Date.now() + 10_001);
    fireEvent.click(screen.getByRole("button", { name: "Pause timer" }));
    expect(screen.getByText("00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Timer face" })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "Pause timer" })).toBeEnabled();
  });

  it("pauses the remaining time and resumes the countdown on the next click", () => {
    vi.useFakeTimers();
    render(<TimerControls />);

    expect(screen.getByRole("button", { name: "Timer face" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Start 60 second timer" }));
    act(() => vi.advanceTimersByTime(12_250));

    const timerFace = screen.getByRole("button", { name: "Pause timer" });
    expect(timerFace).toHaveClass("timer-display");
    fireEvent.click(timerFace);
    expect(screen.getByText("48")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByText("48")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume timer" }));
    act(() => vi.advanceTimersByTime(47_600));
    expect(screen.getByText("01")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));

    expect(screen.getByText("00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Timer face" })).toBeDisabled();
  });
});
