import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { ApplicationStores } from "./storage-contracts.js";

describe("buildApp startup", () => {
  it("does not initialize or access persistence during application construction", async () => {
    const unexpectedAccess = vi.fn(async () => {
      throw new Error("unexpected persistence access during startup");
    });
    const stores: ApplicationStores = {
      events: { read: unexpectedAccess },
      games: {
        create: unexpectedAccess,
        save: unexpectedAccess,
        clear: unexpectedAccess,
        get: unexpectedAccess,
        listActive: unexpectedAccess,
        listCompleted: unexpectedAccess,
        readStatisticsInputs: unexpectedAccess,
      },
      tournaments: { list: unexpectedAccess, create: unexpectedAccess, assign: unexpectedAccess },
      players: {
        list: unexpectedAccess,
        get: unexpectedAccess,
        create: unexpectedAccess,
        update: unexpectedAccess,
        delete: unexpectedAccess,
      },
      clubs: {
        listForUser: unexpectedAccess,
        getRole: unexpectedAccess,
        isMember: unexpectedAccess,
        create: unexpectedAccess,
        claimClubAccess: unexpectedAccess,
        update: unexpectedAccess,
        delete: unexpectedAccess,
      },
      ready: unexpectedAccess,
    };

    const app = await buildApp({ stores, authenticateRequest: async () => null });
    await app.ready();
    await app.close();

    expect(unexpectedAccess).not.toHaveBeenCalled();
  });
});
