import { describe, expect, it, vi } from "vitest";
import type { GameSessionState } from "./api/client.js";
import {
  clearBrowserGameStorageForClub,
  discardBrowserGameStorage,
  discardInvalidBrowserGameStorage,
  prepareBrowserGameStorage,
  readBrowserGameAttachment,
  releaseBrowserGameStorage,
} from "./browser-game-storage.js";
import { gameSessionStorageKey, GameSessionOutbox } from "./session-outbox.js";

const clubId = "00000000-0000-4000-8000-000000000101";
const otherClubId = "00000000-0000-4000-8000-000000000102";
const gameId = "00000000-0000-4000-8000-000000000201";

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
};

const state = (playlistId = "PL-current"): GameSessionState => ({
  setup: {
    step: "players",
    hostPlayerId: "",
    selectedPlayerIds: Array.from({ length: 10 }, () => ""),
    setup: null,
  },
  game: null,
  hostPlayerId: null,
  hostName: null,
  playlistId,
  log: [{ kind: "setup" }],
  undoHistory: [],
  undoBudget: 0,
  initialGame: null,
  events: [],
  headEventId: null,
  resetReturnEventId: null,
  legacyLog: [{ kind: "activity" }],
});

const ids = (...values: string[]) => {
  const valuesToReturn = [...values];
  return () => valuesToReturn.shift() ?? "00000000-0000-4000-8000-000000000399";
};

const seed = (
  storage: Storage,
  {
    owner = clubId,
    id = gameId,
    pending = false,
  }: { owner?: string; id?: string; pending?: boolean } = {},
) => {
  const outbox = new GameSessionOutbox({
    storage,
    clubId: owner,
    createId: ids(id, "00000000-0000-4000-8000-000000000301"),
    create: vi.fn(),
    save: vi.fn().mockResolvedValue({ revision: 1, duplicate: false }),
  });
  outbox.activateRemote({
    gameId: id,
    name: "Table",
    status: "active",
    rulesetId: "classic",
    rulesetVersion: 1,
    revision: 4,
    duplicate: false,
    updatedAt: "2026-09-26T20:00:00.000Z",
    state: state(),
    results: null,
  });
  if (pending) outbox.enqueue("Table", state("PL-pending"), null);
  return outbox;
};

describe("browser current-v5 game storage", () => {
  it("returns empty when the single local current record is absent", async () => {
    const localStorage = memoryStorage();

    await expect(prepareBrowserGameStorage({ localStorage })).resolves.toEqual({ kind: "empty" });
  });

  it("returns the ready attachment from a valid local current record", async () => {
    const localStorage = memoryStorage();
    seed(localStorage);

    await expect(prepareBrowserGameStorage({ localStorage })).resolves.toEqual({
      kind: "ready",
      attachment: {
        clubId,
        gameId,
        name: "Table",
        revision: 4,
        pendingCount: 0,
        unresolved: false,
        storageSnapshot: localStorage.getItem(gameSessionStorageKey),
      },
    });
  });

  it("surfaces invalid storage without rewriting the exact raw bytes", async () => {
    const localStorage = memoryStorage();
    const raw = '{"version":5,"current":{}}';
    localStorage.setItem(gameSessionStorageKey, raw);

    await expect(prepareBrowserGameStorage({ localStorage })).resolves.toEqual({
      kind: "invalid",
      rawSnapshot: raw,
    });
    expect(localStorage.getItem(gameSessionStorageKey)).toBe(raw);
    expect(readBrowserGameAttachment(localStorage)).toBeNull();
  });

  it("does not consult a session-storage game key", async () => {
    const localStorage = memoryStorage();
    const sessionStorage = memoryStorage();
    sessionStorage.setItem(gameSessionStorageKey, "not-a-current-record");

    await expect(prepareBrowserGameStorage({ localStorage })).resolves.toEqual({ kind: "empty" });
    expect(sessionStorage.getItem(gameSessionStorageKey)).toBe("not-a-current-record");
  });

  it("releases only a synced attachment whose exact raw record is still current", async () => {
    const localStorage = memoryStorage();
    seed(localStorage);
    const attachment = readBrowserGameAttachment(localStorage)!;

    await expect(releaseBrowserGameStorage(localStorage, attachment)).resolves.toBe(true);
    expect(localStorage.getItem(gameSessionStorageKey)).toBeNull();
  });

  it("does not release unsynced work or a stale attachment", async () => {
    const localStorage = memoryStorage();
    const active = seed(localStorage, { pending: true });
    const pending = readBrowserGameAttachment(localStorage)!;

    await expect(releaseBrowserGameStorage(localStorage, pending)).resolves.toBe(false);
    expect(localStorage.getItem(gameSessionStorageKey)).toBe(pending.storageSnapshot);

    active.activateRemote({
      gameId: "00000000-0000-4000-8000-000000000202",
      revision: 5,
      name: "Replacement",
      state: state("PL-replacement"),
      results: null,
      status: "active",
      rulesetId: "classic",
      rulesetVersion: 1,
      duplicate: false,
      updatedAt: "2026-09-26T20:00:00.000Z",
    });
    await expect(releaseBrowserGameStorage(localStorage, pending)).resolves.toBe(false);
    expect(readBrowserGameAttachment(localStorage)?.gameId).toBe(
      "00000000-0000-4000-8000-000000000202",
    );
  });

  it("keeps valid missing-owner discard separate from invalid-record clearing", async () => {
    const localStorage = memoryStorage();
    seed(localStorage);
    const attachment = readBrowserGameAttachment(localStorage)!;

    await discardBrowserGameStorage({ localStorage }, attachment);
    expect(localStorage.getItem(gameSessionStorageKey)).toBeNull();

    const raw = '{"version":5,"current":{}}';
    localStorage.setItem(gameSessionStorageKey, raw);
    await expect(discardBrowserGameStorage({ localStorage }, attachment)).rejects.toThrow(
      "Browser game storage changed",
    );
    expect(localStorage.getItem(gameSessionStorageKey)).toBe(raw);
    await discardInvalidBrowserGameStorage({ localStorage }, raw);
    expect(localStorage.getItem(gameSessionStorageKey)).toBeNull();
  });

  it("allows explicit guarded discard of unresolved local work without weakening release", async () => {
    const localStorage = memoryStorage();
    seed(localStorage, { pending: true });
    const attachment = readBrowserGameAttachment(localStorage)!;

    await expect(releaseBrowserGameStorage(localStorage, attachment)).resolves.toBe(false);
    await expect(discardBrowserGameStorage({ localStorage }, attachment)).resolves.toBeUndefined();
    expect(localStorage.getItem(gameSessionStorageKey)).toBeNull();
  });

  it("uses raw-byte revalidation before clearing an invalid record", async () => {
    const localStorage = memoryStorage();
    const raw = '{"version":5,"current":{}}';
    localStorage.setItem(gameSessionStorageKey, raw);
    localStorage.setItem(gameSessionStorageKey, `${raw} `);

    await expect(discardInvalidBrowserGameStorage({ localStorage }, raw)).rejects.toThrow(
      "Browser game storage changed",
    );
    expect(localStorage.getItem(gameSessionStorageKey)).toBe(`${raw} `);
  });

  it("clears only the current local record for the deleted owner", async () => {
    const localStorage = memoryStorage();
    const sessionStorage = memoryStorage();
    seed(localStorage, { owner: otherClubId });
    sessionStorage.setItem(`${gameSessionStorageKey}.claim.${otherClubId}.tab`, "claim");

    await clearBrowserGameStorageForClub({ localStorage, clubId });
    expect(readBrowserGameAttachment(localStorage)?.clubId).toBe(otherClubId);
    expect(sessionStorage.getItem(`${gameSessionStorageKey}.claim.${otherClubId}.tab`)).toBe(
      "claim",
    );

    await clearBrowserGameStorageForClub({ localStorage, clubId: otherClubId });
    expect(localStorage.getItem(gameSessionStorageKey)).toBeNull();
    expect(sessionStorage.getItem(`${gameSessionStorageKey}.claim.${otherClubId}.tab`)).toBe(
      "claim",
    );
  });

  it.each([
    ["malformed JSON", "{"],
    ["a wrong version", '{"version":4}'],
    ["a missing current snapshot", '{"version":5}'],
    ["an invalid owner", '{"version":5,"clubId":"not-a-uuid"}'],
    ["an incomplete current state", '{"version":5,"current":{"name":"Table","state":{}}}'],
  ])("keeps %s byte-for-byte for explicit recovery", async (_label, raw) => {
    const localStorage = memoryStorage();
    localStorage.setItem(gameSessionStorageKey, raw);

    await expect(prepareBrowserGameStorage({ localStorage })).resolves.toEqual({
      kind: "invalid",
      rawSnapshot: raw,
    });
    expect(localStorage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it("marks queued current work unresolved without deriving a different owner", async () => {
    const localStorage = memoryStorage();
    seed(localStorage, { pending: true });

    await expect(prepareBrowserGameStorage({ localStorage })).resolves.toMatchObject({
      kind: "ready",
      attachment: { clubId, gameId, pendingCount: 1, unresolved: true },
    });
  });

  it("marks failed clear work unresolved so it cannot be released", async () => {
    const localStorage = memoryStorage();
    seed(localStorage);
    const persisted = JSON.parse(localStorage.getItem(gameSessionStorageKey)!);
    persisted.clearFailed = true;
    localStorage.setItem(gameSessionStorageKey, JSON.stringify(persisted));
    const attachment = readBrowserGameAttachment(localStorage)!;

    expect(attachment.unresolved).toBe(true);
    await expect(releaseBrowserGameStorage(localStorage, attachment)).resolves.toBe(false);
    expect(localStorage.getItem(gameSessionStorageKey)).not.toBeNull();
  });

  it("does not release an attachment when a concurrent tab changes only raw formatting", async () => {
    const localStorage = memoryStorage();
    seed(localStorage);
    const attachment = readBrowserGameAttachment(localStorage)!;
    localStorage.setItem(gameSessionStorageKey, `${attachment.storageSnapshot} `);

    await expect(releaseBrowserGameStorage(localStorage, attachment)).resolves.toBe(false);
    expect(localStorage.getItem(gameSessionStorageKey)).toBe(`${attachment.storageSnapshot} `);
  });

  it("does not let invalid-record clearing remove a valid current owner", async () => {
    const localStorage = memoryStorage();
    seed(localStorage);
    const raw = localStorage.getItem(gameSessionStorageKey)!;

    await expect(discardInvalidBrowserGameStorage({ localStorage }, raw)).rejects.toThrow(
      "Browser game storage changed",
    );
    expect(localStorage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it("does not clear an invalid record while deleting a club", async () => {
    const localStorage = memoryStorage();
    const raw = '{"version":5,"current":{}}';
    localStorage.setItem(gameSessionStorageKey, raw);

    await clearBrowserGameStorageForClub({ localStorage, clubId });
    expect(localStorage.getItem(gameSessionStorageKey)).toBe(raw);
  });

  it("surfaces a local removal failure instead of reporting a safe release", async () => {
    const localStorage = memoryStorage();
    seed(localStorage);
    const attachment = readBrowserGameAttachment(localStorage)!;
    localStorage.removeItem = vi.fn(() => {
      throw new Error("remove failed");
    });

    await expect(releaseBrowserGameStorage(localStorage, attachment)).rejects.toThrow(
      "remove failed",
    );
    expect(localStorage.getItem(gameSessionStorageKey)).not.toBeNull();
  });
});
