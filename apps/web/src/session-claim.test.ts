import { describe, expect, it, vi } from "vitest";

import {
  GameSessionClaimController,
  gameSessionClaimStoragePrefix,
  gameSessionClaimTabStorageKey,
} from "./session-claim.js";

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

describe("GameSessionClaimController", () => {
  it("keeps opaque claim ids stable per club and game across reloads", async () => {
    const storage = memoryStorage();
    const coordinationStorage = memoryStorage();
    const ids = [
      "00000000-0000-4000-8000-000000000201",
      "00000000-0000-4000-8000-000000000202",
      "00000000-0000-4000-8000-000000000203",
      "00000000-0000-4000-8000-000000000204",
    ];
    const first = new GameSessionClaimController({
      storage,
      coordinationStorage,
      clubId: "club-a",
      createId: () => ids.shift()!,
    });
    await first.ready();

    expect(first.credential("game-a", 0).claimId).toBe("00000000-0000-4000-8000-000000000203");
    expect(first.credential("game-a", 0).claimId).toBe("00000000-0000-4000-8000-000000000203");
    expect(first.credential("game-b", 0).claimId).toBe("00000000-0000-4000-8000-000000000204");
    first.markOwned("game-a", 3);
    first.dispose();

    const reloaded = new GameSessionClaimController({
      storage,
      coordinationStorage,
      clubId: "club-a",
      createId: vi.fn(() => "00000000-0000-4000-8000-000000000205"),
    });
    await reloaded.ready();
    expect(reloaded.credential("game-a", 0)).toEqual({
      claimId: "00000000-0000-4000-8000-000000000203",
      claimGeneration: 3,
    });
    reloaded.dispose();
  });

  it("permits generation zero only for a new first write and blocks until ownership returns", async () => {
    const storage = memoryStorage();
    const controller = new GameSessionClaimController({
      storage,
      coordinationStorage: memoryStorage(),
      clubId: "club-a",
      createId: () => "00000000-0000-4000-8000-000000000203",
    });
    await controller.ready();

    expect(controller.canWrite("game-a", 0, 0)).toBe(true);
    expect(controller.canWrite("game-a", 1, 0)).toBe(false);
    controller.markOwned("game-a", 1);
    expect(controller.canWrite("game-a", 1, 1)).toBe(true);
    controller.markOffline("game-a");
    expect(controller.canWrite("game-a", 1, 1)).toBe(false);
    expect(controller.credential("game-a", 1).claimId).toBe("00000000-0000-4000-8000-000000000203");
    controller.markBlocked("game-a");
    expect(controller.canWrite("game-a", 1, 1)).toBe(false);
    controller.markOwned("game-a", 2);
    expect(controller.canWrite("game-a", 1, 2)).toBe(true);

    controller.clear("game-a");
    expect(storage.getItem(`${gameSessionClaimStoragePrefix("club-a")}.game-a`)).toBeNull();
    controller.dispose();
  });

  it("owns the fifteen-second renewal timer and stops it when displaced", () => {
    vi.useFakeTimers();
    try {
      const controller = new GameSessionClaimController({
        storage: memoryStorage(),
        clubId: "club-a",
        createId: () => "00000000-0000-4000-8000-000000000204",
      });
      const renew = vi.fn();

      controller.startRenewal("game-a", renew);
      expect(renew).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(14_999);
      expect(renew).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(renew).toHaveBeenCalledTimes(2);

      controller.markBlocked("game-a");
      vi.advanceTimersByTime(15_000);
      expect(renew).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates cloned session credentials before a duplicated tab can write", async () => {
    const storage = memoryStorage();
    const prefix = gameSessionClaimStoragePrefix("club-a");
    storage.setItem(
      gameSessionClaimTabStorageKey("club-a"),
      "00000000-0000-4000-8000-000000000205",
    );
    storage.setItem(`${prefix}.game-a`, "00000000-0000-4000-8000-000000000206");
    const lockRequest = vi
      .fn()
      .mockImplementationOnce(async (_name, _options, callback) => callback(null))
      .mockImplementationOnce(async (name, _options, callback) => callback({ name }));
    const createId = vi
      .fn()
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000207")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000208");
    const controller = new GameSessionClaimController({
      storage,
      clubId: "club-a",
      createId,
      lockRequest,
    });

    expect(controller.canWrite("game-a", 1, 1)).toBe(false);
    await controller.ready();
    expect(controller.credential("game-a", 0).claimId).toBe("00000000-0000-4000-8000-000000000208");
    expect(lockRequest).toHaveBeenCalledTimes(2);

    controller.dispose();
  });

  it("rotates cloned credentials with the local-storage fallback", async () => {
    const clubId = "00000000-0000-4000-8000-000000000051";
    const gameId = "00000000-0000-4000-8000-000000000052";
    const tabId = "00000000-0000-4000-8000-000000000053";
    const claimId = "00000000-0000-4000-8000-000000000054";
    const coordinationStorage = memoryStorage();
    const originalStorage = memoryStorage();
    originalStorage.setItem(gameSessionClaimTabStorageKey(clubId), tabId);
    originalStorage.setItem(`${gameSessionClaimStoragePrefix(clubId)}.${gameId}`, claimId);
    const original = new GameSessionClaimController({
      storage: originalStorage,
      coordinationStorage,
      clubId,
      createId: () => "00000000-0000-4000-8000-000000000055",
    });
    await original.ready();

    const duplicateStorage = memoryStorage();
    duplicateStorage.setItem(gameSessionClaimTabStorageKey(clubId), tabId);
    duplicateStorage.setItem(`${gameSessionClaimStoragePrefix(clubId)}.${gameId}`, claimId);
    const ids = [
      "00000000-0000-4000-8000-000000000056",
      "00000000-0000-4000-8000-000000000057",
      "00000000-0000-4000-8000-000000000058",
    ];
    const duplicate = new GameSessionClaimController({
      storage: duplicateStorage,
      coordinationStorage,
      clubId,
      createId: () => ids.shift()!,
    });
    await duplicate.ready();

    expect(original.credential(gameId, 1).claimId).toBe(claimId);
    expect(duplicate.credential(gameId, 1).claimId).toBe("00000000-0000-4000-8000-000000000058");
    expect(duplicateStorage.getItem(gameSessionClaimTabStorageKey(clubId))).toBe(
      "00000000-0000-4000-8000-000000000056",
    );

    duplicate.dispose();
    original.dispose();
  });

  it("fails closed by rotating inherited credentials when coordination is unavailable", async () => {
    const storage = memoryStorage();
    storage.setItem(
      gameSessionClaimTabStorageKey("club-a"),
      "00000000-0000-4000-8000-000000000061",
    );
    storage.setItem(
      `${gameSessionClaimStoragePrefix("club-a")}.game-a`,
      "00000000-0000-4000-8000-000000000062",
    );
    const ids = ["00000000-0000-4000-8000-000000000063", "00000000-0000-4000-8000-000000000064"];
    const controller = new GameSessionClaimController({
      storage,
      clubId: "club-a",
      createId: () => ids.shift()!,
    });

    await controller.ready();

    expect(controller.credential("game-a", 1).claimId).toBe("00000000-0000-4000-8000-000000000064");
    controller.dispose();
  });
});
