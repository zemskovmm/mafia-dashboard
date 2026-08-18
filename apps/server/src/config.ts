import { z } from "zod";
import {
  DEFAULT_ANALYSIS_TIMEOUT_MS,
  DEFAULT_MAX_TRACK_DURATION_SECONDS,
} from "./audio-analysis.js";
import {
  DEFAULT_MAX_MUSIC_FILE_BYTES,
  DEFAULT_MAX_MUSIC_STORAGE_BYTES,
} from "./music-track-store.js";
import type { YouTubeOAuthConfig } from "./youtube-oauth.js";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const environment = z
  .object({
    DATABASE_URL: z.url().default("postgresql://mafia:mafia@127.0.0.1:5432/mafia"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    STATIC_DIR: z.string().optional(),
    MUSIC_STORAGE_DIR: z.string().trim().min(1).default("./data/music"),
    MUSIC_MAX_FILE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(200 * 1024 * 1024)
      .default(DEFAULT_MAX_MUSIC_FILE_BYTES),
    MUSIC_MAX_STORAGE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_MUSIC_STORAGE_BYTES),
    MUSIC_MAX_DURATION_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_MAX_TRACK_DURATION_SECONDS),
    MUSIC_ANALYSIS_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(10 * 60 * 1_000)
      .default(DEFAULT_ANALYSIS_TIMEOUT_MS),
    PUBLIC_APP_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    GOOGLE_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    GOOGLE_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    GOOGLE_OAUTH_REDIRECT_URI: z.preprocess(emptyToUndefined, z.url().optional()),
    MUSIC_TOKEN_ENCRYPTION_KEY: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/, "Must be a 32-byte base64url key")
        .optional(),
    ),
  })
  .superRefine((value, context) => {
    if (value.MUSIC_MAX_STORAGE_BYTES < value.MUSIC_MAX_FILE_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Music storage quota must be at least the per-file limit",
      });
    }
    const oauthValues = [
      value.GOOGLE_CLIENT_ID,
      value.GOOGLE_CLIENT_SECRET,
      value.GOOGLE_OAUTH_REDIRECT_URI,
      value.MUSIC_TOKEN_ENCRYPTION_KEY,
    ];
    const configuredCount = oauthValues.filter((item) => item !== undefined).length;
    if (configuredCount !== 0 && configuredCount !== oauthValues.length) {
      context.addIssue({
        code: "custom",
        message: "Google OAuth variables must all be set together",
      });
    }
  })
  .transform(
    ({
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI,
      MUSIC_TOKEN_ENCRYPTION_KEY,
      ...server
    }) => ({
      ...server,
      youtubeOAuth:
        GOOGLE_CLIENT_ID === undefined ||
        GOOGLE_CLIENT_SECRET === undefined ||
        GOOGLE_OAUTH_REDIRECT_URI === undefined ||
        MUSIC_TOKEN_ENCRYPTION_KEY === undefined
          ? undefined
          : {
              clientId: GOOGLE_CLIENT_ID,
              clientSecret: GOOGLE_CLIENT_SECRET,
              redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
              encryptionKey: Buffer.from(MUSIC_TOKEN_ENCRYPTION_KEY, "base64url"),
            },
    }),
  );

export type ServerConfig = z.infer<typeof environment> & {
  readonly youtubeOAuth?: YouTubeOAuthConfig;
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): ServerConfig =>
  environment.parse(source);
