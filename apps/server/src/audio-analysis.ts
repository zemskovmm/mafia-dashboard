import { spawn } from "node:child_process";

export const MAX_ANALYSIS_STDERR_BYTES = 16 * 1024;
export const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_MAX_TRACK_DURATION_SECONDS = 2 * 60 * 60;
export const DEFAULT_ANALYSIS_TIMEOUT_MS = 60_000;
export const WAVEFORM_BUCKET_COUNT = 720;
export const WAVEFORM_SAMPLE_RATE = 4_000;

export type AudioAnalysisErrorCode =
  | "analysis_busy"
  | "analysis_failed"
  | "analysis_timeout"
  | "track_too_long"
  | "unsupported_audio_file";

export class AudioAnalysisError extends Error {
  public constructor(public readonly code: AudioAnalysisErrorCode) {
    super(code);
    this.name = "AudioAnalysisError";
  }
}

export const runBoundedProcess = (
  command: string,
  args: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly maxStdoutBytes?: number;
    readonly onStdoutChunk?: (chunk: Buffer) => void;
  },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let streamFailed = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref();

    const fail = (error: AudioAnalysisError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onStdoutChunk !== undefined) {
        try {
          options.onStdoutChunk(chunk);
        } catch {
          streamFailed = true;
          child.kill("SIGKILL");
        }
        return;
      }

      stdoutBytes += chunk.length;
      if (stdoutBytes > (options.maxStdoutBytes ?? MAX_PROBE_OUTPUT_BYTES)) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = MAX_ANALYSIS_STDERR_BYTES - stderrBytes;
      if (remaining <= 0) return;
      const bounded = chunk.subarray(0, remaining);
      stderr.push(bounded);
      stderrBytes += bounded.length;
    });
    child.once("error", () => fail(new AudioAnalysisError("analysis_failed")));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) reject(new AudioAnalysisError("analysis_timeout"));
      else if (code !== 0 || outputExceeded || streamFailed) {
        reject(new AudioAnalysisError("analysis_failed"));
      } else resolve(Buffer.concat(stdout, stdoutBytes));
    });
  });

export const buildAudioAnalysisCommands = (path: string, sampleRate = WAVEFORM_SAMPLE_RATE) => ({
  probe: {
    command: "ffprobe",
    args: [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_entries",
      "format=duration:stream=codec_type",
      "-of",
      "json",
      path,
    ],
  },
  decode: {
    command: "ffmpeg",
    args: [
      "-nostdin",
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      "pipe:1",
    ],
  },
});

export const calculateWaveformPeaks = (samples: Float32Array, bucketCount: number): number[] => {
  const count = Math.max(1, Math.floor(bucketCount));
  if (samples.length === 0) return Array.from({ length: count }, () => 0);
  return Array.from({ length: count }, (_, bucket) => {
    const start = Math.floor((bucket * samples.length) / count);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * samples.length) / count));
    let peak = 0;
    for (let index = start; index < Math.min(end, samples.length); index += 1) {
      peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    }
    return Number(peak.toFixed(4));
  });
};

export class StreamingWaveformAggregator {
  private readonly peaks: number[];
  private readonly expectedSamples: number;
  private remainder = Buffer.alloc(0);
  private sampleIndex = 0;

  public constructor({
    durationSeconds,
    sampleRate,
    bucketCount,
  }: {
    readonly durationSeconds: number;
    readonly sampleRate: number;
    readonly bucketCount: number;
  }) {
    const count = Math.max(1, Math.floor(bucketCount));
    this.peaks = Array.from({ length: count }, () => 0);
    this.expectedSamples = Math.max(1, Math.ceil(durationSeconds * sampleRate));
  }

  public get bufferedByteCount(): number {
    return this.remainder.length;
  }

  public push(chunk: Buffer): void {
    const data = this.remainder.length === 0 ? chunk : Buffer.concat([this.remainder, chunk]);
    const alignedLength = data.length - (data.length % Float32Array.BYTES_PER_ELEMENT);
    for (let offset = 0; offset < alignedLength; offset += Float32Array.BYTES_PER_ELEMENT) {
      const bucket = Math.min(
        this.peaks.length - 1,
        Math.floor((this.sampleIndex * this.peaks.length) / this.expectedSamples),
      );
      this.peaks[bucket] = Math.max(this.peaks[bucket]!, Math.abs(data.readFloatLE(offset)));
      this.sampleIndex += 1;
    }
    this.remainder = Buffer.from(data.subarray(alignedLength));
  }

  public finish(): number[] {
    return this.peaks.map((peak) => Number(peak.toFixed(4)));
  }
}

export type ProcessRunner = typeof runBoundedProcess;
export type AudioAnalysis = {
  readonly durationSeconds: number;
  readonly waveform: readonly number[];
};
export type AudioAnalyzer = (path: string) => Promise<AudioAnalysis>;

export const createAudioAnalyzer = ({
  runProcess = runBoundedProcess,
  maxDurationSeconds = DEFAULT_MAX_TRACK_DURATION_SECONDS,
  timeoutMs = DEFAULT_ANALYSIS_TIMEOUT_MS,
  bucketCount = WAVEFORM_BUCKET_COUNT,
  sampleRate = WAVEFORM_SAMPLE_RATE,
}: {
  readonly runProcess?: ProcessRunner;
  readonly maxDurationSeconds?: number;
  readonly timeoutMs?: number;
  readonly bucketCount?: number;
  readonly sampleRate?: number;
} = {}): AudioAnalyzer => {
  let active = false;
  return async (path) => {
    if (active) throw new AudioAnalysisError("analysis_busy");
    active = true;
    try {
      const commands = buildAudioAnalysisCommands(path, sampleRate);
      const probeOutput = await runProcess(commands.probe.command, commands.probe.args, {
        timeoutMs,
        maxStdoutBytes: MAX_PROBE_OUTPUT_BYTES,
      });
      let probe: {
        streams?: Array<{ codec_type?: unknown }>;
        format?: { duration?: unknown };
      };
      try {
        probe = JSON.parse(probeOutput.toString("utf8"));
      } catch {
        throw new AudioAnalysisError("unsupported_audio_file");
      }
      if (probe.streams?.some(({ codec_type }) => codec_type === "audio") !== true) {
        throw new AudioAnalysisError("unsupported_audio_file");
      }
      const durationSeconds = Number(probe.format?.duration);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new AudioAnalysisError("unsupported_audio_file");
      }
      if (durationSeconds > maxDurationSeconds) {
        throw new AudioAnalysisError("track_too_long");
      }
      const waveform = new StreamingWaveformAggregator({
        durationSeconds,
        sampleRate,
        bucketCount,
      });
      await runProcess(commands.decode.command, commands.decode.args, {
        timeoutMs,
        onStdoutChunk: (chunk) => waveform.push(chunk),
      });
      return { durationSeconds, waveform: waveform.finish() };
    } finally {
      active = false;
    }
  };
};

export const analyzeAudioFile = createAudioAnalyzer();
