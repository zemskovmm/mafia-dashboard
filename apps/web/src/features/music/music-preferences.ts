export interface MusicPreferencesV1 {
  readonly version: 1;
  readonly lastPlaylistId: string;
  readonly queueOrder: readonly string[];
  readonly initialStageEntryKeys: readonly string[];
  readonly endgameEntryKeys: readonly string[];
}

const STORAGE_KEY_PREFIX = "mafia-dashboard.music-preferences.v1";
const MAX_QUEUE_ENTRY_KEYS = 500;

export const musicPreferencesStorageKey = (clubId: string): string =>
  `${STORAGE_KEY_PREFIX}.${clubId}`;

const emptyMusicPreferences = (): MusicPreferencesV1 => ({
  version: 1,
  lastPlaylistId: "",
  queueOrder: [],
  initialStageEntryKeys: [],
  endgameEntryKeys: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const boundedStrings = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string") unique.add(entry);
    if (unique.size === MAX_QUEUE_ENTRY_KEYS) break;
  }
  return [...unique];
};

const sanitizeMusicPreferences = (value: Record<string, unknown>): MusicPreferencesV1 => {
  const lastPlaylistId =
    typeof value.lastPlaylistId === "string" && value.lastPlaylistId ? value.lastPlaylistId : "";
  const queueOrder = boundedStrings(value.queueOrder);
  const endgameEntryKeys = boundedStrings(value.endgameEntryKeys);
  const endgameEntries = new Set(endgameEntryKeys);

  return {
    version: 1,
    lastPlaylistId,
    queueOrder,
    initialStageEntryKeys: boundedStrings(value.initialStageEntryKeys).filter(
      (entryKey) => !endgameEntries.has(entryKey),
    ),
    endgameEntryKeys,
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

export const selectRememberedPlaylist = (
  current: MusicPreferencesV1,
  lastPlaylistId: string,
): MusicPreferencesV1 =>
  current.lastPlaylistId === lastPlaylistId
    ? current
    : {
        version: 1,
        lastPlaylistId,
        queueOrder: [],
        initialStageEntryKeys: [],
        endgameEntryKeys: [],
      };

const queueEntryVideoId = (entryKey: string): string | null => {
  const separatorIndex = entryKey.lastIndexOf(":");
  if (separatorIndex <= 0 || !/^\d+$/.test(entryKey.slice(separatorIndex + 1))) return null;
  return entryKey.slice(0, separatorIndex);
};

export const shuffledQueue = <Entry>(
  entries: readonly Entry[],
  random: () => number = Math.random,
): readonly Entry[] => {
  const result = [...entries];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const candidate = Math.floor(random() * (index + 1));
    const target = Number.isFinite(candidate) ? Math.max(0, Math.min(index, candidate)) : 0;
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
};

export const openingQueue = <Entry>(
  entries: readonly Entry[],
  isInitial: (entry: Entry) => boolean,
  isEndgame: (entry: Entry) => boolean,
  random: () => number = Math.random,
): readonly Entry[] | null => {
  const initial = shuffledQueue(entries.filter(isInitial), random);
  const untagged = shuffledQueue(
    entries.filter((entry) => !isInitial(entry) && !isEndgame(entry)),
    random,
  );
  const current = initial[0];
  const next = untagged[0];
  if (current === undefined || next === undefined) return null;
  const middle = shuffledQueue(
    [...untagged.slice(1), ...entries.filter((entry) => !isInitial(entry) && isEndgame(entry))],
    random,
  );
  return [current, next, ...middle, ...initial.slice(1)];
};

export const shuffledQueueWithPreferred = <Entry>(
  entries: readonly Entry[],
  preferred: (entry: Entry) => boolean,
  random: () => number = Math.random,
): readonly Entry[] => {
  const preferredEntries = entries.filter(preferred);
  if (preferredEntries.length === 0) return shuffledQueue(entries, random);
  return [
    ...shuffledQueue(preferredEntries, random),
    ...shuffledQueue(
      entries.filter((entry) => !preferred(entry)),
      random,
    ),
  ];
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
