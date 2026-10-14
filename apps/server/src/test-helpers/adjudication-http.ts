import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

/** Exercise unchanged transport/read routes against each real storage provider. */
export const verifyAdjudicationHttp = async (app: FastifyInstance, clubId: string) => {
  const headers = { "x-club-id": clubId };
  const rulesEdition = "mafgame-2026-07-01";
  const adjudication = {
    losingTeam: "red",
    rule: "6.3.1",
    reason: "Recorded referee ruling — ППК",
    committeeApproved: false,
  };
  const initial = {
    game: { rulesEdition, phase: "day", completedGameNights: 2 },
    initialGame: { replayVersion: 2, rulesEdition, game: { rulesEdition, phase: "day" } },
    events: [],
  };
  const terminal = {
    ...initial,
    game: { ...initial.game, phase: "finished", winner: "black", adjudication },
  };
  const results = {
    hostPlayerId: null,
    outcome: "black",
    winner: "black",
    reason: null,
    playedAt: "2026-10-14T08:00:00.000Z",
    players: [],
    adjudication,
  };
  const creationId = randomUUID();
  const created = await app.inject({
    method: "POST",
    url: "/api/game-sessions",
    headers,
    payload: { creationId, name: "HTTP ruling", state: initial, results: null },
  });
  expect(created.statusCode, created.body).toBe(201);
  expect(created.json().state).toEqual(initial);
  const gameId = created.json().gameId as string;
  const url = `/api/game-sessions/${gameId}`;
  const pending = await app.inject({
    method: "PUT",
    url,
    headers,
    payload: { mutationId: randomUUID(), name: "Pending ruling", state: terminal, results: null },
  });
  expect(pending.statusCode, pending.body).toBe(200);
  const pendingRead = await app.inject({ url, headers });
  expect(pendingRead.statusCode, pendingRead.body).toBe(200);
  expect(pendingRead.json().session.state).toEqual(terminal);
  expect(pendingRead.json().session).toMatchObject({ status: "active", results: null });

  const invalid = { ...results, adjudication: { ...adjudication, nickname: "Copied profile" } };
  const invalidCreate = await app.inject({
    method: "POST",
    url: "/api/game-sessions",
    headers,
    payload: {
      creationId: randomUUID(),
      name: "Invalid ruling",
      state: terminal,
      results: invalid,
    },
  });
  expect(invalidCreate.statusCode, invalidCreate.body).toBe(400);
  const invalidSave = await app.inject({
    method: "PUT",
    url,
    headers,
    payload: { mutationId: randomUUID(), name: "Invalid ruling", state: {}, results: invalid },
  });
  expect(invalidSave.statusCode, invalidSave.body).toBe(400);
  expect((await app.inject({ url, headers })).json().session).toEqual(pendingRead.json().session);

  const saved = await app.inject({
    method: "PUT",
    url,
    headers,
    payload: { mutationId: randomUUID(), name: "Completed ruling", state: terminal, results },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().state).toEqual(terminal);
  expect(saved.json().results).toEqual(results);
  const read = await app.inject({ url, headers });
  expect(read.statusCode, read.body).toBe(200);
  expect(read.json().session.state).toEqual(terminal);
  expect(read.json().session.results).toEqual(results);
  expect(read.json().session).toMatchObject({ status: "completed" });
  const retry = await app.inject({
    method: "POST",
    url: "/api/game-sessions",
    headers,
    payload: { creationId, name: "Stale browser", state: initial, results: null },
  });
  expect(retry.statusCode, retry.body).toBe(200);
  expect(retry.json()).toMatchObject({ gameId, duplicate: true });
  expect(retry.json().state).toEqual(terminal);
  expect(retry.json().results).toEqual(results);
  const listing = await app.inject({ url: "/api/game-sessions?status=completed", headers });
  expect(listing.statusCode, listing.body).toBe(200);
  expect(listing.json().sessions).toContainEqual(
    expect.objectContaining({ gameId, outcome: "black", winner: "black", reason: null }),
  );
};
