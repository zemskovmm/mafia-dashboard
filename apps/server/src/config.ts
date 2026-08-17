import { z } from "zod";
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
