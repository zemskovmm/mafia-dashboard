import { describe, expect, it } from "vitest";
import { AudioAnalysisError } from "./audio-analysis.js";
import { mapMusicUploadError } from "./music-api-errors.js";
import { MusicTrackStoreError } from "./music-track-store.js";

describe("mapMusicUploadError", () => {
  it.each([
    [new AudioAnalysisError("analysis_busy"), 503, "audio_analysis_busy"],
    [new AudioAnalysisError("unsupported_audio_file"), 415, "unsupported_audio_file"],
    [new AudioAnalysisError("track_too_long"), 413, "track_duration_limit_exceeded"],
    [new AudioAnalysisError("analysis_timeout"), 422, "audio_analysis_timeout"],
    [new AudioAnalysisError("analysis_failed"), 422, "invalid_audio_file"],
    [new MusicTrackStoreError("file_too_large"), 413, "audio_file_too_large"],
    [new MusicTrackStoreError("storage_quota_exceeded"), 507, "music_storage_quota_exceeded"],
    [new MusicTrackStoreError("upload_busy"), 503, "audio_analysis_busy"],
    [{ code: "FST_REQ_FILE_TOO_LARGE" }, 413, "audio_file_too_large"],
  ])("maps a resource failure to a safe API error", (error, statusCode, code) => {
    expect(mapMusicUploadError(error)).toEqual({ statusCode, code });
  });

  it("does not hide unrelated server failures", () => {
    expect(mapMusicUploadError(new Error("database offline"))).toBeNull();
  });
});
