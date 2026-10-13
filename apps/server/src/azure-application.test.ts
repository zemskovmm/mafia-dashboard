import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { ApplicationStores } from "./storage-contracts.js";
import { StorageAccessError } from "./azure-storage.js";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@example.test",
  name: "Owner",
  picture: null,
};
const clubId = "00000000-0000-4000-8000-000000000101";

const storesFixture = () => {
  const runAuthorized = vi.fn(
    async (_userId: string, _clubId: string, _manager: boolean, work: () => Promise<unknown>) =>
      work(),
  );
  const getRole = vi.fn(async () => "manager" as const);
  const list = vi.fn(async () => []);
  const stores = {
    events: { read: vi.fn(async () => []) },
    games: {
      create: vi.fn(),
      save: vi.fn(),
      clear: vi.fn(),
      get: vi.fn(async () => null),
      listActive: vi.fn(async () => []),
      listCompleted: vi.fn(async () => []),
    },
    players: { list, get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    clubs: {
      listForUser: vi.fn(async () => []),
      getRole,
      isMember: vi.fn(),
      create: vi.fn(),
      claimClubAccess: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    ready: vi.fn(async () => undefined),
    runAuthorized,
  };
  return { stores: stores as unknown as ApplicationStores, runAuthorized, getRole, list };
};

describe("Azure application injection", () => {
  it("requires exactly one backend and reads readiness from the selected adapter", async () => {
    const { stores } = storesFixture();
    const app = await buildApp({ stores, authenticateRequest: async () => user });
    try {
      expect((await app.inject("/health/ready")).statusCode).toBe(200);
      expect(stores.ready).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
    await expect(buildApp({ stores, pool: {} as never })).rejects.toThrow(/exactly one|exclusive/i);
  });

  it("revalidates membership inside the protected read, not merely before it", async () => {
    const fixture = storesFixture();
    fixture.runAuthorized.mockRejectedValueOnce(new StorageAccessError());
    const app = await buildApp({ stores: fixture.stores, authenticateRequest: async () => user });
    try {
      const response = await app.inject({ url: "/api/players", headers: { "x-club-id": clubId } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "club_access_denied" });
      expect(fixture.getRole).toHaveBeenCalledWith(user.id, clubId);
      expect(fixture.runAuthorized).toHaveBeenCalledWith(
        user.id,
        clubId,
        false,
        expect.any(Function),
      );
      expect(fixture.list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("Azure provider configuration", () => {
  const base = {
    STORAGE_PROVIDER: "azure",
    AZURE_STORAGE_PARTITION_KEY: "mafia-test",
    AZURE_STORAGE_ACCOUNT_NAME: "mafialive01",
  };
  it("keeps PostgreSQL as the explicit transition default", () => {
    expect(loadConfig({}).STORAGE_PROVIDER).toBe("postgres");
    expect(loadConfig({}).azureStorage).toBeUndefined();
  });
  it("requires stable partition and an account or loopback fixture connection", () => {
    expect(() => loadConfig({ STORAGE_PROVIDER: "azure" })).toThrow();
    expect(loadConfig(base).azureStorage).toMatchObject({
      partitionKey: "mafia-test",
      accountName: "mafialive01",
      tableName: "MafiaEntities",
      containerName: "mafia-live",
    });
    expect(() => loadConfig({ ...base, AZURE_STORAGE_ACCOUNT_NAME: "invalid.name" })).toThrow();
    expect(() =>
      loadConfig({
        ...base,
        AZURE_STORAGE_CONNECTION_STRING:
          "DefaultEndpointsProtocol=https;AccountName=remote;AccountKey=secret;EndpointSuffix=core.windows.net",
      }),
    ).toThrow();
  });
  it("does not permit implicit initialization or ambiguous credentials", () => {
    expect(loadConfig(base).AZURE_STORAGE_INITIALIZE).toBe(false);
    expect(loadConfig({ ...base, AZURE_STORAGE_INITIALIZE: "true" }).AZURE_STORAGE_INITIALIZE).toBe(
      true,
    );
    expect(() => loadConfig({ ...base, AZURE_STORAGE_INITIALIZE: "yes" })).toThrow();
    expect(() =>
      loadConfig({ ...base, AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true" }),
    ).toThrow();
  });
});
