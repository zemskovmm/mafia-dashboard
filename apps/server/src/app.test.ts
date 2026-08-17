import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildApp } from "./app.js";

const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test",
});
const app = await buildApp({ pool });

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("server API", () => {
  it("reports liveness and database readiness separately", async () => {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "live" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
  });

  it("creates a game with the first append-only event", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/games",
      payload: { name: "Friday table" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.gameId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.event).toMatchObject({
      gameId: body.gameId,
      sequence: 1,
      type: "game.created",
      phase: "setup-players",
      secret: false,
      payload: { name: "Friday table" },
    });
  });

  it("appends validated events and returns the ordered host log", async () => {
    const gameId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events`,
      payload: {
        idempotencyKey: "timer-1",
        type: "timer.started",
        phase: "day",
        seat: 3,
        payload: { seconds: 60 },
        secret: false,
      },
    });
    expect(response.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events`,
      payload: {
        idempotencyKey: "timer-1",
        type: "timer.started",
        phase: "day",
        seat: 3,
        payload: { seconds: 60 },
        secret: false,
      },
    });
    expect(duplicate.statusCode).toBe(200);

    const log = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    expect(log.statusCode).toBe(200);
    expect(log.json().events).toHaveLength(1);
    expect(log.json().events[0]).toMatchObject({ sequence: 1, type: "timer.started" });
  });

  it("rejects invalid events without appending anything", async () => {
    const gameId = randomUUID();
    const invalid = await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events`,
      payload: {
        idempotencyKey: "invalid-seat",
        type: "foul.issued",
        phase: "day",
        seat: 11,
        payload: {},
        secret: false,
      },
    });

    expect(invalid.statusCode).toBe(400);
    const log = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    expect(log.json().events).toEqual([]);
  });

  it("redacts secret event payloads from public log requests", async () => {
    const gameId = randomUUID();
    await app.inject({
      method: "POST",
      url: `/api/games/${gameId}/events`,
      payload: {
        idempotencyKey: "check-1",
        type: "sheriff.checked",
        phase: "night-sheriff",
        seat: 5,
        payload: { targetSeat: 8, match: true },
        secret: true,
      },
    });

    const host = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    const publicLog = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/events?visibility=public`,
    });

    expect(host.json().events[0].payload).toEqual({ targetSeat: 8, match: true });
    expect(publicLog.json().events[0].payload).toEqual({ redacted: true });
  });
});
