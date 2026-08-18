import { AudioAnalysisError } from "./audio-analysis.js";
import { MusicTrackStoreError } from "./music-track-store.js";

export interface MusicUploadApiError {
  readonly statusCode: number;
  readonly code: string;
}

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

export const mapMusicUploadError = (error: unknown): MusicUploadApiError | null => {
  if (error instanceof AudioAnalysisError) {
    switch (error.code) {
      case "analysis_busy":
        return { statusCode: 503, code: "audio_analysis_busy" };
      case "unsupported_audio_file":
        return { statusCode: 415, code: "unsupported_audio_file" };
      case "track_too_long":
        return { statusCode: 413, code: "track_duration_limit_exceeded" };
      case "analysis_timeout":
        return { statusCode: 422, code: "audio_analysis_timeout" };
      case "analysis_failed":
        return { statusCode: 422, code: "invalid_audio_file" };
    }
  }

  if (error instanceof MusicTrackStoreError) {
    switch (error.code) {
      case "file_too_large":
        return { statusCode: 413, code: "audio_file_too_large" };
      case "storage_quota_exceeded":
        return { statusCode: 507, code: "music_storage_quota_exceeded" };
      case "upload_busy":
        return { statusCode: 503, code: "audio_analysis_busy" };
    }
  }

  return errorCode(error) === "FST_REQ_FILE_TOO_LARGE"
    ? { statusCode: 413, code: "audio_file_too_large" }
    : null;
};
