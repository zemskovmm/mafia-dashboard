import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashGameState, isSecretGameEventType, replayGameLog } from "@mafia/game-domain";
import { buildApp } from "./app.js";
import { AzureAccountStore } from "./azure-account-store.js";
import { AzureClubStore, AzurePlayerStore } from "./azure-club-player-store.js";
import { AzureEventStore, AzureGameSessionStore } from "./azure-game-session-store.js";
import { AzureTournamentStore } from "./azure-tournament-store.js";
import { AzureStorage, blobReference } from "./azure-storage.js";
import type { ApplicationStores } from "./storage-contracts.js";
import type { FinalGameResults, GameSessionState } from "./game-session-store.js";

import { createStorageFixture } from "./test-helpers/storage-fixture.js";
import {
  buildAcceptedResults,
  createCanonicalHistory,
  generateAutomaticDraw,
  generateBestMoveAndBallot,
  generateRoleDeal,
  jsonHash,
  jsonRoundTrip,
  type CanonicalSnapshot,
} from "./test-helpers/canonical-history.js";

type RawRecord = { state: GameSessionState; results: FinalGameResults | null };
type Context = {
  app: Awaited<ReturnType<typeof buildApp>>;
  clubId: string;
  stores: () => ApplicationStores;
  raw: (gameId: string) => Promise<RawRecord>;
  projections: (gameId: string) => Promise<{
    outcome: unknown;
    winner: unknown;
    reason: unknown;
    players: {
      playerId: string;
      status: string;
      won: boolean | null;
      bestMoveHits: number | null;
    }[];
  }>;
  reopen: () => Promise<void>;
  close: () => Promise<void>;
};

const openAzure = async (): Promise<Context> => {
  const fixture = await createStorageFixture();
  let storage = fixture.storage;
  try {
    const owner = await new AzureAccountStore(storage).upsertUser({
      id: randomUUID(),
      subject: randomUUID(),
      email: `${randomUUID()}@example.test`,
      name: "Canonical owner",
      picture: null,
    });
    const stores = (): ApplicationStores => ({
      clubs: new AzureClubStore(storage),
      players: new AzurePlayerStore(storage),
      games: new AzureGameSessionStore(storage),
      tournaments: new AzureTournamentStore(storage),
      events: new AzureEventStore(storage),
      ready: () => storage.ready(),
      runAuthorized: (userId, clubId, manager, work) =>
        storage.runAuthorized(userId, clubId, manager, work),
    });
    const makeApp = () => buildApp({ stores: stores(), authenticateRequest: async () => owner });
    const context: Context = {
      app: await makeApp(),
      clubId: "",
      stores,
      raw: async (gameId) => {
        const row = await storage.getEntity(`club:${context.clubId}:game:${gameId}`);
        if (!row) throw new Error("Missing accepted Azure game pointer");
        const body = await storage.read((tx) =>
          tx.readBlob<{ session: RawRecord }>(blobReference(row)),
        );
        return { state: body.session.state, results: body.session.results };
      },
      projections: async (gameId) => {
        const summary = (await stores().games.listCompleted(context.clubId)).find(
          (row) => row.gameId === gameId,
        );
        if (!summary) throw new Error("Missing Azure completed projection");
        const rows = await storage.read((tx) =>
          tx.list<{
            playerId: string;
            isHost: boolean;
            status: string;
            won?: boolean;
            bestMoveHits?: number;
          }>(`club:${context.clubId}:result:${gameId}:`),
        );
        return {
          outcome: summary.outcome,
          winner: summary.winner,
          reason: summary.reason,
          players: rows
            .filter(({ isHost }) => !isHost)
            .map((row) => ({
              playerId: row.playerId,
              status: row.status,
              won: row.won ?? null,
              bestMoveHits: row.bestMoveHits ?? null,
            })),
        };
      },
      reopen: async () => {
        await context.app.close();
        await storage.end();
        storage = new AzureStorage(fixture.options);
        await storage.ready();
        context.app = await makeApp();
      },
      close: async () => {
        try {
          await context.app.close();
        } finally {
          await storage.end();
          await fixture.close();
        }
      },
    };
    const club = await context.app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: "Canonical history",
        city: "London",
        language: "en",
        ownerConsent: true,
        headerLogo: null,
        cardLogo: null,
      },
    });
    expect(club.statusCode, club.body).toBe(201);
    context.clubId = club.json().club.id as string;
    return context;
  } catch (error) {
    await fixture.close();
    throw error;
  }
};

const createRecord = async (context: Context, viaHttp = true) => {
  const headers = { "x-club-id": context.clubId };
  const ids: string[] = [];
  for (let index = 0; index < 11; index += 1) {
    const profile = await context.app.inject({
      method: "POST",
      url: "/api/players",
      headers,
      payload: { nickname: `Canonical ${randomUUID()}`, consent: false },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    ids.push(profile.json().player.id as string);
  }
  const host = ids[0]!;
  const players = ids.slice(1);
  const draft = generateRoleDeal(host, players).draftState;
  const creationId = randomUUID();
  const creation = { creationId, name: "Canonical draft", state: draft, results: null };
  let created: { gameId: string };
  if (viaHttp) {
    const response = await context.app.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers,
      payload: creation,
    });
    expect(response.statusCode, response.body).toBe(201);
    created = response.json() as { gameId: string };
  } else {
    created = await context.stores().games.create({ clubId: context.clubId, ...creation });
  }
  const url = `/api/game-sessions/${created.gameId}`;
  const read = await context.app.inject({ url, headers });
  expect(read.statusCode, read.body).toBe(200);
  expect(read.json().session.state).toEqual(draft);
  expect((await context.raw(created.gameId)).state).toEqual(draft);
  expect(draft.initialGame).toBeNull();
  expect(draft.events).toEqual([]);
  expect(draft.game).toBeNull();
  expect(draft.setup.step).toBe("roles");
  expect(draft.setup.setup.step).toBe("role-draw");
  expect(Object.keys(draft.setup.setup.assignments)).toHaveLength(1);
  // Gameplay starts only after the server-issued identity and completed deal.
  return {
    gameId: created.gameId,
    creationId,
    headers,
    url,
    history: createCanonicalHistory(created.gameId, host, players),
  };
};

const verifyCanonical = (actual: unknown, expected: CanonicalSnapshot, gameId: string) => {
  expect(actual).toEqual(expected);
  const state = actual as CanonicalSnapshot;
  expect(jsonHash(state.initialGame)).toBe(jsonHash(expected.initialGame));
  expect(jsonHash(state.events)).toBe(jsonHash(expected.events));
  expect(hashGameState(state.initialGame.game)).toBe(hashGameState(expected.initialGame.game));
  const replay = replayGameLog(state.initialGame, state.events, gameId);
  expect(replay.game).toEqual(state.game);
  expect(hashGameState(replay.game)).toBe(hashGameState(expected.game));
  expect(replay.frames.map(({ after }) => hashGameState(after))).toEqual(
    expected.events.map(({ stateHashAfter }) => stateHashAfter),
  );
  expect(state.headEventId).toBe(state.events.at(-1)?.id);
  expect(
    state.events.every(({ replayVersion }) => replayVersion === state.initialGame.replayVersion),
  ).toBe(true);
  // Negative control: the replay proof actually rejects a changed retained hash.
  const corrupt = state.events.map((entry, index) =>
    index === state.events.length - 1
      ? { ...entry, stateHashAfter: `sha256:${"0".repeat(64)}` }
      : entry,
  );
  expect(() => replayGameLog(state.initialGame, corrupt, gameId)).toThrow();
};

const saveAndRead = async (
  context: Context,
  gameId: string,
  state: CanonicalSnapshot,
  results: FinalGameResults | null = null,
  viaHttp = true,
) => {
  // Explicit JSON serialization before the write, never just in-memory equality.
  const accepted = jsonRoundTrip({ state, results });
  const operation = {
    clubId: context.clubId,
    gameId,
    mutationId: randomUUID(),
    name: "Accepted canonical history",
    ...accepted,
  };
  let acceptedRevision: number;
  if (viaHttp) {
    const response = await context.app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": context.clubId },
      payload: {
        mutationId: operation.mutationId,
        name: operation.name,
        state: accepted.state,
        results: accepted.results,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    verifyCanonical(response.json().state, accepted.state, gameId);
    expect(response.json().results).toEqual(accepted.results);
    acceptedRevision = response.json().revision as number;
  } else {
    const saved = await context.stores().games.save(operation);
    verifyCanonical(saved.state, accepted.state, gameId);
    expect(saved.results).toEqual(accepted.results);
    acceptedRevision = saved.revision;
  }
  // Existing saves are last-commit-wins, not mutation-id idempotent. Repeating
  // the accepted payload advances revision but must retain replay/result hashes
  // and replace (rather than double-count) projections.
  const retry = await context.stores().games.save(operation);
  expect(retry.duplicate).toBe(false);
  expect(retry.revision).toBe(acceptedRevision + 1);
  verifyCanonical(retry.state, accepted.state, gameId);
  expect(retry.results).toEqual(accepted.results);
  await readAndVerify(context, gameId, accepted.state, accepted.results);
};

const readAndVerify = async (
  context: Context,
  gameId: string,
  state: CanonicalSnapshot,
  results: FinalGameResults | null = null,
) => {
  const accepted = jsonRoundTrip({ state, results });
  const loaded = await context.stores().games.get(gameId, context.clubId);
  expect(loaded).not.toBeNull();
  verifyCanonical(loaded!.state, accepted.state, gameId);
  expect(loaded!.results).toEqual(accepted.results);
  const raw = await context.raw(gameId);
  verifyCanonical(raw.state, accepted.state, gameId);
  expect(raw.results).toEqual(accepted.results);
  expect(jsonHash(raw.results)).toBe(jsonHash(accepted.results));
  const read = await context.app.inject({
    url: `/api/game-sessions/${gameId}`,
    headers: { "x-club-id": context.clubId },
  });
  expect(read.statusCode, read.body).toBe(200);
  verifyCanonical(read.json().session.state, accepted.state, gameId);
  expect(read.json().session.results).toEqual(accepted.results);
  expect(read.json().session.status).toBe(results === null ? "active" : "completed");
  const active = await context.app.inject({
    url: "/api/game-sessions?status=active",
    headers: { "x-club-id": context.clubId },
  });
  expect(active.statusCode, active.body).toBe(200);
  if (results === null)
    expect(active.json().sessions).toContainEqual(
      expect.objectContaining({ gameId, phase: state.game.phase, day: state.game.day }),
    );
  else expect(active.json().sessions).not.toContainEqual(expect.objectContaining({ gameId }));
};

const verifyEventViews = async (context: Context, gameId: string, state: CanonicalSnapshot) => {
  const headers = { "x-club-id": context.clubId };
  const host = await context.app.inject({
    url: `/api/games/${gameId}/events?visibility=host`,
    headers,
  });
  const publicView = await context.app.inject({
    url: `/api/games/${gameId}/events?visibility=public`,
    headers,
  });
  expect(host.statusCode, host.body).toBe(200);
  expect(publicView.statusCode, publicView.body).toBe(200);
  const hostEvents = host.json().events as {
    id: string;
    payload: unknown;
    replayVersion: number;
    parentEventId: null;
    stateHashAfter: null;
  }[];
  const publicEvents = publicView.json().events as {
    id: string;
    payload: unknown;
    stateHashAfter: null;
  }[];
  expect(hostEvents).toHaveLength(state.events.length);
  expect(publicEvents).toHaveLength(state.events.length);
  expect(hostEvents.map(({ id }) => id)).toEqual(state.events.map(({ id }) => id));
  expect(hostEvents.map(({ payload }) => payload)).toEqual(
    state.events.map(({ payload }) => payload),
  );
  // /events remains a lossy transport projection, NOT canonical replay authority.
  expect(
    hostEvents.every(
      ({ replayVersion, parentEventId, stateHashAfter }) =>
        replayVersion === 1 && parentEventId === null && stateHashAfter === null,
    ),
  ).toBe(true);
  for (const [index, entry] of state.events.entries()) {
    expect(publicEvents[index]!.stateHashAfter).toBeNull();
    expect(publicEvents[index]!.payload).toEqual(
      isSecretGameEventType(entry.type) ? { redacted: true } : entry.payload,
    );
    if (entry.type === "nomination.selection-set") {
      // Explicit privacy oracle: do not merely trust the classification helper.
      expect(publicEvents[index]!.payload).toEqual({ redacted: true });
      expect(JSON.stringify(publicEvents[index])).not.toContain(entry.stateHashAfter);
    }
  }
};

const verifyViews = async (
  context: Context,
  gameId: string,
  state: CanonicalSnapshot,
  results: FinalGameResults,
) => {
  await verifyEventViews(context, gameId, state);
  const headers = { "x-club-id": context.clubId };
  const listing = await context.app.inject({
    url: "/api/game-sessions?status=completed",
    headers,
  });
  expect(listing.statusCode, listing.body).toBe(200);
  expect(listing.json().sessions).toContainEqual(
    expect.objectContaining({
      gameId,
      outcome: results.outcome,
      winner: results.winner,
      reason: results.reason,
      eventCount: state.events.length,
    }),
  );
  const projection = await context.projections(gameId);
  expect(projection).toMatchObject({
    outcome: results.outcome,
    winner: results.winner,
    reason: results.reason,
  });
  expect(projection.players).toHaveLength(10);
  for (const player of state.game.players)
    expect(projection.players).toContainEqual({
      playerId: player.id,
      status: player.status,
      won: results.winner === null ? null : player.team === results.winner,
      bestMoveHits:
        state.game.bestMove?.playerSeat === player.seat
          ? (state.game.bestMove.mafiaHits ?? null)
          : null,
    });
};

describe("Azure Table/Blob canonical-history persistence", () => {
  let context: Context;
  beforeAll(async () => {
    context = await openAzure();
  });
  afterAll(async () => {
    await context?.close();
  });

  it.each([false, true])(
    "round-trips multi-speaker selections through the browser outbox, lost HTTP reply and reopened stores (HTTP creation=%s)",
    async (viaHttp) => {
      const { history, gameId, headers, url } = await createRecord(context, viaHttp);
      history.append({
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 7 },
      });
      const oldNomination = history.snapshot();
      expect(oldNomination.game.nominations[0]).not.toHaveProperty("supporterSeats");
      await saveAndRead(context, gameId, oldNomination);
      history.append({ type: "turn.completed", payload: { seat: 1 } });
      const select = (nominatorSeat: number, candidateSeat: number, selected = true) =>
        history.append({
          type: "nomination.selection-set",
          payload: { nominatorSeat, candidateSeat, selected },
        });
      select(2, 7);
      select(2, 8);
      history.append({ type: "turn.completed", payload: { seat: 2 } });
      select(3, 7);
      select(3, 8);
      select(3, 9);
      history.append({
        type: "foul.issued",
        payload: { seat: 10, foulNumber: 1, redCarded: false },
      });
      const supported = history.snapshot();
      await saveAndRead(context, gameId, supported, null, false);
      select(3, 7, false);
      select(3, 9, false);
      history.append({
        type: "foul.issued",
        payload: { seat: 6, foulNumber: 1, redCarded: false },
      });
      const removed = history.snapshot();
      expect(removed.game.nominations).toEqual([
        { nominatorSeat: 1, candidateSeat: 7, order: 1, supporterSeats: [2] },
        { nominatorSeat: 2, candidateSeat: 8, order: 2, supporterSeats: [3] },
      ]);
      // The shared server-only fixture omits playlistId; the real browser
      // envelope requires it even when no playlist is selected.
      const browserRemoved = { ...removed, playlistId: "" };
      await saveAndRead(context, gameId, browserRemoved);
      select(3, 9);
      select(3, 7);
      const accepted = history.snapshot();
      expect(accepted.events.slice(0, supported.events.length)).toEqual(supported.events);
      expect(accepted.game.nominations).toEqual([
        {
          nominatorSeat: 1,
          candidateSeat: 7,
          order: 1,
          supporterSeats: [2, 3],
        },
        { nominatorSeat: 2, candidateSeat: 8, order: 2, supporterSeats: [3] },
        { nominatorSeat: 3, candidateSeat: 9, order: 3 },
      ]);
      expect(accepted.game.voteAssignments).toEqual({});
      expect(
        accepted.game.players.filter(({ fouls }) => fouls === 1).map(({ seat }) => seat),
      ).toEqual([6, 10]);
      const state = { ...accepted, playlistId: "" };
      type BrowserState = typeof state;
      type BrowserOperation = {
        kind: "snapshot";
        mutationId: string;
        name: string;
        state: BrowserState;
        results: null;
      };
      type BrowserOutbox = {
        activateRemote: (session: unknown) => void;
        enqueue: (name: string, state: BrowserState, results: null) => void;
        flush: () => Promise<void>;
        readonly current: { state: BrowserState } | null;
        readonly pendingCount: number;
      };
      const source = new URL("../../web/src/session-outbox.ts", import.meta.url).href;
      // eslint-disable-next-line no-unsanitized/method -- Fixed local production browser module; no custom transport implementation.
      const { GameSessionOutbox } = (await import(/* @vite-ignore */ source)) as {
        GameSessionOutbox: new (options: {
          storage: Storage;
          clubId: string;
          createId: () => string;
          save: (id: string, operation: BrowserOperation) => Promise<{ revision: number }>;
        }) => BrowserOutbox;
      };
      const storageSource = new URL("../../web/src/browser-game-storage.ts", import.meta.url).href;
      // eslint-disable-next-line no-unsanitized/method -- Fixed local production browser admission module.
      const { prepareBrowserGameStorage } = (await import(/* @vite-ignore */ storageSource)) as {
        prepareBrowserGameStorage: (options: { localStorage: Storage }) => Promise<unknown>;
      };
      const values = new Map<string, string>();
      const storage: Storage = {
        get length() {
          return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => void values.delete(key),
        setItem: (key, value) => void values.set(key, value),
      };
      const writes: BrowserOperation[] = [];
      const options = {
        storage,
        clubId: context.clubId,
        createId: randomUUID,
        save: async (id: string, operation: BrowserOperation) => {
          expect(id).toBe(gameId);
          writes.push(jsonRoundTrip(operation));
          const response = await context.app.inject({
            method: "PUT",
            url,
            headers,
            payload: operation,
          });
          expect(response.statusCode, response.body).toBe(200);
          await readAndVerify(context, gameId, state);
          if (writes.length === 1) throw new Error("Nomination reply lost after actual commit");
          return response.json() as { revision: number };
        },
      };
      const initialRead = await context.app.inject({ url, headers });
      expect(initialRead.statusCode, initialRead.body).toBe(200);
      const outbox = new GameSessionOutbox(options);
      outbox.activateRemote(initialRead.json().session);
      outbox.enqueue("Durable card selections", state, null);
      await expect(outbox.flush()).rejects.toThrow("Nomination reply lost after actual commit");
      expect(outbox.pendingCount).toBe(1);
      const raw = storage.getItem("mafia-dashboard.game-session.v5");
      await context.reopen();
      expect(await prepareBrowserGameStorage({ localStorage: storage })).toMatchObject({
        kind: "ready",
        attachment: {
          clubId: context.clubId,
          gameId,
          pendingCount: 1,
          unresolved: true,
        },
      });
      expect(storage.getItem("mafia-dashboard.game-session.v5")).toBe(raw);
      const restored = new GameSessionOutbox(options);
      const remote = await context.app.inject({ url, headers });
      expect(remote.statusCode, remote.body).toBe(200);
      restored.activateRemote(remote.json().session);
      expect(restored.current?.state).toEqual(state);
      await restored.flush();
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      expect(restored.pendingCount).toBe(0);
      const reloaded = new GameSessionOutbox(options);
      expect(reloaded.current?.state).toEqual(state);
      verifyCanonical(reloaded.current!.state, state, gameId);
      await readAndVerify(context, gameId, state);
      await verifyEventViews(context, gameId, state);
      const replay = replayGameLog(state.initialGame, state.events, gameId);
      expect(
        replay.frames.find(({ entry }) => entry.type === "player.nominated")!.after.nominations[0],
      ).not.toHaveProperty("supporterSeats");
      expect(replay.game.nominations[2]).not.toHaveProperty("supporterSeats");
      history.append({ type: "phase.changed", payload: { to: "voting" } });
      const ballot = { ...history.snapshot(), playlistId: "" };
      expect(ballot.game.nominations.map(({ candidateSeat }) => candidateSeat)).toEqual([7, 8, 9]);
      expect(ballot.game.voteAssignments).toEqual({});
      await saveAndRead(context, gameId, ballot);
      await context.reopen();
      await readAndVerify(context, gameId, ballot);
      await verifyEventViews(context, gameId, ballot);
    },
  );

  it.each([
    { losingTeam: "black", completion: "finished-early" },
    { losingTeam: "red", completion: "declined" },
  ] as const)(
    "replays $completion Best Move, disputed/ruled ballot and $losingTeam losing-team adjudication after actual save/reload",
    async ({ losingTeam, completion }) => {
      const record = await createRecord(context);
      const { history, gameId, creationId, headers, url } = record;
      await saveAndRead(context, gameId, history.snapshot());
      const stages = generateBestMoveAndBallot(history, completion);
      expect(stages.partialBestMove.game.bestMove?.selectedSeats).toEqual(
        completion === "declined" ? [] : [stages.victim, stages.blackSeat],
      );
      expect(stages.partialBestMove.game.bestMove).not.toHaveProperty("completionReason");
      expect(stages.finalizedBestMove.game.bestMove).toMatchObject({
        completionReason: completion,
        readbackAcknowledged: true,
        mafiaHits: completion === "declined" ? 0 : 1,
      });
      expect(stages.dispute.game.ballot?.dispute).toBeDefined();
      expect(stages.ruling.game.ballot).toMatchObject({
        reviewedCandidateSeats: [stages.dispute.game.ballot!.dispute!.candidateSeat],
        finalRuling: { externalReviewAcknowledged: true },
      });
      expect(stages.ruling.game.ballot?.dispute).toBeUndefined();
      for (const [index, state] of [
        stages.partialBestMove,
        stages.finalizedBestMove,
        stages.dispute,
        stages.ruling,
        stages.closedBallot,
      ].entries())
        await saveAndRead(context, gameId, state, null, index % 2 === 0);
      const beforeRuling = history.snapshot();
      const offenderSeat = history
        .current()
        .players.find(({ team, status }) => team === losingTeam && status === "active")!.seat;
      history.append({
        type: "game.adjudicated",
        payload: {
          losingTeam,
          offenderSeat,
          rule: "6.3.5",
          reason: "ППК — reasoned opponent victory, committee agreement recorded",
          committeeApproved: true,
        },
      });
      const pendingFinish = history.snapshot();
      expect(pendingFinish.game.players).toEqual(beforeRuling.game.players);
      await saveAndRead(context, gameId, pendingFinish);
      history.append({
        type: "game.completed",
        payload: { winner: losingTeam === "black" ? "red" : "black" },
      });
      const completed = history.snapshot();
      const results = await buildAcceptedResults(completed);
      expect(results).toMatchObject({
        outcome: completed.game.winner,
        winner: completed.game.winner,
        reason: null,
        adjudication: completed.game.adjudication,
      });
      await saveAndRead(context, gameId, completed, results, false);
      await context.reopen();
      await readAndVerify(context, gameId, completed, results);
      await verifyViews(context, gameId, completed, results);
      const retry = await context.app.inject({
        method: "POST",
        url: "/api/game-sessions",
        headers,
        payload: {
          creationId,
          name: "Stale draft creation retry",
          state: history.draftState,
          results: null,
        },
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({ gameId, duplicate: true });
      verifyCanonical(retry.json().state, completed, gameId);
      expect(retry.json().results).toEqual(results);
      verifyCanonical(
        (await context.app.inject({ url, headers })).json().session.state,
        completed,
        gameId,
      );
      expect(completed.initialGame.replayVersion).toBe(3);
      expect(completed.events.every(({ replayVersion }) => replayVersion === 3)).toBe(true);
    },
  );

  it("replays the automatic planning-plus-two-miss draw and real Finish result without a fabricated manual draw event", async () => {
    const { history, gameId } = await createRecord(context);
    const completed = generateAutomaticDraw(history);
    expect(completed.game).toMatchObject({
      phase: "draw",
      completedGameNights: 3,
      rulesDrawReason: { rule: "6.5.6", completedGameNights: 3, consecutiveUnchangedNights: 3 },
    });
    expect(completed.events.some(({ type }) => type === "game.drawn")).toBe(false);
    expect(completed.events.at(-1)).toMatchObject({
      type: "phase.changed",
      payload: { to: "draw" },
    });
    await saveAndRead(context, gameId, completed);
    const results = await buildAcceptedResults(completed);
    expect(results).toMatchObject({
      outcome: "draw",
      winner: null,
      reason: "MAFGAME 6.5.6: three consecutive game nights without a departure",
    });
    await saveAndRead(context, gameId, completed, results, false);
    await context.reopen();
    await readAndVerify(context, gameId, completed, results);
    await verifyViews(context, gameId, completed, results);
  });
});
