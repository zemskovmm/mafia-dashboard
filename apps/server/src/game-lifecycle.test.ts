import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { lockAggregateProjectionTables, lockClubGame } from "./game-lifecycle.js";

describe("game record persistence locks", () => {
  it("serializes a club record and projection writes without an active-game or claim lock", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) } as unknown as PoolClient;

    await lockClubGame(client, "club", "game");
    await lockAggregateProjectionTables(client);

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
      ["club", "game"],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      "LOCK TABLE game_results, game_player_results, game_events IN ROW EXCLUSIVE MODE",
    );
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      "LOCK TABLE game_session_players IN ROW EXCLUSIVE MODE",
    );
  });
});
