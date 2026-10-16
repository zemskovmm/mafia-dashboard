import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresStores, type ApplicationStores } from "./storage-contracts.js";
import { createAzureStores } from "./azure-stores.js";
import { AzureGameSessionStore } from "./azure-game-session-store.js";
import { AzureTournamentStore } from "./azure-tournament-store.js";
import { AzurePlayerStore } from "./azure-club-player-store.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { initializeSchema } from "./initialize-schema.js";
import { federationRecord } from "./test-helpers/federation-record.js";
import { gameSessionCreationSchema, gameSessionMutationSchema } from "./game-session-validation.js";

for (const provider of ["postgres", "azure"] as const) {
  describe(`${provider} club tournaments and coherent statistics source`, () => {
    let stores: ApplicationStores;
    let close: () => Promise<void>;
    let pool: Pool;
    let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
    const clubId = DEFAULT_CLUB_ID;
    const otherClub = randomUUID();
    const owner = "00000000-0000-4000-8000-000000000001";
    beforeAll(async () => {
      if (provider === "postgres") {
        const url =
          process.env.TEST_DATABASE_URL ?? "postgresql://mafia@127.0.0.1:54329/mafia_test";
        const admin = new Pool({ connectionString: url });
        const schema = `tournament_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE SCHEMA ${schema}`);
        pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
        await initializeSchema(pool);
        stores = createPostgresStores(pool);
        await pool.query(
          "INSERT INTO clubs (id,name,city,created_by) VALUES ($1,'Other','Other',$2)",
          [otherClub, owner],
        );
        close = async () => {
          await pool.end();
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          await admin.end();
        };
      } else {
        fixture = await createStorageFixture();
        stores = {
          ...createAzureStores(fixture.options).stores,
          games: new AzureGameSessionStore(fixture.storage),
          tournaments: new AzureTournamentStore(fixture.storage),
          players: new AzurePlayerStore(fixture.storage),
        };
        await fixture.storage.mutate(async (tx) => {
          for (const id of [clubId, otherClub])
            await tx.set(`club:${id}:meta`, { id, name: "Club" });
        });
        close = fixture.close;
      }
    });
    afterAll(async () => close?.());
    const seed = async (ids: readonly string[]) => {
      if (provider === "postgres") {
        for (const id of ids)
          await pool.query(
            "INSERT INTO players (id,club_id,nickname) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
            [id, clubId, id],
          );
      } else
        await fixture.storage.mutate(async (tx) => {
          for (const id of ids)
            await tx.set(`club:${clubId}:player:${id}`, { id, nickname: id, retiredAt: null });
        });
    };
    it("atomically creates with an association, preserves metadata across retries/saves and refuses cross-club/deleted assignments", async () => {
      const [first, duplicate] = await Promise.all([
        stores.tournaments.create("  Autumn CUP  ", clubId),
        stores.tournaments.create("autumn cup", clubId),
      ]);
      expect(duplicate.id).toBe(first.id);
      const other = await stores.tournaments.create("Autumn Cup", otherClub);
      expect(other.id).not.toBe(first.id);
      const second = await stores.tournaments.create("Second", clubId);
      for (const name of ["  ", "x".repeat(101)])
        await expect(stores.tournaments.create(name, clubId)).rejects.toMatchObject({
          code: "invalid_tournament_name",
        });
      const input = {
        clubId,
        creationId: randomUUID(),
        name: "Tournament game",
        state: { kept: { raw: true } },
        results: null,
        tournamentId: first.id,
      };
      await expect(stores.games.create({ ...input, tournamentId: other.id })).rejects.toMatchObject(
        { code: "tournament_not_found" },
      );
      const created = await stores.games.create(input);
      expect(created.tournamentId).toBe(first.id);
      expect(
        (await stores.games.listActive(clubId)).find((x) => x.gameId === created.gameId)
          ?.tournamentId,
      ).toBe(first.id);
      await expect(
        stores.tournaments.assign(created.gameId, other.id, clubId),
      ).rejects.toMatchObject({ code: "tournament_not_found" });
      await expect(
        stores.tournaments.assign(created.gameId, first.id, otherClub),
      ).rejects.toMatchObject({ code: "game_session_not_found" });
      await stores.tournaments.assign(created.gameId, second.id, clubId);
      const metadataOnly = await stores.games.get(created.gameId, clubId);
      expect(metadataOnly).toEqual({ ...created, tournamentId: second.id });
      expect((await stores.games.create(input)).tournamentId).toBe(second.id);
      const saved = await stores.games.save({
        clubId,
        gameId: created.gameId,
        name: input.name,
        mutationId: randomUUID(),
        state: { changed: true },
        results: null,
      });
      expect(saved.tournamentId).toBe(second.id);
      expect((await stores.games.get(created.gameId, clubId))?.state).toEqual({ changed: true });
      await stores.tournaments.assign(created.gameId, null, clubId);
      expect((await stores.games.create(input)).tournamentId).toBeNull();
      await stores.games.clear({ clubId, gameId: created.gameId });
      await expect(
        stores.tournaments.assign(created.gameId, first.id, clubId),
      ).rejects.toMatchObject({ code: "game_session_not_found" });
      await expect(stores.games.create(input)).rejects.toMatchObject({ code: "game_deleted" });
      if (provider === "postgres")
        expect(
          (await pool.query("SELECT * FROM game_tournaments WHERE game_id=$1", [created.gameId]))
            .rows,
        ).toEqual([]);
      else
        expect(
          await fixture.storage.getEntity(`club:${clubId}:game-tournament:${created.gameId}`),
        ).toBeUndefined();
    });
    it("uses authoritative final results, retains retired participants, withholds live secrets and reports incomplete supported results", async () => {
      const record = federationRecord("black");
      await seed([record.hostPlayerId, ...record.players.map((x) => x.id)]);
      const event = await stores.tournaments.create("Results", clubId);
      const created = await stores.games.create({
        clubId,
        creationId: randomUUID(),
        name: "Authoritative",
        state: record.state,
        results: null,
        tournamentId: event.id,
      });
      const live = (await stores.games.readStatisticsInputs(clubId)).games.find(
        (x) => x.gameId === created.gameId,
      )!;
      expect(live).toMatchObject({
        status: "active",
        participants: null,
        outcome: null,
        playedAt: null,
        tournamentId: event.id,
      });
      expect(JSON.stringify(live)).not.toMatch(/ballot|adjudication|stateHash|mafiaHits|"role"/);
      await stores.games.save({
        clubId,
        gameId: created.gameId,
        name: "Authoritative",
        mutationId: randomUUID(),
        state: record.completedState,
        results: record.results,
      });
      // Older derived projections are optional, never authority for statistics.
      if (provider === "postgres")
        await pool.query("DELETE FROM game_results WHERE game_id=$1", [created.gameId]);
      else
        await fixture.storage.mutate(async (tx) => {
          for (const r of await tx.list(`club:${clubId}:result:${created.gameId}:`))
            await tx.delete(r.rowKey);
        });
      expect(await stores.players.delete(record.players[0]!.id, clubId)).toBe("deleted");
      const source = await stores.games.readStatisticsInputs(clubId);
      expect(source.players.some((x) => x.id === record.players[0]!.id)).toBe(false);
      expect(source.players.every((x) => Object.keys(x).sort().join(",") === "id,nickname")).toBe(
        true,
      );
      const result = source.games.find((x) => x.gameId === created.gameId)!;
      expect(result).toMatchObject({
        rulesEdition: "mafgame-2026-07-01",
        hasCasper: false,
        outcome: record.winner,
        adjudication: record.results.adjudication,
        tournamentId: event.id,
        participants: record.results.players,
      });
      expect(
        (await stores.games.listCompleted(clubId)).find((x) => x.gameId === created.gameId)
          ?.tournamentId,
      ).toBe(event.id);
      expect((await stores.games.get(created.gameId, clubId))?.state).toEqual(
        record.completedState,
      );
      const incomplete = await stores.games.create({
        clubId,
        creationId: randomUUID(),
        name: "Incomplete",
        state: {},
        results: { ...record.results, players: undefined },
      });
      expect(
        (await stores.games.readStatisticsInputs(clubId)).games.find(
          (x) => x.gameId === incomplete.gameId,
        ),
      ).toMatchObject({ status: "completed", outcome: record.winner, participants: null });
    });
    it("reads games, assignments and profiles within one provider boundary when a writer interleaves", async () => {
      const a = await stores.tournaments.create("Read before", clubId);
      const b = await stores.tournaments.create("Read after", clubId);
      const created = await stores.games.create({
        clubId,
        creationId: randomUUID(),
        name: "Before",
        state: {},
        results: null,
        tournamentId: a.id,
      });
      let changed = false;
      if (provider === "postgres") {
        const connect = pool.connect.bind(pool);
        const spy = vi.spyOn(pool, "connect").mockImplementation(async () => {
          const client = await connect();
          const query = client.query.bind(client);
          const original = client.query;
          client.query = (async (...args: unknown[]) => {
            const result = await (query as (...args: unknown[]) => Promise<unknown>)(...args);
            if (!changed && String(args[0]).includes("SELECT id, nickname FROM players")) {
              changed = true;
              await stores.tournaments.assign(created.gameId, b.id, clubId);
              await stores.games.save({
                clubId,
                gameId: created.gameId,
                name: "After",
                mutationId: randomUUID(),
                state: {},
                results: null,
              });
            }
            return result;
          }) as typeof client.query;
          const release = client.release.bind(client);
          client.release = (...args) => {
            client.query = original;
            client.release = release;
            return release(...args);
          };
          return client;
        });
        try {
          const result = (await stores.games.readStatisticsInputs(clubId)).games.find(
            (x) => x.gameId === created.gameId,
          )!;
          expect(result).toMatchObject({ name: "Before", tournamentId: a.id });
        } finally {
          spy.mockRestore();
        }
      } else {
        const competing = createAzureStores(fixture.options);
        const original = fixture.storage.getEntity.bind(fixture.storage);
        const spy = vi.spyOn(fixture.storage, "getEntity").mockImplementation(async (key) => {
          const row = await original(key);
          if (!changed && key === `club:${clubId}:game-tournament:${created.gameId}`) {
            changed = true;
            await competing.stores.tournaments.assign(created.gameId, b.id, clubId);
            await competing.stores.games.save({
              clubId,
              gameId: created.gameId,
              name: "After",
              mutationId: randomUUID(),
              state: {},
              results: null,
            });
          }
          return row;
        });
        try {
          const result = (await stores.games.readStatisticsInputs(clubId)).games.find(
            (x) => x.gameId === created.gameId,
          )!;
          expect(result).toMatchObject({ name: "After", tournamentId: b.id });
        } finally {
          spy.mockRestore();
          await competing.end();
        }
      }
      expect(changed).toBe(true);
    });
    it("refuses unsupported statistics source instead of guessing legacy data", async () => {
      const input = {
        creationId: randomUUID(),
        clubId,
        name: "Future source",
        state: { game: { rulesEdition: "future-edition" } },
        results: null,
      };
      const created = await stores.games.create(input);
      try {
        await expect(stores.games.readStatisticsInputs(clubId)).rejects.toThrow(
          "Unsupported statistics source",
        );
      } finally {
        await stores.games.clear({ gameId: created.gameId, clubId });
      }
    });
    it("removes club tournament/name/assignment rows and cannot resurrect them", async () => {
      if (provider === "azure")
        await fixture.storage.mutate((tx) =>
          tx.set(`user:${owner}`, {
            id: owner,
            name: "Owner Example",
            email: "owner@example.test",
          }),
        );
      const child = await stores.clubs.create(owner, {
        name: "Delete tournament club",
        city: "Test",
        language: "en",
        ownerConsent: true,
        headerLogo: null,
        cardLogo: null,
      });
      const event = await stores.tournaments.create("Deleted event", child.id);
      const input = {
        clubId: child.id,
        creationId: randomUUID(),
        name: "Club game",
        state: {},
        results: null,
        tournamentId: event.id,
      };
      const created = await stores.games.create(input);
      expect(await stores.clubs.delete(owner, child.id)).toBe(true);
      expect(await stores.tournaments.list(child.id)).toEqual([]);
      expect(await stores.games.readStatisticsInputs(child.id)).toEqual({
        players: [],
        games: [],
        tournaments: [],
      });
      await expect(
        stores.tournaments.assign(created.gameId, event.id, child.id),
      ).rejects.toMatchObject({ code: "game_session_not_found" });
      await expect(stores.games.create(input)).rejects.toThrow();
      if (provider === "azure")
        expect(await fixture.storage.read((tx) => tx.list(`club:${child.id}:`))).toEqual([]);
      else
        expect(
          (await pool.query("SELECT * FROM game_tournaments WHERE club_id=$1", [child.id])).rows,
        ).toEqual([]);
    });
  });
}

it("admits optional initial tournament metadata only on the creation envelope", () => {
  const input = {
    creationId: randomUUID(),
    name: "Initial",
    state: {},
    results: null,
    tournamentId: randomUUID(),
  };
  expect(gameSessionCreationSchema.safeParse(input).success).toBe(true);
  expect(gameSessionCreationSchema.safeParse({ ...input, tournamentId: null }).success).toBe(true);
  expect(gameSessionCreationSchema.safeParse({ ...input, tournamentId: "invalid" }).success).toBe(
    false,
  );
  expect(
    gameSessionMutationSchema.safeParse({
      ...input,
      creationId: undefined,
      mutationId: randomUUID(),
    }).success,
  ).toBe(false);
});
