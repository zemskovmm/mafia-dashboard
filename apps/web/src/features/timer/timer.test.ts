import { describe, expect, it } from "vitest";
import { readCountdown, startCountdown } from "./timer.js";

describe("authoritative countdown", () => {
  it("derives remaining time from timestamps rather than interval counts", () => {
    const timer = startCountdown(60, 1_000);

    expect(readCountdown(timer, 1_000).remainingSeconds).toBe(60);
    expect(readCountdown(timer, 11_250).remainingSeconds).toBe(50);
    expect(readCountdown(timer, 61_000).remainingSeconds).toBe(0);
  });

  it("emits the faint warning exactly once when crossing ten seconds", () => {
    const timer = startCountdown(60, 0);
    const before = readCountdown(timer, 49_000);
    expect(before.emitWarning).toBe(false);

    const threshold = readCountdown(before.timer, 50_000);
    expect(threshold.remainingSeconds).toBe(10);
    expect(threshold.emitWarning).toBe(true);

    const repeated = readCountdown(threshold.timer, 51_000);
    expect(repeated.emitWarning).toBe(false);
  });

  it("emits the warning immediately for a ten-second preset", () => {
    const timer = startCountdown(10, 100);
    const reading = readCountdown(timer, 100);

    expect(reading.remainingSeconds).toBe(10);
    expect(reading.emitWarning).toBe(true);
  });
});
