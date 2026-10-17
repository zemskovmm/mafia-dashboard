import { z } from "zod";
import type { GoogleAuthConfig } from "./google-auth.js";
import type { YouTubeOAuthConfig } from "./youtube-oauth.js";
import type { AzureStorageOptions } from "./storage-contracts.js";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const environment = z
  .object({
    STORAGE_PROVIDER: z.literal("azure").default("azure"),
    AZURE_STORAGE_CONNECTION_STRING: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    AZURE_STORAGE_ACCOUNT_NAME: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^[a-z0-9]{3,24}$/)
        .optional(),
    ),
    AZURE_STORAGE_TABLE_NAME: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]{2,62}$/)
      .default("MafiaEntities"),
    AZURE_STORAGE_CONTAINER_NAME: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/)
      .default("mafia-live"),
    AZURE_STORAGE_PARTITION_KEY: z.preprocess(
      emptyToUndefined,
      z.string().min(1).max(256).optional(),
    ),
    AZURE_STORAGE_INITIALIZE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    TRUST_PROXY_HOPS: z
      .enum(["0", "1"])
      .default("0")
      .transform((value) => Number(value) as 0 | 1),
    STATIC_DIR: z.string().optional(),
    PUBLIC_APP_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    APP_COMMIT: z
      .union([z.literal("unknown"), z.string().regex(/^[0-9a-f]{40}$/)])
      .default("unknown"),
    APP_BUILD_INDEX: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .default("0")
      .transform(Number)
      .pipe(z.int().nonnegative()),
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
    if (
      value.AZURE_STORAGE_PARTITION_KEY === undefined ||
      [...value.AZURE_STORAGE_PARTITION_KEY].some(
        (character) =>
          "/\\#?".includes(character) ||
          character.charCodeAt(0) < 32 ||
          (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Azure storage requires a stable valid partition key",
      });
    }
    if (
      (value.AZURE_STORAGE_ACCOUNT_NAME === undefined) ===
      (value.AZURE_STORAGE_CONNECTION_STRING === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Azure storage requires exactly one of account name or local connection string",
      });
    }
    if (value.AZURE_STORAGE_CONNECTION_STRING !== undefined) {
      const endpoints = [
        ...value.AZURE_STORAGE_CONNECTION_STRING.matchAll(
          /(?:^|;)(?:BlobEndpoint|TableEndpoint)=([^;]+)/g,
        ),
      ].map((match) => match[1]!);
      if (
        endpoints.length !== 2 ||
        endpoints.some((endpoint) => {
          try {
            const url = new URL(endpoint);
            return (
              url.protocol !== "http:" ||
              url.hostname !== "127.0.0.1" ||
              url.username !== "" ||
              url.password !== "" ||
              url.search !== ""
            );
          } catch {
            return true;
          }
        }) ||
        !value.AZURE_STORAGE_CONNECTION_STRING.includes("DefaultEndpointsProtocol=http") ||
        value.AZURE_STORAGE_CONNECTION_STRING.includes("SharedAccessSignature=")
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Azure storage connection string is only allowed for explicit loopback Blob and Table endpoints",
        });
      }
    }
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
      AZURE_STORAGE_CONNECTION_STRING,
      AZURE_STORAGE_ACCOUNT_NAME,
      AZURE_STORAGE_TABLE_NAME,
      AZURE_STORAGE_CONTAINER_NAME,
      AZURE_STORAGE_PARTITION_KEY,
      ...server
    }) => ({
      ...server,
      azureStorage: {
        tableName: AZURE_STORAGE_TABLE_NAME,
        containerName: AZURE_STORAGE_CONTAINER_NAME,
        partitionKey: AZURE_STORAGE_PARTITION_KEY!,
        ...(AZURE_STORAGE_CONNECTION_STRING === undefined
          ? { accountName: AZURE_STORAGE_ACCOUNT_NAME! }
          : { connectionString: AZURE_STORAGE_CONNECTION_STRING }),
      },
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
  readonly azureStorage: AzureStorageOptions;
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): ServerConfig =>
  environment.parse(source);
