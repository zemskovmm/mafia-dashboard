import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PlayerStore } from "./player-store.js";

const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test",
});
const store = new PlayerStore(pool);

beforeAll(async () => {
  await store.initialize();
});

afterAll(async () => {
  await pool.end();
});

const nickname = (base: string) => `${base}-${randomUUID().slice(0, 8)}`;

describe("PlayerStore", () => {
  it("stores consent-safe profiles and rejects case-insensitive duplicate nicknames", async () => {
    const aliceNickname = nickname("Alice");
    const alice = await store.create({
      nickname: aliceNickname,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    expect(alice).toMatchObject({
      nickname: aliceNickname,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });

    const bob = await store.create({
      nickname: nickname("Bob"),
      consent: true,
      firstName: "Bob",
      lastName: "Player",
      email: "bob@example.test",
    });
    expect(bob).toMatchObject({
      consent: true,
      firstName: "Bob",
      lastName: "Player",
      email: "bob@example.test",
    });

    await expect(
      store.create({
        nickname: aliceNickname.toUpperCase(),
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("orders profiles by latest play time and then nickname", async () => {
    const never = await store.create({
      nickname: nickname("Zulu"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const older = await store.create({
      nickname: nickname("Alpha"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const newer = await store.create({
      nickname: nickname("Beta"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });

    await store.saveGameResults({
      gameId: randomUUID(),
      winner: "red",
      playedAt: new Date("2026-08-16T20:00:00.000Z"),
      players: [
        {
          playerId: older.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 1,
        },
      ],
    });
    await store.saveGameResults({
      gameId: randomUUID(),
      winner: "black",
      playedAt: new Date("2026-08-17T20:00:00.000Z"),
      players: [
        {
          playerId: newer.id,
          seat: 2,
          role: "mafia",
          team: "black",
          status: "active",
          fouls: 0,
        },
      ],
    });

    const orderedIds = (await store.list()).map(({ id }) => id);
    expect(orderedIds.indexOf(newer.id)).toBeLessThan(orderedIds.indexOf(older.id));
    expect(orderedIds.indexOf(older.id)).toBeLessThan(orderedIds.indexOf(never.id));
  });

  it("saves final results idempotently and aggregates player statistics", async () => {
    const player = await store.create({
      nickname: nickname("Stats"),
      consent: true,
      firstName: "Stat",
      lastName: "Player",
      email: "stats@example.test",
    });
    const gameId = randomUUID();
    const result = {
      gameId,
      winner: "red" as const,
      playedAt: new Date("2026-08-17T21:00:00.000Z"),
      players: [
        {
          playerId: player.id,
          seat: 4,
          role: "sheriff" as const,
          team: "red" as const,
          status: "eliminated" as const,
          fouls: 2,
        },
      ],
    };

    await store.saveGameResults(result);
    await store.saveGameResults(result);

    const saved = (await store.list()).find(({ id }) => id === player.id);
    expect(saved?.statistics).toMatchObject({
      gamesPlayed: 1,
      wins: 1,
      losses: 0,
      redGames: 1,
      redWins: 1,
      blackGames: 0,
      blackWins: 0,
      sheriffGames: 1,
      citizenGames: 0,
      mafiaGames: 0,
      donGames: 0,
      totalFouls: 2,
      eliminations: 1,
      redCards: 0,
    });
    expect(saved?.lastPlayedAt?.toISOString()).toBe("2026-08-17T21:00:00.000Z");
  });

  it("recalculates last-played ordering when a finalized roster is corrected", async () => {
    const original = await store.create({
      nickname: nickname("Original"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const replacement = await store.create({
      nickname: nickname("Replacement"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    const common = {
      gameId,
      winner: "red" as const,
      playedAt: new Date("2026-08-17T23:00:00.000Z"),
    };
    await store.saveGameResults({
      ...common,
      players: [
        {
          playerId: original.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
      ],
    });
    await store.saveGameResults({
      ...common,
      players: [
        {
          playerId: replacement.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
      ],
    });

    const profiles = await store.list();
    expect(profiles.find(({ id }) => id === original.id)?.lastPlayedAt).toBeNull();
    expect(profiles.find(({ id }) => id === replacement.id)?.lastPlayedAt?.toISOString()).toBe(
      "2026-08-17T23:00:00.000Z",
    );
  });
});
