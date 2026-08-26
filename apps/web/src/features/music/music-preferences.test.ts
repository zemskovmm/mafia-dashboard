import { describe, expect, it } from "vitest";
import {
  musicPreferencesStorageKey,
  queueEntryKey,
  readMusicPreferences,
  restoreQueueOrder,
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
      queueOrderByPlaylist: {},
      stagePlaylistIds: {},
    });
  });

  it("reads a version-one preference envelope", () => {
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
      queueOrderByPlaylist: { "playlist-last": ["video-b:1", "video-a:0"] },
      stagePlaylistIds: { day: "playlist-day", night: "playlist-night" },
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
      queueOrderByPlaylist: {},
      stagePlaylistIds: {},
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
      queueOrderByPlaylist: {},
      stagePlaylistIds: {},
    });
  });

  it("ignores malformed values and arbitrary persisted fields", () => {
    window.localStorage.setItem(
      musicPreferencesStorageKey("hostile-club"),
      JSON.stringify({
        version: 1,
        lastPlaylistId: 42,
        queueOrderByPlaylist: {
          usable: ["video-a:0", { playerId: "secret" }, "video-b:1"],
          malformed: "not-an-array",
        },
        stagePlaylistIds: {
          day: "playlist-day",
          voting: false,
          setup: "playlist-setup",
          secret: "do-not-keep",
        },
        players: [{ id: "player-secret" }],
        game: { id: "game-secret" },
        accessToken: "token-secret",
      }),
    );

    expect(readMusicPreferences(window.localStorage, "hostile-club")).toEqual({
      version: 1,
      lastPlaylistId: "",
      queueOrderByPlaylist: { usable: ["video-a:0", "video-b:1"] },
      stagePlaylistIds: { day: "playlist-day" },
    });
  });

  it("caps each remembered playlist order at 500 entry keys", () => {
    const entryKeys = Array.from({ length: 501 }, (_, index) => `video-${index}:${index}`);
    window.localStorage.setItem(
      musicPreferencesStorageKey("large-club"),
      JSON.stringify({
        version: 1,
        lastPlaylistId: "large-playlist",
        queueOrderByPlaylist: { "large-playlist": entryKeys },
        stagePlaylistIds: {},
      }),
    );

    const result = readMusicPreferences(window.localStorage, "large-club");
    expect(result.queueOrderByPlaylist["large-playlist"]).toEqual(entryKeys.slice(0, 500));
  });

  it("round-trips a club's bounded preference shape", () => {
    const preferences = {
      version: 1,
      lastPlaylistId: "playlist-live",
      queueOrderByPlaylist: {
        "playlist-live": ["video-z:2", "video-a:0"],
      },
      stagePlaylistIds: {
        day: "playlist-day",
        voting: "playlist-vote",
        night: "playlist-night",
      },
    } as const;

    writeMusicPreferences(window.localStorage, "round-trip-club", preferences);

    expect(readMusicPreferences(window.localStorage, "round-trip-club")).toEqual(preferences);
  });

  it("writes only the bounded V1 preference shape", () => {
    const entryKeys = Array.from({ length: 501 }, (_, index) => `video-${index}:${index}`);
    const runtimeInput = {
      version: 1,
      lastPlaylistId: "playlist-live",
      queueOrderByPlaylist: {
        "playlist-live": [...entryKeys, { secret: true }],
        malformed: "not-an-array",
      },
      stagePlaylistIds: { day: "playlist-day", setup: "playlist-setup" },
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
      queueOrderByPlaylist: { "playlist-live": entryKeys.slice(0, 500) },
      stagePlaylistIds: { day: "playlist-day" },
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
        queueOrderByPlaylist: {},
        stagePlaylistIds: {},
      }),
    ).not.toThrow();
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
