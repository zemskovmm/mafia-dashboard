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

let testLockHeld = false;
const testLockQueue: Array<() => void> = [];

const finishTestLock = () => {
  const next = testLockQueue.shift();
  if (next === undefined) testLockHeld = false;
  else next();
};

const withTestLock = <T>(operation: LockOperation<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
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
      void Promise.resolve(result).then(resolve, reject).finally(finishTestLock);
    };

    if (testLockHeld) testLockQueue.push(run);
    else run();
  });

const withBrowserLock = <T>(operation: LockOperation<T>): Promise<T> => {
  if (globalThis.navigator?.locks !== undefined) {
    return globalThis.navigator.locks.request(browserGameStorageLockKey, operation);
  }
  if (import.meta.env.MODE === "test") return withTestLock(operation);
  return Promise.reject(new Error("This browser cannot safely lock local game storage"));
};

export const withBrowserGameStorageTransaction = <T>(
  _storage: Storage,
  operation: LockOperation<T>,
): Promise<T> => withBrowserLock(operation);

export const withBrowserGameStorageGuard = <T>(
  operation: (guard: BrowserGameStorageGuard) => T | Promise<T>,
): Promise<T> =>
  withBrowserLock(async () => {
    const guard: MutableBrowserGameStorageGuard = { active: true, [guardBrand]: true };
    try {
      return await operation(guard);
    } finally {
      guard.active = false;
    }
  });

export const assertBrowserGameStorageGuard = (guard: BrowserGameStorageGuard | undefined) => {
  if (guard?.[guardBrand] !== true || !guard.active) {
    throw new Error("Browser game storage lock is not held");
  }
};
