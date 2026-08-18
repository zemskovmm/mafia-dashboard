import { describe, expect, it, vi } from "vitest";
import {
  AudioAnalysisError,
  buildAudioAnalysisCommands,
  calculateWaveformPeaks,
  createAudioAnalyzer,
  runBoundedProcess,
  StreamingWaveformAggregator,
} from "./audio-analysis.js";

describe("audio analyzer", () => {
  it("rejects media without an audio stream based on FFprobe output", async () => {
    const runProcess = vi
      .fn()
      .mockResolvedValue(
        Buffer.from(
          JSON.stringify({ streams: [{ codec_type: "video" }], format: { duration: "12.5" } }),
        ),
      );
    const analyze = createAudioAnalyzer({ runProcess });

    await expect(analyze("/tmp/not-audio.upload")).rejects.toMatchObject({
      code: "unsupported_audio_file",
    });
    expect(runProcess).toHaveBeenCalledOnce();
  });

  it("rejects tracks longer than the configured duration limit before decoding", async () => {
    const runProcess = vi
      .fn()
      .mockResolvedValue(
        Buffer.from(
          JSON.stringify({ streams: [{ codec_type: "audio" }], format: { duration: "101" } }),
        ),
      );
    const analyze = createAudioAnalyzer({ runProcess, maxDurationSeconds: 100 });

    await expect(analyze("/tmp/long.upload")).rejects.toMatchObject({
      code: "track_too_long",
    });
    expect(runProcess).toHaveBeenCalledOnce();
  });

  it("rejects concurrent analysis instead of queueing work", async () => {
    let releaseProbe!: (value: Buffer) => void;
    const probePending = new Promise<Buffer>((resolve) => {
      releaseProbe = resolve;
    });
    const runProcess = vi
      .fn()
      .mockImplementationOnce(() => probePending)
      .mockResolvedValue(Buffer.alloc(0));
    const analyze = createAudioAnalyzer({ runProcess });
    const first = analyze("/tmp/first.upload");
    await vi.waitFor(() => expect(runProcess).toHaveBeenCalledOnce());

    await expect(analyze("/tmp/second.upload")).rejects.toMatchObject({
      code: "analysis_busy",
    });
    releaseProbe(
      Buffer.from(
        JSON.stringify({ streams: [{ codec_type: "audio" }], format: { duration: "1" } }),
      ),
    );
    await first;
  });

  it("streams decoded PCM into bounded waveform buckets", async () => {
    const samples = [0.1, -0.5, 1, -0.2, 0.25, 0.1, -0.75, 0.4];
    const pcm = Buffer.alloc(samples.length * 4);
    samples.forEach((sample, index) => pcm.writeFloatLE(sample, index * 4));
    let call = 0;
    const runProcess = vi.fn(
      async (
        _command: string,
        _args: readonly string[],
        options: { readonly onStdoutChunk?: (chunk: Buffer) => void },
      ) => {
        if (call++ === 0) {
          return Buffer.from(
            JSON.stringify({ streams: [{ codec_type: "audio" }], format: { duration: "2" } }),
          );
        }
        for (let offset = 0; offset < pcm.length; offset += 3) {
          options.onStdoutChunk?.(pcm.subarray(offset, offset + 3));
        }
        return Buffer.alloc(0);
      },
    );
    const analyze = createAudioAnalyzer({ runProcess, bucketCount: 4, sampleRate: 4 });

    await expect(analyze("/tmp/audio.upload")).resolves.toEqual({
      durationSeconds: 2,
      waveform: [0.5, 1, 0.25, 0.75],
    });
  });
});

describe("bounded child processes", () => {
  it("kills a child process when the analysis timeout expires", async () => {
    const result = runBoundedProcess(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1_000)"],
      { timeoutMs: 100 },
    );

    await expect(result).rejects.toMatchObject({ code: "analysis_timeout" });
  });

  it("does not expose or retain unbounded child-process stderr", async () => {
    let error: unknown;
    try {
      await runBoundedProcess(
        process.execPath,
        ["-e", 'process.stderr.write("sensitive".repeat(20_000)); process.exit(2)'],
        { timeoutMs: 1_000 },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AudioAnalysisError);
    expect(error).toMatchObject({ code: "analysis_failed" });
    expect((error as Error).message.length).toBeLessThan(200);
    expect((error as Error).message).not.toContain("sensitive");
  });
});

describe("audio analysis commands", () => {
  it("restricts FFprobe and FFmpeg to local file and pipe protocols", () => {
    const commands = buildAudioAnalysisCommands("/tmp/track.upload");

    for (const command of [commands.probe, commands.decode]) {
      expect(command.args).toContain("-protocol_whitelist");
      expect(command.args).toContain("file,pipe");
    }
    expect(commands.probe.args.at(-1)).toBe("/tmp/track.upload");
    expect(commands.decode.args).toContain("pipe:1");
  });
});

describe("calculateWaveformPeaks", () => {
  it("captures the maximum absolute amplitude in each time bucket", () => {
    const samples = new Float32Array([0.1, -0.5, 1, -0.2, 0.25, 0.1, -0.75, 0.4]);

    expect(calculateWaveformPeaks(samples, 4)).toEqual([0.5, 1, 0.25, 0.75]);
  });

  it("returns stable empty peaks for a silent or missing decode", () => {
    expect(calculateWaveformPeaks(new Float32Array(), 3)).toEqual([0, 0, 0]);
    expect(calculateWaveformPeaks(new Float32Array([0, 0]), 4)).toEqual([0, 0, 0, 0]);
  });
});

describe("StreamingWaveformAggregator", () => {
  it("aggregates arbitrarily chunked PCM without retaining the decoded stream", () => {
    const samples = [0.1, -0.5, 1, -0.2, 0.25, 0.1, -0.75, 0.4];
    const pcm = Buffer.alloc(samples.length * Float32Array.BYTES_PER_ELEMENT);
    samples.forEach((sample, index) => pcm.writeFloatLE(sample, index * 4));
    const aggregator = new StreamingWaveformAggregator({
      durationSeconds: 2,
      sampleRate: 4,
      bucketCount: 4,
    });

    for (let offset = 0; offset < pcm.length; offset += 3) {
      aggregator.push(pcm.subarray(offset, offset + 3));
      expect(aggregator.bufferedByteCount).toBeLessThan(Float32Array.BYTES_PER_ELEMENT);
    }

    expect(aggregator.finish()).toEqual([0.5, 1, 0.25, 0.75]);
  });
});
