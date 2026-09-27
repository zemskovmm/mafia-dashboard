export const browserGameStorageLockKey = "mafia-dashboard.game-session.v5.transaction";

const guardBrand = Symbol("browser-game-storage-guard");

export interface BrowserGameStorageGuard {
  readonly active: boolean;
  readonly [guardBrand]: true;
}

interface MutableBrowserGameStorageGuard extends BrowserGameStorageGuard {
  active: boolean;
}

type LockOperation<T> = () => T | Promise<T>;

interface LockOptions {
  readonly ifAvailable?: boolean;
}

export class BrowserGameStorageBusyError extends Error {
  constructor() {
    super("Browser game storage is in use by another tab");
    this.name = "BrowserGameStorageBusyError";
  }
}

let testLockHeld = false;
const testLockQueue: Array<() => void> = [];

const finishTestLock = () => {
  const next = testLockQueue.shift();
  if (next === undefined) testLockHeld = false;
  else next();
};

const withTestLock = <T>(operation: LockOperation<T>, options: LockOptions): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (options.ifAvailable && testLockHeld) {
      reject(new BrowserGameStorageBusyError());
      return;
    }
    const run = () => {
      testLockHeld = true;
      let result: T | Promise<T>;
      try {
        result = operation();
      } catch (error) {
        reject(error);
        finishTestLock();
        return;
      }
      void Promise.resolve(result).then(
        (value) => {
          finishTestLock();
          resolve(value);
        },
        (error: unknown) => {
          finishTestLock();
          reject(error);
        },
      );
    };

    if (testLockHeld) testLockQueue.push(run);
    else run();
  });

const withBrowserLock = <T>(operation: LockOperation<T>, options: LockOptions): Promise<T> => {
  if (globalThis.navigator?.locks !== undefined) {
    return globalThis.navigator.locks.request(browserGameStorageLockKey, options, (lock) => {
      if (lock === null) throw new BrowserGameStorageBusyError();
      return operation();
    });
  }
  if (import.meta.env.MODE === "test") return withTestLock(operation, options);
  return Promise.reject(new Error("This browser cannot safely lock local game storage"));
};

export const withBrowserGameStorageTransaction = <T>(
  _storage: Storage,
  operation: LockOperation<T>,
  options: LockOptions = {},
): Promise<T> => withBrowserLock(operation, options);

export const withBrowserGameStorageGuard = <T>(
  operation: (guard: BrowserGameStorageGuard) => T | Promise<T>,
  options: LockOptions = {},
): Promise<T> =>
  withBrowserLock(async () => {
    const guard: MutableBrowserGameStorageGuard = { active: true, [guardBrand]: true };
    try {
      return await operation(guard);
    } finally {
      guard.active = false;
    }
  }, options);

export const assertBrowserGameStorageGuard = (guard: BrowserGameStorageGuard | undefined) => {
  if (guard?.[guardBrand] !== true || !guard.active) {
    throw new Error("Browser game storage lock is not held");
  }
};
