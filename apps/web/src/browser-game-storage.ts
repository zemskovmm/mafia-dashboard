import { gameSessionStorageKey, parseCurrentGameSessionEnvelope } from "./session-outbox.js";
import {
  assertBrowserGameStorageGuard,
  type BrowserGameStorageGuard,
  withBrowserGameStorageTransaction,
} from "./browser-game-storage-lock.js";

export interface BrowserGameAttachment {
  readonly clubId: string;
  readonly gameId: string | null;
  readonly creationId?: string;
  readonly name: string;
  readonly revision: number;
  readonly pendingCount: number;
  readonly unresolved: boolean;
  readonly storageSnapshot: string;
}

export type BrowserGameStorageState =
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly attachment: BrowserGameAttachment }
  | { readonly kind: "invalid"; readonly rawSnapshot: string };

export interface BrowserGameStorageOptions {
  readonly localStorage: Storage;
}

const attachmentFromRaw = (raw: string): BrowserGameAttachment | null => {
  const envelope = parseCurrentGameSessionEnvelope(raw);
  if (
    envelope === null ||
    ((envelope.historicalTournaments?.length ?? 0) === 0 &&
      ((envelope.gameId === null && envelope.creationId === null) || envelope.current === null))
  )
    return null;
  return {
    clubId: envelope.clubId,
    gameId: envelope.gameId,
    ...(envelope.gameId === null && envelope.creationId !== null
      ? { creationId: envelope.creationId }
      : {}),
    name: envelope.current?.name ?? "",
    revision: envelope.revision,
    pendingCount:
      envelope.outbox.length +
      (envelope.historicalTournaments?.length ?? 0) +
      (envelope.creationId === null ? 0 : 1) +
      (envelope.tournamentAssociation?.pending == null ? 0 : 1),
    unresolved:
      envelope.creationId !== null ||
      (envelope.historicalTournaments?.length ?? 0) > 0 ||
      envelope.tournamentAssociation?.pending != null ||
      envelope.outbox.length > 0 ||
      envelope.failed ||
      envelope.clearFailed ||
      envelope.clearingGameId !== null,
    storageSnapshot: raw,
  };
};

const stateFromRaw = (raw: string | null): BrowserGameStorageState => {
  if (raw === null) return { kind: "empty" };
  const attachment = attachmentFromRaw(raw);
  return attachment === null
    ? { kind: "invalid", rawSnapshot: raw }
    : { kind: "ready", attachment };
};

export const readBrowserGameStorageState = (storage: Storage): BrowserGameStorageState =>
  stateFromRaw(storage.getItem(gameSessionStorageKey));

const assertExactSnapshot = (storage: Storage, expected: string) => {
  if (storage.getItem(gameSessionStorageKey) !== expected) {
    throw new Error("Browser game storage changed in another browser context");
  }
};

const removeCurrentRecord = (storage: Storage, expected: string) => {
  assertExactSnapshot(storage, expected);
  storage.removeItem(gameSessionStorageKey);
  if (storage.getItem(gameSessionStorageKey) !== null) {
    throw new Error("Browser game storage clear could not be verified");
  }
};

export const readBrowserGameAttachment = (storage: Storage): BrowserGameAttachment | null => {
  const state = readBrowserGameStorageState(storage);
  return state.kind === "ready" ? state.attachment : null;
};

export const prepareBrowserGameStorage = async (
  options: BrowserGameStorageOptions,
  lockOptions: { readonly ifAvailable?: boolean } = {},
): Promise<BrowserGameStorageState> =>
  withBrowserGameStorageTransaction(
    options.localStorage,
    () => stateFromRaw(options.localStorage.getItem(gameSessionStorageKey)),
    lockOptions,
  );

export const releaseBrowserGameStorage = async (
  storage: Storage,
  attachment: BrowserGameAttachment,
): Promise<boolean> =>
  withBrowserGameStorageTransaction(storage, () => {
    const raw = storage.getItem(gameSessionStorageKey);
    if (raw !== attachment.storageSnapshot) return false;
    const current = attachmentFromRaw(attachment.storageSnapshot);
    if (
      current === null ||
      current.clubId !== attachment.clubId ||
      current.gameId !== attachment.gameId ||
      current.unresolved ||
      current.creationId !== attachment.creationId
    ) {
      return false;
    }
    removeCurrentRecord(storage, attachment.storageSnapshot);
    return true;
  });

export const discardBrowserGameStorage = async (
  options: BrowserGameStorageOptions,
  attachment: BrowserGameAttachment,
): Promise<void> =>
  withBrowserGameStorageTransaction(options.localStorage, () => {
    const raw = options.localStorage.getItem(gameSessionStorageKey);
    const current = raw === null ? null : attachmentFromRaw(raw);
    if (
      current === null ||
      current.storageSnapshot !== attachment.storageSnapshot ||
      current.clubId !== attachment.clubId ||
      current.gameId !== attachment.gameId ||
      current.creationId !== attachment.creationId
    ) {
      throw new Error("Browser game storage changed in another browser context");
    }
    removeCurrentRecord(options.localStorage, attachment.storageSnapshot);
  });

export const discardInvalidBrowserGameStorage = async (
  options: BrowserGameStorageOptions,
  rawSnapshot: string,
): Promise<void> =>
  withBrowserGameStorageTransaction(options.localStorage, () => {
    const raw = options.localStorage.getItem(gameSessionStorageKey);
    if (raw !== rawSnapshot || attachmentFromRaw(rawSnapshot) !== null) {
      throw new Error("Browser game storage changed in another browser context");
    }
    removeCurrentRecord(options.localStorage, rawSnapshot);
  });

export const clearBrowserGameStorage = async (storage: Storage): Promise<void> =>
  withBrowserGameStorageTransaction(storage, () => {
    storage.removeItem(gameSessionStorageKey);
    if (storage.getItem(gameSessionStorageKey) !== null) {
      throw new Error("Browser game storage clear could not be verified");
    }
  });

export const clearBrowserGameStorageForClub = async (options: {
  readonly localStorage: Storage;
  readonly clubId: string;
}): Promise<void> =>
  withBrowserGameStorageTransaction(options.localStorage, () => {
    const raw = options.localStorage.getItem(gameSessionStorageKey);
    const attachment = raw === null ? null : attachmentFromRaw(raw);
    if (attachment?.clubId !== options.clubId) return;
    removeCurrentRecord(options.localStorage, raw!);
  });

export const clearBrowserGameStorageForClubLocked = (
  options: { readonly localStorage: Storage; readonly clubId: string },
  storageGuard: BrowserGameStorageGuard,
): void => {
  assertBrowserGameStorageGuard(storageGuard);
  const raw = options.localStorage.getItem(gameSessionStorageKey);
  const attachment = raw === null ? null : attachmentFromRaw(raw);
  if (attachment?.clubId !== options.clubId) return;
  removeCurrentRecord(options.localStorage, raw!);
};

export const clearApplicationBrowserStorage = async (
  localStorage: Storage,
  sessionStorage: Storage,
): Promise<void> =>
  withBrowserGameStorageTransaction(localStorage, () => {
    localStorage.clear();
    sessionStorage.clear();
  });

export const clearApplicationBrowserStorageLocked = (
  localStorage: Storage,
  sessionStorage: Storage,
  storageGuard: BrowserGameStorageGuard,
): void => {
  assertBrowserGameStorageGuard(storageGuard);
  localStorage.clear();
  sessionStorage.clear();
};
