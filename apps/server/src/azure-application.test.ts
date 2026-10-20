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
  const runAuthorized = vi
    .fn<
      (
        userId: string,
        clubId: string,
        manager: boolean,
        work: () => Promise<unknown>,
      ) => Promise<void>
    >()
    .mockResolvedValue(undefined);
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
      readStatisticsInputs: vi.fn(async () => ({ players: [], games: [], tournaments: [] })),
    },
    tournaments: { list: vi.fn(async () => []), create: vi.fn(), assign: vi.fn() },
    players: {
      getRoleIcons: vi.fn(),
      list,
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    clubs: {
      listForUser: vi.fn(async () => []),
      getRole,
      create: vi.fn(),
      claimClubAccess: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    ready: vi.fn(async () => undefined),
    async runAuthorized<T>(
      userId: string,
      clubId: string,
      manager: boolean,
      work: () => Promise<T>,
    ) {
      await runAuthorized(userId, clubId, manager, work);
      return work();
    },
  } satisfies ApplicationStores;
  return { stores, runAuthorized, getRole, list };
};

describe("Azure application injection", () => {
  it("reads readiness from the injected Azure application stores", async () => {
    const { stores } = storesFixture();
    const app = await buildApp({ stores, authenticateRequest: async () => user });
    try {
      expect((await app.inject("/health/ready")).statusCode).toBe(200);
      expect(stores.ready).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("fails readiness closed without exposing storage errors or failing liveness", async () => {
    const { stores } = storesFixture();
    stores.ready.mockRejectedValueOnce(new Error("private-storage-detail"));
    const app = await buildApp({ stores });
    try {
      const response = await app.inject("/health/ready");
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not-ready" });
      expect((await app.inject("/health/live")).json()).toEqual({ status: "live" });
      expect(stores.ready).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
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
  it("defaults only to Azure and refuses PostgreSQL even with valid Azure configuration", () => {
    const implicitAzure = {
      AZURE_STORAGE_PARTITION_KEY: base.AZURE_STORAGE_PARTITION_KEY,
      AZURE_STORAGE_ACCOUNT_NAME: base.AZURE_STORAGE_ACCOUNT_NAME,
    };
    expect(loadConfig(implicitAzure).STORAGE_PROVIDER).toBe("azure");
    expect(loadConfig(implicitAzure).azureStorage).toEqual(loadConfig(base).azureStorage);
    expect(() => loadConfig({ ...base, STORAGE_PROVIDER: "postgres" })).toThrow(/azure/i);
    expect(loadConfig(base)).not.toHaveProperty("DATABASE_URL");
    expect(loadConfig(base)).not.toHaveProperty("databaseUrl");
  });
  it("requires stable partition and an account or loopback fixture connection", () => {
    expect(() => loadConfig({})).toThrow(/Azure storage/i);
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
