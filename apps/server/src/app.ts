import { randomBytes, timingSafeEqual } from "node:crypto";

import helmet from "@fastify/helmet";
import staticFiles from "@fastify/static";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { InvalidGameIdentityError, UnsupportedGameFormatError } from "./game-session-identity.js";
import { DeletedGameError } from "./game-lifecycle.js";
import { GameSessionNotFoundError, GameSessionOperationError } from "./game-session-store.js";
import {
  gameSessionCreationSchema,
  gameSessionMutationSchema,
  publicHistoryValidationIssue,
} from "./game-session-validation.js";
import {
  ClubAccessConsentRequiredError,
  ManagerLockedError,
  OwnerProfileForbiddenError,
} from "./player-store.js";
import { YouTubePlaylistAccessError, YouTubeReconnectRequiredError } from "./youtube-oauth.js";
import type { YouTubeOAuthPort } from "./youtube-oauth.js";
import type { AppUser, GoogleAuthPort } from "./google-auth.js";
import type { ApplicationStores } from "./storage-contracts.js";
import { StorageAccessError } from "./azure-storage.js";
import { createFixedWindowLimiter, hasExactOrigin, isUnsafeMethod } from "./http-security.js";
import {
  getClubStatistics,
  getPlayerStatistics,
  StatisticsQueryError,
  statisticsFiltersSchema,
  statisticsHistoryQuerySchema,
} from "./club-statistics.js";
import { InvalidTournamentNameError, TournamentNotFoundError } from "./tournament-metadata.js";
import { statisticsIdentityKey as identityKey } from "./statistics-identity.js";

const gameIdParams = z.object({ gameId: z.uuid() });
const gameSessionListQuery = z
  .object({
    status: z.enum(["active", "completed"]).default("active"),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    playerId: z.uuid().optional(),
    outcome: z.enum(["red", "black", "draw", "cancelled"]).optional(),
  })
  .strict()
  .superRefine(({ status, from, to, playerId, outcome }, context) => {
    if (from !== undefined && to !== undefined && from > to) {
      context.addIssue({ code: "custom", path: ["to"], message: "to must not precede from" });
    }
    if (
      status !== "completed" &&
      [from, to, playerId, outcome].some((value) => value !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "History filters require status=completed",
      });
    }
  });
const playerIdParams = z.object({
  playerId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
});
const clubIdParams = z.object({ clubId: z.uuid() });
const playlistIdParams = z.object({ playlistId: z.string().trim().min(1).max(200) });
const visibilityQuery = z.object({ visibility: z.enum(["host", "public"]).default("host") });
const oauthCallbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const tournamentBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const tournamentAssignmentBody = z.object({ tournamentId: z.uuid().nullable() }).strict();
const nickname = z.string().trim().min(1).max(80);
const clubBody = z.object({
  name: z.string().trim().min(1).max(100),
  city: z.string().trim().min(1).max(100),
  headerLogo: z.string().max(1_500_000).nullable(),
  cardLogo: z.string().max(1_500_000).nullable(),
  language: z.enum(["en", "ru"]),
  bestMoveEnabled: z.boolean().optional(),
});
const createClubBody = clubBody.extend({
  bestMoveEnabled: z.boolean().default(true),
  ownerConsent: z.literal(true),
});
const noConsentPlayerBody = z.object({
  nickname,
  consent: z.literal(false),
  clubAccess: z.literal("none").default("none"),
  firstName: z.null().optional(),
  lastName: z.null().optional(),
  email: z.null().optional(),
});
const consentedPlayerBody = z.object({
  nickname,
  consent: z.literal(true),
  clubAccess: z.enum(["none", "user", "manager"]).default("none"),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.email().max(254),
});
const linkedManagerConsentWithdrawalBody = z.object({
  nickname,
  consent: z.literal(false),
  clubAccess: z.literal("manager"),
  firstName: z.null().optional(),
  lastName: z.null().optional(),
  email: z.null().optional(),
});
const playerProfileBody = z.discriminatedUnion("consent", [
  noConsentPlayerBody,
  consentedPlayerBody,
]);
const playerProfileUpdateBody = z.union([
  noConsentPlayerBody,
  consentedPlayerBody,
  linkedManagerConsentWithdrawalBody,
]);

const validationFailure = (issues: readonly z.core.$ZodIssue[]) => ({
  error: "validation_failed",
  issues: issues.map(
    (issue) => publicHistoryValidationIssue(issue) ?? { path: issue.path, message: issue.message },
  ),
});

const sendGameSessionMutationError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof TournamentNotFoundError) {
    return reply.code(404).send({ error: error.code });
  }
  if (error instanceof UnsupportedGameFormatError || error instanceof InvalidGameIdentityError) {
    return reply.code(409).send({ error: error.code });
  }
  if (error instanceof GameSessionNotFoundError) {
    return reply.code(404).send({ error: error.code });
  }
  if (error instanceof GameSessionOperationError) {
    return reply.code(409).send({ error: error.code });
  }
  if (error instanceof DeletedGameError) {
    return reply.code(410).send({ error: "game_deleted" });
  }
  throw error;
};

const isUniqueViolation = (
  error: unknown,
): error is { readonly code: "23505"; readonly constraint?: string } =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23505";

const playerConflictCode = (error: { readonly constraint?: string }) =>
  ["players_club_access_email_unique_idx", "players_club_linked_user_unique_idx"].includes(
    error.constraint ?? "",
  )
    ? "club_access_email_conflict"
    : "nickname_conflict";

const authStateCookieName = "auth_oauth_state";
const musicStateCookieName = "music_oauth_state";
const sessionCookieName = "mafia_session";
const readCookie = (header: string | undefined, name: string): string | null => {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const [cookieName, ...value] = part.trim().split("=");
    if (cookieName === name) return decodeURIComponent(value.join("="));
  }
  return null;
};

const matchesState = (expected: string | null, received: string): boolean => {
  if (expected === null) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
};

const cookie = ({
  name,
  value,
  path,
  maxAge,
  secure,
}: {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly maxAge: number;
  readonly secure: boolean;
}) =>
  `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${
    secure ? "; Secure" : ""
  }`;

export const buildApp = async ({
  stores: selectedStores,
  staticDir,
  googleAuth,
  authenticateRequest,
  defaultClubId,
  youtubeOAuth,
  publicAppUrl,
  releaseIdentity = { version: "0.0.0-dev", commit: "unknown" },
  trustedProxyHops = 0,
  authRateLimit,
}: {
  readonly stores: ApplicationStores;
  readonly staticDir?: string;
  readonly googleAuth?: GoogleAuthPort;
  readonly authenticateRequest?: (request: FastifyRequest) => Promise<AppUser | null>;
  readonly defaultClubId?: string;
  readonly youtubeOAuth?: YouTubeOAuthPort;
  readonly publicAppUrl?: string;
  readonly releaseIdentity?: { readonly version: string; readonly commit: string };
  readonly trustedProxyHops?: 0 | 1;

  readonly authRateLimit?: {
    readonly limit?: number;
    readonly windowMs?: number;
    readonly maxEntries?: number;
    readonly now?: () => number;
  };
}) => {
  if (selectedStores === undefined) {
    throw new Error("Application stores must be supplied");
  }
  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: trustedProxyHops === 1 ? (_address, hop) => hop === 0 : false,
  });
  const secureCookies = publicAppUrl !== undefined && new URL(publicAppUrl).protocol === "https:";
  await app.register(helmet, {
    crossOriginEmbedderPolicy: false,
    frameguard: { action: "deny" },
    hsts: secureCookies ? { maxAge: 31_536_000, includeSubDomains: false, preload: false } : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        scriptSrc: ["'self'", "https://www.youtube.com"],
        frameSrc: ["https://www.youtube.com", "https://www.youtube-nocookie.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'", "blob:"],
        upgradeInsecureRequests: secureCookies ? [] : null,
      },
    },
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StorageAccessError) return reply.code(403).send({ error: error.code });
    if (error instanceof YouTubeReconnectRequiredError) {
      return reply.code(409).send({ error: "youtube_reconnect_required" });
    }
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    if (statusCode !== undefined && statusCode < 500) {
      return reply.code(statusCode).send({ error: "request_failed" });
    }
    app.log.error("Internal request failure");
    return reply.code(500).send({ error: "internal_server_error" });
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("permissions-policy", "picture-in-picture=()");
    if (request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
  });
  const store = selectedStores.events;
  const gameSessionStore = selectedStores.games;
  const playerStore = selectedStores.players;
  const clubStore = selectedStores.clubs;
  const authAttemptLimiter = createFixedWindowLimiter({
    limit: authRateLimit?.limit ?? 10,
    windowMs: authRateLimit?.windowMs ?? 10 * 60 * 1_000,
    maxEntries: authRateLimit?.maxEntries,
    now: authRateLimit?.now,
  });
  const consumeAuthAttempt = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const result = authAttemptLimiter.consume(request.ip);
    if (result.allowed) return true;
    void reply
      .header("retry-after", String(result.retryAfterSeconds))
      .code(429)
      .send({ error: "auth_rate_limited" });
    return false;
  };

  if (publicAppUrl !== undefined) {
    const publicUrl = new URL(publicAppUrl);
    app.addHook("onRequest", async (request, reply) => {
      if (
        request.url.startsWith("/api/") &&
        isUnsafeMethod(request.method) &&
        readCookie(request.headers.cookie, sessionCookieName) !== null &&
        !hasExactOrigin(request.headers.origin, publicUrl.origin)
      ) {
        return reply.code(403).send({ error: "csrf_origin_mismatch" });
      }
      const acceptsHtml = request.headers.accept?.includes("text/html") === true;
      const isPageRequest = !request.url.startsWith("/api/") && !request.url.startsWith("/health/");
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        acceptsHtml &&
        isPageRequest &&
        request.hostname.toLowerCase() !== publicUrl.hostname.toLowerCase()
      ) {
        const requestedUrl = new URL(request.url, "http://local.invalid");
        const destination = new URL(publicUrl);
        destination.pathname = requestedUrl.pathname;
        destination.search = requestedUrl.search;
        return reply.redirect(destination.toString());
      }
    });
  }

  if (staticDir !== undefined) {
    await app.register(staticFiles, { root: staticDir, wildcard: false });
  }

  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/version", async (_request, reply) =>
    reply.header("cache-control", "no-store").send(releaseIdentity),
  );
  app.get("/health/ready", async (_request, reply) => {
    try {
      await selectedStores.ready();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not-ready" });
    }
  });

  const authenticate =
    authenticateRequest ??
    ((request: FastifyRequest) =>
      googleAuth?.getUserForSession(readCookie(request.headers.cookie, sessionCookieName)) ??
      Promise.resolve(null));
  const requireUser = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticate(request);
    if (user === null) await reply.code(401).send({ error: "authentication_required" });
    return user;
  };
  const selectedClubContext = async (
    request: FastifyRequest,
    reply: FastifyReply,
    authenticatedUser?: AppUser,
  ) => {
    const user = authenticatedUser ?? (await requireUser(request, reply));
    if (user === null) return null;
    const value = request.headers["x-club-id"];
    const clubId = typeof value === "string" ? value : defaultClubId;
    if (clubId === undefined || !z.uuid().safeParse(clubId).success) {
      await reply.code(400).send({ error: "club_required" });
      return null;
    }
    const role = await clubStore.getRole(user.id, clubId);
    if (role === null) {
      await reply.code(403).send({ error: "club_access_denied" });
      return null;
    }
    return { clubId, role, user };
  };
  const selectedClub = async (
    request: FastifyRequest,
    reply: FastifyReply,
    authenticatedUser?: AppUser,
  ) => (await selectedClubContext(request, reply, authenticatedUser))?.clubId ?? null;
  const selectedManagerClub = async (
    request: FastifyRequest,
    reply: FastifyReply,
    authenticatedUser?: AppUser,
  ) => {
    const context = await selectedClubContext(request, reply, authenticatedUser);
    if (context === null) return null;
    if (context.role !== "manager") {
      await reply.code(403).send({ error: "club_manager_required" });
      return null;
    }
    return context.clubId;
  };
  const authorized = <T>(
    userId: string,
    clubId: string,
    manager: boolean,
    work: () => Promise<T>,
  ): Promise<T> => selectedStores.runAuthorized?.(userId, clubId, manager, work) ?? work();
  const authorizedRequest = async <T>(
    request: FastifyRequest,
    clubId: string,
    manager: boolean,
    work: () => Promise<T>,
  ): Promise<T> => {
    const user = await authenticate(request);
    if (user === null) throw new Error("Club authorization context lost");
    return authorized(user.id, clubId, manager, work);
  };

  app.get("/api/auth/session", async (request) => ({
    configured: googleAuth !== undefined,
    user: await authenticate(request),
  }));

  app.get("/api/auth/google/start", async (_request, reply) => {
    if (googleAuth === undefined) {
      return reply.code(503).send({ error: "google_auth_not_configured" });
    }
    if (!consumeAuthAttempt(_request, reply)) return;
    const state = randomBytes(32).toString("base64url");
    return reply
      .header(
        "set-cookie",
        cookie({
          name: authStateCookieName,
          value: state,
          path: "/api/auth/google/callback",
          maxAge: 600,
          secure: true,
        }),
      )
      .redirect(googleAuth.createAuthorizationUrl(state));
  });

  app.get("/api/auth/google/callback", async (request, reply) => {
    if (googleAuth === undefined) {
      return reply.code(503).send({ error: "google_auth_not_configured" });
    }
    const query = oauthCallbackQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send(validationFailure(query.error.issues));
    const expectedState = readCookie(request.headers.cookie, authStateCookieName);
    if (!matchesState(expectedState, query.data.state)) {
      return reply.code(400).send({ error: "oauth_state_mismatch" });
    }
    if (!consumeAuthAttempt(request, reply)) return;
    const authorization = await googleAuth.completeAuthorization(query.data.code);
    await clubStore.claimClubAccess(authorization.user.id, authorization.user.email);
    return reply
      .header("set-cookie", [
        cookie({
          name: authStateCookieName,
          value: "",
          path: "/api/auth/google/callback",
          maxAge: 0,
          secure: true,
        }),
        cookie({
          name: sessionCookieName,
          value: authorization.sessionToken,
          path: "/",
          maxAge: Math.max(0, Math.floor((authorization.expiresAt.getTime() - Date.now()) / 1_000)),
          secure: secureCookies,
        }),
      ])
      .redirect("/");
  });

  app.delete("/api/auth/session", async (request, reply) => {
    const token = readCookie(request.headers.cookie, sessionCookieName);
    await googleAuth?.endSession(token);
    return reply
      .header(
        "set-cookie",
        cookie({
          name: sessionCookieName,
          value: "",
          path: "/",
          maxAge: 0,
          secure: secureCookies,
        }),
      )
      .code(204)
      .send();
  });

  app.get("/api/clubs", async (request, reply) => {
    const user = await requireUser(request, reply);
    return user === null ? undefined : { clubs: await clubStore.listForUser(user.id) };
  });

  app.post("/api/clubs", async (request, reply) => {
    const body = createClubBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send(validationFailure(body.error.issues));
    const user = await requireUser(request, reply);
    if (user === null) return;
    return reply.code(201).send({ club: await clubStore.create(user, body.data) });
  });

  app.put("/api/clubs/:clubId", async (request, reply) => {
    const params = clubIdParams.safeParse(request.params);
    const body = clubBody.safeParse(request.body);
    if (!params.success) return reply.code(400).send(validationFailure(params.error.issues));
    if (!body.success) return reply.code(400).send(validationFailure(body.error.issues));
    const user = await requireUser(request, reply);
    if (user === null) return;
    const role = await clubStore.getRole(user.id, params.data.clubId);
    if (role === null) return reply.code(403).send({ error: "club_access_denied" });
    if (role !== "manager") return reply.code(403).send({ error: "club_manager_required" });
    const club = await authorized(user.id, params.data.clubId, true, () =>
      clubStore.update(user.id, params.data.clubId, body.data),
    );
    return club === null ? reply.code(404).send({ error: "club_not_found" }) : reply.send({ club });
  });

  app.delete("/api/clubs/:clubId", async (request, reply) => {
    const params = clubIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error.issues));
    const user = await requireUser(request, reply);
    if (user === null) return;
    const role = await clubStore.getRole(user.id, params.data.clubId);
    if (role === null) {
      const resumed = await clubStore.resumeDeletion?.(user.id, params.data.clubId);
      return resumed
        ? reply.code(204).send()
        : reply.code(403).send({ error: "club_access_denied" });
    }
    if (role !== "manager") return reply.code(403).send({ error: "club_manager_required" });
    // Deletion owns its transaction-level authorization and durable purge actor.
    // Ordinary membership guards must not deny it after its own tombstone.
    return (await clubStore.delete(user.id, params.data.clubId))
      ? reply.code(204).send()
      : reply.code(404).send({ error: "club_not_found" });
  });

  app.get("/api/music/oauth/status", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === null) return;
    return youtubeOAuth === undefined
      ? { configured: false, connected: false, accountLabel: null }
      : youtubeOAuth.getStatus(user.id);
  });

  app.get("/api/music/oauth/start", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === null) return;
    if (youtubeOAuth === undefined) {
      return reply.code(503).send({ error: "youtube_oauth_not_configured" });
    }
    const state = randomBytes(32).toString("base64url");
    return reply
      .header(
        "set-cookie",
        cookie({
          name: musicStateCookieName,
          value: `${user.id}:${state}`,
          path: "/api/music/oauth/callback",
          maxAge: 600,
          secure: true,
        }),
      )
      .redirect(youtubeOAuth.createAuthorizationUrl(state));
  });

  app.get("/api/music/oauth/callback", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === null) return;
    if (youtubeOAuth === undefined) {
      return reply.code(503).send({ error: "youtube_oauth_not_configured" });
    }
    const query = oauthCallbackQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(validationFailure(query.error.issues));
    }
    const expectedState = readCookie(request.headers.cookie, musicStateCookieName);
    if (!matchesState(expectedState, `${user.id}:${query.data.state}`)) {
      return reply.code(400).send({ error: "oauth_state_mismatch" });
    }
    await youtubeOAuth.exchangeCode(user.id, query.data.code);
    return reply
      .header(
        "set-cookie",
        cookie({
          name: musicStateCookieName,
          value: "",
          path: "/api/music/oauth/callback",
          maxAge: 0,
          secure: true,
        }),
      )
      .redirect("/?music=connected");
  });

  app.get("/api/music/playlists", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === null) return;
    if (youtubeOAuth === undefined) {
      return reply.code(503).send({ error: "youtube_oauth_not_configured" });
    }
    return { playlists: await youtubeOAuth.listPlaylists(user.id) };
  });

  app.get("/api/music/playlists/:playlistId/items", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === null) return;
    if (youtubeOAuth === undefined) {
      return reply.code(503).send({ error: "youtube_oauth_not_configured" });
    }
    const params = playlistIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error.issues));
    try {
      return { items: await youtubeOAuth.listPlaylistItems(user.id, params.data.playlistId) };
    } catch (error) {
      if (error instanceof YouTubePlaylistAccessError) {
        return reply.code(404).send({ error: "youtube_playlist_not_available" });
      }
      throw error;
    }
  });

  app.delete("/api/music/oauth/connection", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (user === null) return;
    if (youtubeOAuth === undefined) {
      return reply.code(503).send({ error: "youtube_oauth_not_configured" });
    }
    await youtubeOAuth.disconnect(user.id);
    return reply.code(204).send();
  });

  app.get("/api/players", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    return {
      players: await authorizedRequest(request, clubId, false, () => playerStore.list(clubId)),
    };
  });

  app.post("/api/players", async (request, reply) => {
    const clubId = await selectedManagerClub(request, reply);
    if (clubId === null) return;
    const parsed = playerProfileBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error.issues));
    }
    try {
      const player = await authorizedRequest(request, clubId, true, () =>
        playerStore.create(
          {
            ...parsed.data,
            firstName: parsed.data.firstName ?? null,
            lastName: parsed.data.lastName ?? null,
            email: parsed.data.email ?? null,
          },
          clubId,
        ),
      );
      return reply.code(201).send({ player });
    } catch (error) {
      if (error instanceof ClubAccessConsentRequiredError) {
        return reply.code(400).send({ error: error.code });
      }
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: playerConflictCode(error) });
      }
      throw error;
    }
  });

  app.put("/api/players/:playerId", async (request, reply) => {
    const actor = await requireUser(request, reply);
    if (actor === null) return;
    const clubId = await selectedManagerClub(request, reply, actor);
    if (clubId === null) return;
    const params = playerIdParams.safeParse(request.params);
    const body = playerProfileUpdateBody.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    if (!body.success) {
      return reply.code(400).send(validationFailure(body.error.issues));
    }
    try {
      const player = await authorizedRequest(request, clubId, true, () =>
        playerStore.update(
          params.data.playerId,
          {
            ...body.data,
            firstName: body.data.firstName ?? null,
            lastName: body.data.lastName ?? null,
            email: body.data.email ?? null,
          },
          clubId,
          actor.id,
        ),
      );
      if (player === null) {
        return reply.code(404).send({ error: "player_not_found" });
      }
      return { player };
    } catch (error) {
      if (error instanceof ClubAccessConsentRequiredError) {
        return reply.code(400).send({ error: error.code });
      }
      if (error instanceof ManagerLockedError) {
        return reply.code(409).send({ error: "manager_locked" });
      }
      if (error instanceof OwnerProfileForbiddenError) {
        return reply.code(403).send({ error: error.code });
      }
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: playerConflictCode(error) });
      }
      throw error;
    }
  });

  app.delete("/api/players/:playerId", async (request, reply) => {
    const clubId = await selectedManagerClub(request, reply);
    if (clubId === null) return;
    const params = playerIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    const result = await authorizedRequest(request, clubId, true, () =>
      playerStore.delete(params.data.playerId, clubId),
    );
    if (result === "not_found") return reply.code(404).send({ error: "player_not_found" });
    if (result === "active_game") return reply.code(409).send({ error: "active_game" });
    if (result === "manager_locked") return reply.code(409).send({ error: "manager_locked" });
    return reply.code(204).send();
  });

  app.get("/api/tournaments", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    return {
      tournaments: await authorizedRequest(request, clubId, false, () =>
        selectedStores.tournaments.list(clubId),
      ),
    };
  });

  app.post("/api/tournaments", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    const body = tournamentBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send(validationFailure(body.error.issues));
    try {
      const tournament = await authorizedRequest(request, clubId, false, async () => {
        const created = await selectedStores.tournaments.create(body.data.name, clubId);
        const confirmed = (await selectedStores.tournaments.list(clubId)).find(
          ({ id }) => id === created.id,
        );
        if (confirmed === undefined) throw new Error("Tournament creation could not be confirmed");
        return confirmed;
      });
      return reply.code(201).send({ tournament });
    } catch (error) {
      if (error instanceof InvalidTournamentNameError)
        return reply.code(400).send({ error: error.code });
      throw error;
    }
  });

  app.put("/api/game-sessions/:gameId/tournament", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    const params = gameIdParams.safeParse(request.params);
    const body = tournamentAssignmentBody.safeParse(request.body);
    if (!params.success) return reply.code(400).send(validationFailure(params.error.issues));
    if (!body.success) return reply.code(400).send(validationFailure(body.error.issues));
    try {
      const tournamentId = await authorizedRequest(request, clubId, false, async () => {
        const current = await gameSessionStore.get(params.data.gameId, clubId);
        if (current === null) throw new GameSessionNotFoundError();
        await selectedStores.tournaments.assign(params.data.gameId, body.data.tournamentId, clubId);
        const confirmed = await gameSessionStore.get(params.data.gameId, clubId);
        if (confirmed === null) throw new GameSessionNotFoundError();
        return confirmed.tournamentId ?? null;
      });
      return { tournamentId };
    } catch (error) {
      return sendGameSessionMutationError(reply, error);
    }
  });

  app.get("/api/statistics", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    const query = statisticsFiltersSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send(validationFailure(query.error.issues));
    try {
      const source = await authorizedRequest(request, clubId, false, () =>
        gameSessionStore.readStatisticsInputs(clubId),
      );
      if (
        query.data.tournamentId !== undefined &&
        query.data.tournamentId !== "none" &&
        !source.tournaments.some(
          ({ id }) => identityKey(id) === identityKey(query.data.tournamentId!),
        )
      ) {
        return reply.code(404).send({ error: "tournament_not_found" });
      }
      return getClubStatistics(source, query.data);
    } catch (error) {
      if (error instanceof StatisticsQueryError) return reply.code(400).send({ error: error.code });
      return sendGameSessionMutationError(reply, error);
    }
  });

  app.get("/api/statistics/players/:playerId", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    const params = playerIdParams.safeParse(request.params);
    const query = statisticsHistoryQuerySchema.safeParse(request.query);
    if (!params.success) return reply.code(400).send(validationFailure(params.error.issues));
    if (!query.success) return reply.code(400).send(validationFailure(query.error.issues));
    const { cursor, limit, ...filters } = query.data;
    try {
      const source = await authorizedRequest(request, clubId, false, () =>
        gameSessionStore.readStatisticsInputs(clubId),
      );
      if (
        filters.tournamentId !== undefined &&
        filters.tournamentId !== "none" &&
        !source.tournaments.some(({ id }) => identityKey(id) === identityKey(filters.tournamentId!))
      ) {
        return reply.code(404).send({ error: "tournament_not_found" });
      }
      const result = getPlayerStatistics(source, params.data.playerId, filters, { cursor, limit });
      return result.player === null ? reply.code(404).send({ error: "player_not_found" }) : result;
    } catch (error) {
      if (error instanceof StatisticsQueryError) return reply.code(400).send({ error: error.code });
      return sendGameSessionMutationError(reply, error);
    }
  });

  app.get("/api/game-sessions", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    const query = gameSessionListQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send(validationFailure(query.error.issues));
    try {
      return {
        sessions: await authorizedRequest(request, clubId, false, async () =>
          query.data.status === "completed"
            ? await gameSessionStore.listCompleted(clubId, {
                ...(query.data.from === undefined ? {} : { from: query.data.from }),
                ...(query.data.to === undefined ? {} : { to: query.data.to }),
                ...(query.data.playerId === undefined ? {} : { playerId: query.data.playerId }),
                ...(query.data.outcome === undefined ? {} : { outcome: query.data.outcome }),
              })
            : await gameSessionStore.listActive(clubId),
        ),
      };
    } catch (error) {
      if (error instanceof UnsupportedGameFormatError)
        return reply.code(409).send({ error: error.code });
      throw error;
    }
  });

  app.get("/api/game-sessions/:gameId", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    const params = gameIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error.issues));
    let session;
    try {
      session = await authorizedRequest(request, clubId, false, () =>
        gameSessionStore.get(params.data.gameId, clubId),
      );
    } catch (error) {
      if (error instanceof UnsupportedGameFormatError)
        return reply.code(409).send({ error: error.code });
      throw error;
    }
    if (session === null) return reply.code(404).send({ error: "game_session_not_found" });
    return { session };
  });

  app.post("/api/game-sessions", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    const body = gameSessionCreationSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send(validationFailure(body.error.issues));
    try {
      const session = await authorizedRequest(request, clubId, false, () =>
        gameSessionStore.create({ clubId, ...body.data }),
      );
      return reply.code(session.duplicate ? 200 : 201).send(session);
    } catch (error) {
      return sendGameSessionMutationError(reply, error);
    }
  });

  app.put("/api/game-sessions/:gameId", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    const params = gameIdParams.safeParse(request.params);
    const body = gameSessionMutationSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send(validationFailure(params.error.issues));
    if (!body.success) return reply.code(400).send(validationFailure(body.error.issues));
    try {
      const session = await authorizedRequest(request, clubId, false, () =>
        gameSessionStore.save({
          clubId,
          gameId: params.data.gameId,
          name: body.data.name,
          mutationId: body.data.mutationId,
          state: body.data.state,
          results: body.data.results,
        }),
      );
      return reply.code(200).send(session);
    } catch (error) {
      return sendGameSessionMutationError(reply, error);
    }
  });

  app.delete("/api/game-sessions/:gameId", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    const params = gameIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error.issues));
    try {
      await authorizedRequest(request, clubId, false, () =>
        gameSessionStore.clear({
          clubId,
          gameId: params.data.gameId,
        }),
      );
      return reply.code(204).send();
    } catch (error) {
      return sendGameSessionMutationError(reply, error);
    }
  });

  app.get("/api/games/:gameId/events", async (request, reply) => {
    const clubId = await selectedClub(request, reply);
    if (clubId === null) return;
    const params = gameIdParams.safeParse(request.params);
    const query = visibilityQuery.safeParse(request.query);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    if (!query.success) {
      return reply.code(400).send(validationFailure(query.error.issues));
    }

    try {
      // Older raw-event fixtures need not have an aggregate row. A present
      // aggregate still must pass identity-only read admission first.
      const events = await authorizedRequest(request, clubId, false, async () => {
        await gameSessionStore.get(params.data.gameId, clubId);
        return store.read(
          params.data.gameId,
          { includeSecrets: query.data.visibility === "host" },
          clubId,
        );
      });
      return { events };
    } catch (error) {
      if (error instanceof UnsupportedGameFormatError)
        return reply.code(409).send({ error: error.code });
      throw error;
    }
  });

  if (staticDir !== undefined) {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/health/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
};
