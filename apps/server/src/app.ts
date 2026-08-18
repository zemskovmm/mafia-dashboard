import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import staticFiles from "@fastify/static";
import Fastify from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { EventStore } from "./event-store.js";
import { AuthoritativeGameSessionError, DeletedGameError } from "./game-lifecycle.js";
import {
  GameSessionConflictError,
  GameSessionMutationMismatchError,
  GameSessionStore,
} from "./game-session-store.js";
import {
  durableGameEventTypeSchema,
  gameSessionMutationSchema,
} from "./game-session-validation.js";
import { PlayerStore } from "./player-store.js";
import type { YouTubeOAuthService } from "./youtube-oauth.js";

const gameIdParams = z.object({ gameId: z.uuid() });
const playerIdParams = z.object({ playerId: z.uuid() });
const createGameBody = z.object({ name: z.string().trim().min(1).max(100) });
const appendEventBody = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  type: durableGameEventTypeSchema,
  phase: z.string().trim().min(1).max(100),
  seat: z.number().int().min(1).max(10).optional(),
  payload: z.record(z.string(), z.unknown()),
  secret: z.boolean(),
});
const truncateEventsBody = z.object({
  fromIdempotencyKey: z.string().trim().min(1).max(200),
});
const visibilityQuery = z.object({ visibility: z.enum(["host", "public"]).default("host") });
const oauthCallbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const nickname = z.string().trim().min(1).max(80);
const playerProfileBody = z.discriminatedUnion("consent", [
  z.object({
    nickname,
    consent: z.literal(false),
    firstName: z.null().optional(),
    lastName: z.null().optional(),
    email: z.null().optional(),
  }),
  z.object({
    nickname,
    consent: z.literal(true),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.email().max(254),
  }),
]);

const gamePlayerResultBody = z.object({
  playerId: z.uuid(),
  seat: z.number().int().min(1).max(10),
  role: z.enum(["sheriff", "citizen", "mafia", "don"]),
  team: z.enum(["red", "black"]),
  status: z.enum(["active", "eliminated", "red-carded"]),
  fouls: z.number().int().min(0),
});

const gameResultsBody = z
  .object({
    hostPlayerId: z.uuid(),
    winner: z.enum(["red", "black"]),
    playedAt: z.coerce.date(),
    players: z.array(gamePlayerResultBody).length(10),
  })
  .superRefine(({ hostPlayerId, players }, context) => {
    if (hostPlayerId !== null && players.some(({ playerId }) => playerId === hostPlayerId)) {
      context.addIssue({
        code: "custom",
        path: ["hostPlayerId"],
        message: "Host must not also occupy a player seat",
      });
    }
    if (new Set(players.map(({ playerId }) => playerId)).size !== players.length) {
      context.addIssue({ code: "custom", path: ["players"], message: "Player IDs must be unique" });
    }
    if (new Set(players.map(({ seat }) => seat)).size !== players.length) {
      context.addIssue({ code: "custom", path: ["players"], message: "Seats must be unique" });
    }

    const expectedRoleCounts = { sheriff: 1, citizen: 6, mafia: 2, don: 1 } as const;
    for (const [role, expected] of Object.entries(expectedRoleCounts)) {
      if (players.filter((player) => player.role === role).length !== expected) {
        context.addIssue({
          code: "custom",
          path: ["players"],
          message: `Expected ${expected} ${role} result${expected === 1 ? "" : "s"}`,
        });
      }
    }

    for (const [index, player] of players.entries()) {
      const expectedTeam = player.role === "mafia" || player.role === "don" ? "black" : "red";
      if (player.team !== expectedTeam) {
        context.addIssue({
          code: "custom",
          path: ["players", index, "team"],
          message: `${player.role} must belong to the ${expectedTeam} team`,
        });
      }
    }
  });

const validationFailure = (issues: readonly z.core.$ZodIssue[]) => ({
  error: "validation_failed",
  issues: issues.map(({ path, message }) => ({ path, message })),
});

const isUniqueViolation = (error: unknown): error is { readonly code: "23505" } =>
  typeof error === "object" && error !== null && "code" in error && error.code === "23505";

const oauthStateCookieName = "music_oauth_state";
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

const stateCookie = (state: string, maxAge: number) =>
  `${oauthStateCookieName}=${encodeURIComponent(state)}; Path=/api/music/oauth/callback; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

export const buildApp = async ({
  pool,
  staticDir,
  youtubeOAuth,
  publicAppUrl,
}: {
  readonly pool: Pool;
  readonly staticDir?: string;
  readonly youtubeOAuth?: YouTubeOAuthService;
  readonly publicAppUrl?: string;
}) => {
  const app = Fastify({ logger: false });
  const store = new EventStore(pool);
  const gameSessionStore = new GameSessionStore(pool);
  const playerStore = new PlayerStore(pool);
  await store.initialize();

  if (publicAppUrl !== undefined) {
    const publicUrl = new URL(publicAppUrl);
    app.addHook("onRequest", async (request, reply) => {
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
  app.get("/health/ready", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not-ready" });
    }
  });

  app.get("/api/music/oauth/status", async () =>
    youtubeOAuth === undefined
      ? { configured: false, connected: false, accountLabel: null }
      : youtubeOAuth.getStatus(),
  );

  app.get("/api/music/oauth/start", async (_request, reply) => {
    if (youtubeOAuth === undefined) {
      return reply.code(503).send({ error: "youtube_oauth_not_configured" });
    }
    const state = randomBytes(32).toString("base64url");
    return reply
      .header("set-cookie", stateCookie(state, 600))
      .redirect(youtubeOAuth.createAuthorizationUrl(state));
  });

  app.get("/api/music/oauth/callback", async (request, reply) => {
    if (youtubeOAuth === undefined) {
      return reply.code(503).send({ error: "youtube_oauth_not_configured" });
    }
    const query = oauthCallbackQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send(validationFailure(query.error.issues));
    }
    const expectedState = readCookie(request.headers.cookie, oauthStateCookieName);
    if (!matchesState(expectedState, query.data.state)) {
      return reply.code(400).send({ error: "oauth_state_mismatch" });
    }
    await youtubeOAuth.exchangeCode(query.data.code);
    return reply.header("set-cookie", stateCookie("", 0)).redirect("/?music=connected");
  });

  app.get("/api/music/playlists", async (_request, reply) => {
    if (youtubeOAuth === undefined) {
      return reply.code(503).send({ error: "youtube_oauth_not_configured" });
    }
    return { playlists: await youtubeOAuth.listPlaylists() };
  });

  app.delete("/api/music/oauth/connection", async (_request, reply) => {
    if (youtubeOAuth === undefined) {
      return reply.code(503).send({ error: "youtube_oauth_not_configured" });
    }
    await youtubeOAuth.disconnect();
    return reply.code(204).send();
  });

  app.get("/api/players", async () => ({ players: await playerStore.list() }));

  app.post("/api/players", async (request, reply) => {
    const parsed = playerProfileBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error.issues));
    }
    try {
      const player = await playerStore.create({
        ...parsed.data,
        firstName: parsed.data.firstName ?? null,
        lastName: parsed.data.lastName ?? null,
        email: parsed.data.email ?? null,
      });
      return reply.code(201).send({ player });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: "nickname_conflict" });
      }
      throw error;
    }
  });

  app.put("/api/players/:playerId", async (request, reply) => {
    const params = playerIdParams.safeParse(request.params);
    const body = playerProfileBody.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    if (!body.success) {
      return reply.code(400).send(validationFailure(body.error.issues));
    }
    try {
      const player = await playerStore.update(params.data.playerId, {
        ...body.data,
        firstName: body.data.firstName ?? null,
        lastName: body.data.lastName ?? null,
        email: body.data.email ?? null,
      });
      if (player === null) {
        return reply.code(404).send({ error: "player_not_found" });
      }
      return { player };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: "nickname_conflict" });
      }
      throw error;
    }
  });

  app.delete("/api/players/:playerId", async (request, reply) => {
    const params = playerIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    const result = await playerStore.delete(params.data.playerId);
    if (result === "not_found") return reply.code(404).send({ error: "player_not_found" });
    if (result === "active_game") return reply.code(409).send({ error: "active_game" });
    return reply.code(204).send();
  });

  app.get("/api/game-sessions", async () => ({
    sessions: await gameSessionStore.listActive(),
  }));

  app.get("/api/game-sessions/:gameId", async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error.issues));
    const session = await gameSessionStore.get(params.data.gameId);
    if (session === null) return reply.code(404).send({ error: "game_session_not_found" });
    return { session };
  });

  app.put("/api/game-sessions/:gameId", async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    const body = gameSessionMutationSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send(validationFailure(params.error.issues));
    if (!body.success) return reply.code(400).send(validationFailure(body.error.issues));
    try {
      const session = await gameSessionStore.save({ gameId: params.data.gameId, ...body.data });
      return reply.code(session.duplicate || session.revision > 1 ? 200 : 201).send(session);
    } catch (error) {
      if (error instanceof GameSessionMutationMismatchError) {
        return reply.code(409).send({ error: "game_session_mutation_mismatch" });
      }
      if (error instanceof GameSessionConflictError) {
        return reply.code(409).send({
          error: "game_session_revision_conflict",
          currentRevision: error.currentRevision,
        });
      }
      if (error instanceof DeletedGameError) {
        return reply.code(410).send({ error: "game_deleted" });
      }
      throw error;
    }
  });

  app.delete("/api/game-sessions/:gameId", async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(validationFailure(params.error.issues));
    await gameSessionStore.clear(params.data.gameId);
    return reply.code(204).send();
  });

  app.post("/api/games", async (request, reply) => {
    const parsed = createGameBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(validationFailure(parsed.error.issues));
    }

    const gameId = randomUUID();
    const event = await store.append({
      gameId,
      idempotencyKey: "game-created",
      type: "game.created",
      phase: "setup-players",
      payload: { name: parsed.data.name },
      secret: false,
    });
    return reply.code(201).send({ gameId, event });
  });

  app.delete("/api/games/:gameId", async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    try {
      await store.deleteGame(params.data.gameId);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof AuthoritativeGameSessionError) {
        return reply.code(409).send({ error: "game_session_authoritative" });
      }
      throw error;
    }
  });

  app.post("/api/games/:gameId/events/truncate", async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    const body = truncateEventsBody.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    if (!body.success) {
      return reply.code(400).send(validationFailure(body.error.issues));
    }
    try {
      await store.truncateFrom(params.data.gameId, body.data.fromIdempotencyKey);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof AuthoritativeGameSessionError) {
        return reply.code(409).send({ error: "game_session_authoritative" });
      }
      throw error;
    }
  });

  app.post("/api/games/:gameId/events", async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    const body = appendEventBody.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    if (!body.success) {
      return reply.code(400).send(validationFailure(body.error.issues));
    }

    try {
      const event = await store.append({ gameId: params.data.gameId, ...body.data });
      return reply.code(event.duplicate ? 200 : 201).send({ event });
    } catch (error) {
      if (error instanceof AuthoritativeGameSessionError) {
        return reply.code(409).send({ error: "game_session_authoritative" });
      }
      throw error;
    }
  });

  app.get("/api/games/:gameId/events", async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    const query = visibilityQuery.safeParse(request.query);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    if (!query.success) {
      return reply.code(400).send(validationFailure(query.error.issues));
    }

    const events = await store.read(params.data.gameId, {
      includeSecrets: query.data.visibility === "host",
    });
    return { events };
  });

  app.put("/api/games/:gameId/results", async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    const body = gameResultsBody.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    if (!body.success) {
      return reply.code(400).send(validationFailure(body.error.issues));
    }
    try {
      await playerStore.saveGameResults({ gameId: params.data.gameId, ...body.data });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof DeletedGameError) {
        return reply.code(410).send({ error: "game_deleted" });
      }
      if (error instanceof AuthoritativeGameSessionError) {
        return reply.code(409).send({ error: "game_session_authoritative" });
      }
      throw error;
    }
  });

  app.delete("/api/games/:gameId/results", async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    try {
      await playerStore.deleteGameResults(params.data.gameId);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof DeletedGameError) {
        return reply.code(410).send({ error: "game_deleted" });
      }
      if (error instanceof AuthoritativeGameSessionError) {
        return reply.code(409).send({ error: "game_session_authoritative" });
      }
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
