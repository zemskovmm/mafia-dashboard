interface AppCloser {
  close(): Promise<unknown>;
}

interface PoolCloser {
  end(): Promise<void>;
}

type ShutdownSignal = "SIGINT" | "SIGTERM";

interface SignalRegistrar {
  on(signal: ShutdownSignal, listener: () => void): unknown;
}

export const registerShutdownSignals = (registrar: SignalRegistrar, listener: () => void): void => {
  registrar.on("SIGINT", listener);
  registrar.on("SIGTERM", listener);
};

export const createShutdown = (app: AppCloser, pool: PoolCloser): (() => Promise<void>) => {
  let shutdown: Promise<void> | undefined;

  return () =>
    (shutdown ??= (async () => {
      let appCloseFailed = false;
      let appCloseFailure: unknown;
      try {
        await app.close();
      } catch (error) {
        appCloseFailed = true;
        appCloseFailure = error;
      }

      try {
        await pool.end();
      } catch (error) {
        if (!appCloseFailed) throw error;
      }

      if (appCloseFailed) throw appCloseFailure;
    })());
};
