export type MusicStage = "day" | "voting" | "night";

export interface MusicPreferencesV1 {
  readonly version: 1;
  readonly lastPlaylistId: string;
  readonly queueOrderByPlaylist: Readonly<Record<string, readonly string[]>>;
  readonly stagePlaylistIds: Readonly<Partial<Record<MusicStage, string>>>;
}

const STORAGE_KEY_PREFIX = "mafia-dashboard.music-preferences.v1";
const MAX_QUEUE_ENTRY_KEYS = 500;

export const musicPreferencesStorageKey = (clubId: string): string =>
  `${STORAGE_KEY_PREFIX}.${clubId}`;

const emptyMusicPreferences = (): MusicPreferencesV1 => ({
  version: 1,
  lastPlaylistId: "",
  queueOrderByPlaylist: {},
  stagePlaylistIds: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sanitizeMusicPreferences = (value: Record<string, unknown>): MusicPreferencesV1 => {
  const queueOrderByPlaylist = isRecord(value.queueOrderByPlaylist)
    ? Object.fromEntries(
        Object.entries(value.queueOrderByPlaylist).flatMap(([playlistId, order]) =>
          Array.isArray(order)
            ? [
                [
                  playlistId,
                  order
                    .filter((entryKey): entryKey is string => typeof entryKey === "string")
                    .slice(0, MAX_QUEUE_ENTRY_KEYS),
                ],
              ]
            : [],
        ),
      )
    : {};
  const rawStagePlaylistIds = isRecord(value.stagePlaylistIds) ? value.stagePlaylistIds : {};
  const stagePlaylistIds = Object.fromEntries(
    (["day", "voting", "night"] as const).flatMap((stage) =>
      typeof rawStagePlaylistIds[stage] === "string" ? [[stage, rawStagePlaylistIds[stage]]] : [],
    ),
  );

  return {
    version: 1,
    lastPlaylistId: typeof value.lastPlaylistId === "string" ? value.lastPlaylistId : "",
    queueOrderByPlaylist,
    stagePlaylistIds,
  };
};

export const readMusicPreferences = (storage: Storage, clubId: string): MusicPreferencesV1 => {
  try {
    const raw = storage.getItem(musicPreferencesStorageKey(clubId));
    if (raw === null) return emptyMusicPreferences();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return emptyMusicPreferences();
    return sanitizeMusicPreferences(parsed);
  } catch {
    return emptyMusicPreferences();
  }
};

export interface QueueEntryIdentity {
  readonly videoId: string;
  readonly position: number;
}

export const queueEntryKey = ({ videoId, position }: QueueEntryIdentity): string =>
  `${videoId}:${position}`;

const queueEntryVideoId = (entryKey: string): string | null => {
  const separatorIndex = entryKey.lastIndexOf(":");
  if (separatorIndex <= 0 || !/^\d+$/.test(entryKey.slice(separatorIndex + 1))) return null;
  return entryKey.slice(0, separatorIndex);
};

export const restoreQueueOrder = <Entry extends QueueEntryIdentity>(
  savedOrder: readonly string[],
  remoteEntries: readonly Entry[],
): readonly Entry[] => {
  const seenSavedKeys = new Set<string>();
  const uniqueSavedOrder = savedOrder.filter((entryKey) => {
    if (seenSavedKeys.has(entryKey)) return false;
    seenSavedKeys.add(entryKey);
    return true;
  });
  const usedRemoteIndexes = new Set<number>();
  const matchedRemoteIndexes = uniqueSavedOrder.map((entryKey) => {
    const exactIndex = remoteEntries.findIndex(
      (entry, index) => !usedRemoteIndexes.has(index) && queueEntryKey(entry) === entryKey,
    );
    if (exactIndex < 0) return null;
    usedRemoteIndexes.add(exactIndex);
    return exactIndex;
  });

  uniqueSavedOrder.forEach((entryKey, savedIndex) => {
    if (matchedRemoteIndexes[savedIndex] !== null) return;
    const videoId = queueEntryVideoId(entryKey);
    if (videoId === null) return;
    const fallbackIndex = remoteEntries.findIndex(
      (entry, index) => !usedRemoteIndexes.has(index) && entry.videoId === videoId,
    );
    if (fallbackIndex < 0) return;
    usedRemoteIndexes.add(fallbackIndex);
    matchedRemoteIndexes[savedIndex] = fallbackIndex;
  });

  const savedEntries = matchedRemoteIndexes.flatMap((remoteIndex) =>
    remoteIndex === null ? [] : [remoteEntries[remoteIndex]!],
  );
  const newEntries = remoteEntries.filter((_entry, index) => !usedRemoteIndexes.has(index));
  return [...savedEntries, ...newEntries];
};

export const writeMusicPreferences = (
  storage: Storage,
  clubId: string,
  preferences: MusicPreferencesV1,
): void => {
  try {
    const sanitized = sanitizeMusicPreferences(preferences as unknown as Record<string, unknown>);
    storage.setItem(musicPreferencesStorageKey(clubId), JSON.stringify(sanitized));
  } catch {
    // Preferences are best-effort browser-local state.
  }
};
