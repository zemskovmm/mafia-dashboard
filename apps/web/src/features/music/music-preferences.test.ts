import { describe, expect, it } from "vitest";
import {
  musicPreferencesStorageKey,
  openingQueue,
  queueEntryKey,
  readMusicPreferences,
  restoreQueueOrder,
  selectRememberedPlaylist,
  shuffledQueue,
  shuffledQueueWithPreferred,
  writeMusicPreferences,
} from "./music-preferences.js";

describe("music preferences", () => {
  it("scopes the storage key to the club", () => {
    expect(musicPreferencesStorageKey("club-a")).toBe(
      "mafia-dashboard.music-preferences.v1.club-a",
    );
    expect(musicPreferencesStorageKey("club-b")).toBe(
      "mafia-dashboard.music-preferences.v1.club-b",
    );
  });

  it("returns defaults when the club has no saved preferences", () => {
    expect(readMusicPreferences(window.localStorage, "empty-club")).toEqual({
      version: 1,
      lastPlaylistId: "",
      queueOrder: [],
      initialStageEntryKeys: [],
      endgameEntryKeys: [],
    });
  });

  it("migrates the selected playlist order from the former version-one envelope", () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey("saved-club"),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "playlist-last",
        queueOrderByPlaylist: { "playlist-last": ["video-b:1", "video-a:0"] },
        stagePlaylistIds: { day: "playlist-day", night: "playlist-night" },
      }),
    );

    expect(readMusicPreferences(window.localStorage, "saved-club")).toEqual({
      version: 1,
      lastPlaylistId: "playlist-last",
      queueOrder: ["video-b:1", "video-a:0"],
      initialStageEntryKeys: [],
      endgameEntryKeys: [],
    });
  });

  it("recovers one deterministic legacy stage playlist when none was selected", () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey("stage-only-club"),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "",
        queueOrderByPlaylist: { "playlist-day": ["day:0"] },
        stagePlaylistIds: {
          voting: "playlist-voting",
          night: "playlist-night",
          day: "playlist-day",
        },
      }),
    );

    expect(readMusicPreferences(window.localStorage, "stage-only-club")).toEqual({
      version: 1,
      lastPlaylistId: "playlist-day",
      queueOrder: ["day:0"],
      initialStageEntryKeys: [],
      endgameEntryKeys: [],
    });
  });

  it.each([
    ["corrupt JSON", "{"],
    ["an unknown version", JSON.stringify({ version: 2, lastPlaylistId: "wrong" })],
    ["a non-object payload", JSON.stringify([1, 2, 3])],
  ])("returns defaults for %s", (_case, raw) => {
    window.localStorage.setItem(musicPreferencesStorageKey("invalid-club"), raw);

    expect(readMusicPreferences(window.localStorage, "invalid-club")).toEqual({
      version: 1,
      lastPlaylistId: "",
      queueOrder: [],
      initialStageEntryKeys: [],
      endgameEntryKeys: [],
    });
  });

  it("returns defaults when browser storage cannot be read", () => {
    const unavailableStorage = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    } as unknown as Storage;

    expect(readMusicPreferences(unavailableStorage, "blocked-club")).toEqual({
      version: 1,
      lastPlaylistId: "",
      queueOrder: [],
      initialStageEntryKeys: [],
      endgameEntryKeys: [],
    });
  });

  it("ignores malformed values and arbitrary persisted fields", () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey("hostile-club"),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "playlist-live",
        queueOrder: ["video-a:0", { playerId: "secret" }, "video-a:0", "video-b:1"],
        initialStageEntryKeys: ["video-a:0", false, "video-a:0"],
        endgameEntryKeys: ["video-b:1", { secret: true }, "video-b:1"],
        players: [{ id: "player-secret" }],
        game: { id: "game-secret" },
        accessToken: "token-secret",
      }),
    );

    expect(readMusicPreferences(window.localStorage, "hostile-club")).toEqual({
      version: 1,
      lastPlaylistId: "playlist-live",
      queueOrder: ["video-a:0", "video-b:1"],
      initialStageEntryKeys: ["video-a:0"],
      endgameEntryKeys: ["video-b:1"],
    });
  });

  it("repairs overlapping classifications with Endgame taking precedence", () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey("overlap-club"),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "playlist-live",
        queueOrder: [],
        initialStageEntryKeys: ["shared:0", "initial-only:1"],
        endgameEntryKeys: ["shared:0", "endgame-only:2"],
      }),
    );

    expect(readMusicPreferences(window.localStorage, "overlap-club")).toMatchObject({
      initialStageEntryKeys: ["initial-only:1"],
      endgameEntryKeys: ["shared:0", "endgame-only:2"],
    });
  });

  it("caps each remembered queue and tag set at 500 unique entry keys", () => {
    const entryKeys = Array.from({ length: 501 }, (_, index) => `video-${index}:${index}`);
    const endgameEntryKeys = Array.from({ length: 501 }, (_, index) => `endgame-${index}:${index}`);
    window.localStorage.setItem(
      musicPreferencesStorageKey("large-club"),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "large-playlist",
        queueOrder: [...entryKeys, entryKeys[0]],
        initialStageEntryKeys: [...entryKeys, entryKeys[0]],
        endgameEntryKeys: [...endgameEntryKeys, endgameEntryKeys[0]],
      }),
    );

    const result = readMusicPreferences(window.localStorage, "large-club");
    expect(result.queueOrder).toEqual(entryKeys.slice(0, 500));
    expect(result.initialStageEntryKeys).toEqual(entryKeys.slice(0, 500));
    expect(result.endgameEntryKeys).toEqual(endgameEntryKeys.slice(0, 500));
  });

  it("round-trips a club's bounded preference shape", () => {
    const preferences = {
      version: 1,
      lastPlaylistId: "playlist-live",
      queueOrder: ["video-z:2", "video-a:0"],
      initialStageEntryKeys: ["video-a:0"],
      endgameEntryKeys: ["video-z:2"],
    } as const;

    writeMusicPreferences(window.localStorage, "round-trip-club", preferences);

    expect(readMusicPreferences(window.localStorage, "round-trip-club")).toEqual(preferences);
  });

  it("writes only the bounded V1 preference shape", () => {
    const entryKeys = Array.from({ length: 501 }, (_, index) => `video-${index}:${index}`);
    const endgameEntryKeys = Array.from({ length: 501 }, (_, index) => `endgame-${index}:${index}`);
    const runtimeInput = {
      version: 1,
      lastPlaylistId: "playlist-live",
      queueOrder: [...entryKeys, { secret: true }],
      initialStageEntryKeys: [...entryKeys, { secret: true }],
      endgameEntryKeys: [...endgameEntryKeys, { secret: true }],
      game: { id: "game-secret" },
      accessToken: "token-secret",
    };

    writeMusicPreferences(
      window.localStorage,
      "write-sanitized-club",
      runtimeInput as unknown as Parameters<typeof writeMusicPreferences>[2],
    );

    expect(
      JSON.parse(
        window.localStorage.getItem(musicPreferencesStorageKey("write-sanitized-club")) ?? "null",
      ),
    ).toEqual({
      version: 1,
      lastPlaylistId: "playlist-live",
      queueOrder: entryKeys.slice(0, 500),
      initialStageEntryKeys: entryKeys.slice(0, 500),
      endgameEntryKeys: endgameEntryKeys.slice(0, 500),
    });
  });

  it("does not throw when browser storage cannot be written", () => {
    const unavailableStorage = {
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    } as unknown as Storage;

    expect(() =>
      writeMusicPreferences(unavailableStorage, "blocked-club", {
        version: 1,
        lastPlaylistId: "playlist-live",
        queueOrder: [],
        initialStageEntryKeys: [],
        endgameEntryKeys: [],
      }),
    ).not.toThrow();
  });

  it("resets queue metadata whenever the one remembered playlist changes", () => {
    const current = {
      version: 1,
      lastPlaylistId: "playlist-a",
      queueOrder: ["video-a:0"],
      initialStageEntryKeys: ["video-a:0"],
      endgameEntryKeys: ["video-b:1"],
    } as const;

    expect(selectRememberedPlaylist(current, "playlist-b")).toEqual({
      version: 1,
      lastPlaylistId: "playlist-b",
      queueOrder: [],
      initialStageEntryKeys: [],
      endgameEntryKeys: [],
    });
    expect(selectRememberedPlaylist(current, "playlist-a")).toBe(current);
  });

  it("shuffles a copied queue deterministically without mutating its source", () => {
    const source = ["a", "b", "c"] as const;

    expect(shuffledQueue(source, () => 0)).toEqual(["b", "c", "a"]);
    expect(source).toEqual(["a", "b", "c"]);
    expect(shuffledQueue([], () => 0)).toEqual([]);
    expect(shuffledQueue(["only"], () => 0)).toEqual(["only"]);
  });

  it("randomizes preferred entries into a front partition", () => {
    const source = ["ordinary-a", "endgame-a", "ordinary-b", "endgame-b"] as const;

    expect(
      shuffledQueueWithPreferred(
        source,
        (entry) => entry.startsWith("endgame"),
        () => 0,
      ),
    ).toEqual(["endgame-b", "endgame-a", "ordinary-b", "ordinary-a"]);
    expect(
      shuffledQueueWithPreferred(
        source,
        () => false,
        () => 0,
      ),
    ).toEqual(["endgame-a", "ordinary-b", "endgame-b", "ordinary-a"]);
  });

  it("builds a constrained opening queue with Initial current, untagged next, and Initial tail", () => {
    const source = ["initial-a", "ordinary-a", "endgame", "initial-b", "ordinary-b"] as const;

    expect(
      openingQueue(
        source,
        (entry) => entry.startsWith("initial"),
        (entry) => entry === "endgame",
        () => 0,
      ),
    ).toEqual(["initial-b", "ordinary-b", "endgame", "ordinary-a", "initial-a"]);
    expect(source).toEqual(["initial-a", "ordinary-a", "endgame", "initial-b", "ordinary-b"]);
  });

  it("cannot build an opening queue without both Initial and untagged entries", () => {
    expect(
      openingQueue(
        ["ordinary"],
        () => false,
        () => false,
        () => 0,
      ),
    ).toBeNull();
    expect(
      openingQueue(
        ["initial", "endgame"],
        (entry) => entry === "initial",
        (entry) => entry === "endgame",
        () => 0,
      ),
    ).toBeNull();
  });

  it("identifies queue entries by video ID and source position", () => {
    expect(queueEntryKey({ videoId: "abc", position: 4 })).toBe("abc:4");
    expect(queueEntryKey({ videoId: "abc", position: 9 })).toBe("abc:9");
  });

  it("restores saved entries before appending new remote entries in provider order", () => {
    const remote = [
      { videoId: "a", position: 0, title: "A" },
      { videoId: "b", position: 1, title: "B" },
      { videoId: "c", position: 2, title: "C" },
      { videoId: "d", position: 3, title: "D" },
    ] as const;

    expect(restoreQueueOrder(["c:2", "a:0"], remote)).toEqual([
      remote[2],
      remote[0],
      remote[1],
      remote[3],
    ]);
  });

  it("drops saved entries that no longer exist remotely", () => {
    const remote = [
      { videoId: "a", position: 0 },
      { videoId: "b", position: 1 },
    ] as const;

    expect(restoreQueueOrder(["deleted:9", "b:1"], remote)).toEqual([remote[1], remote[0]]);
  });

  it("uses duplicate saved entry keys only once", () => {
    const remote = [
      { videoId: "a", position: 0 },
      { videoId: "b", position: 1 },
    ] as const;

    expect(restoreQueueOrder(["b:1", "b:1", "a:0"], remote)).toEqual([remote[1], remote[0]]);
  });

  it("reserves exact duplicate matches before using shifted same-video fallbacks", () => {
    const remote = [
      { videoId: "new", position: 0, title: "New remote entry" },
      { videoId: "other", position: 1, title: "Other" },
      { videoId: "duplicate", position: 2, title: "Exact duplicate copy" },
      { videoId: "duplicate", position: 3, title: "Shifted duplicate copy" },
    ] as const;

    expect(restoreQueueOrder(["duplicate:0", "other:1", "duplicate:2"], remote)).toEqual([
      remote[3],
      remote[1],
      remote[2],
      remote[0],
    ]);
  });

  it("preserves duplicate videos at different source positions", () => {
    const remote = [
      { videoId: "duplicate", position: 2, title: "Second copy" },
      { videoId: "other", position: 1, title: "Other" },
      { videoId: "duplicate", position: 0, title: "First copy" },
    ] as const;

    expect(restoreQueueOrder(["duplicate:0", "duplicate:2"], remote)).toEqual([
      remote[2],
      remote[0],
      remote[1],
    ]);
  });
});
