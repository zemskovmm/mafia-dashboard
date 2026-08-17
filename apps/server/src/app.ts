import { randomUUID } from "node:crypto";
import staticFiles from "@fastify/static";
import Fastify from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { EventStore } from "./event-store.js";

const gameIdParams = z.object({ gameId: z.uuid() });
const createGameBody = z.object({ name: z.string().trim().min(1).max(100) });
const appendEventBody = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  type: z.string().trim().min(1).max(100),
  phase: z.string().trim().min(1).max(100),
  seat: z.number().int().min(1).max(10).optional(),
  payload: z.record(z.string(), z.unknown()),
  secret: z.boolean(),
});
const visibilityQuery = z.object({ visibility: z.enum(["host", "public"]).default("host") });

const validationFailure = (issues: readonly z.core.$ZodIssue[]) => ({
  error: "validation_failed",
  issues: issues.map(({ path, message }) => ({ path, message })),
});

export const buildApp = async ({
  pool,
  staticDir,
}: {
  readonly pool: Pool;
  readonly staticDir?: string;
}) => {
  const app = Fastify({ logger: false });
  const store = new EventStore(pool);
  await store.initialize();

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

  app.post("/api/games/:gameId/events", async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    const body = appendEventBody.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send(validationFailure(params.error.issues));
    }
    if (!body.success) {
      return reply.code(400).send(validationFailure(body.error.issues));
    }

    const event = await store.append({ gameId: params.data.gameId, ...body.data });
    return reply.code(event.duplicate ? 200 : 201).send({ event });
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
