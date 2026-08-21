import { z } from "zod";
import type { GoogleAuthConfig } from "./google-auth.js";
import type { YouTubeOAuthConfig } from "./youtube-oauth.js";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const environment = z
  .object({
    DATABASE_URL: z.url().default("postgresql://mafia:mafia@127.0.0.1:5432/mafia"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    STATIC_DIR: z.string().optional(),
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
    if ((value.GOOGLE_CLIENT_ID === undefined) !== (value.GOOGLE_CLIENT_SECRET === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Google client ID and secret must be set together",
      });
    }
    const musicValues = [value.GOOGLE_OAUTH_REDIRECT_URI, value.MUSIC_TOKEN_ENCRYPTION_KEY];
    const musicConfiguredCount = musicValues.filter((item) => item !== undefined).length;
    if (musicConfiguredCount === 1) {
      context.addIssue({
        code: "custom",
        message: "YouTube Music redirect URI and encryption key must be set together",
      });
    }
    if (
      musicConfiguredCount > 0 &&
      (value.GOOGLE_CLIENT_ID === undefined || value.GOOGLE_CLIENT_SECRET === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "YouTube Music OAuth requires Google client credentials",
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
      googleAuth:
        GOOGLE_CLIENT_ID === undefined ||
        GOOGLE_CLIENT_SECRET === undefined ||
        server.PUBLIC_APP_URL === undefined
          ? undefined
          : {
              clientId: GOOGLE_CLIENT_ID,
              clientSecret: GOOGLE_CLIENT_SECRET,
              redirectUri: new URL("/api/auth/google/callback", server.PUBLIC_APP_URL).toString(),
            },
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
  readonly googleAuth?: GoogleAuthConfig;
  readonly youtubeOAuth?: YouTubeOAuthConfig;
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): ServerConfig =>
  environment.parse(source);
