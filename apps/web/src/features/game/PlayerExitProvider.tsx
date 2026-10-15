import type { GameState } from "@mafia/game-domain";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PlayerExitSettings } from "../effects/player-exit-preferences.js";
import { pendingGoodbyeSeats, playerExitSeats } from "./player-exit-transitions.js";

export interface PlayerExitRequest {
  readonly id: number;
  readonly startedAt: number;
  readonly settings: PlayerExitSettings;
  readonly hideRole: boolean;
}

type Requests = Readonly<Partial<Record<number, PlayerExitRequest>>>;
const PlayerExitContext = createContext<{
  requests: Requests;
  waiting: readonly number[];
  privacyHidden: boolean;
  complete: (seat: number, id: number) => void;
}>({ requests: {}, waiting: [], privacyHidden: false, complete: () => undefined });

export const usePlayerExits = () => useContext(PlayerExitContext);

export const PlayerExitProvider = ({
  game,
  live,
  privacyHidden,
  settings,
  children,
}: Readonly<{
  game: GameState;
  live: boolean;
  privacyHidden: boolean;
  settings: PlayerExitSettings;
  children: ReactNode;
}>) => {
  const previous = useRef({ game, live, privacyHidden });
  const serial = useRef(0);
  const [requests, setRequests] = useState<Requests>({});
  const complete = useCallback((seat: number, id: number) => {
    setRequests((current) => {
      if (current[seat]?.id !== id) return current;
      const next = { ...current };
      delete next[seat];
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { game, live, privacyHidden };
    const replacement =
      before.game.players.length !== game.players.length ||
      game.players.some(
        (player) =>
          !before.game.players.some((old) => old.seat === player.seat && old.id === player.id),
      );
    if (
      !live ||
      !before.live ||
      replacement ||
      !settings.enabled ||
      game.phase === "draw" ||
      game.phase === "cancelled" ||
      game.adjudication
    ) {
      setRequests((current) => (Object.keys(current).length ? {} : current));
      return;
    }
    if (
      before.game === game ||
      document.hidden ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const seats = playerExitSeats(before.game, game);
    if (!seats.length) return;
    const additions: Partial<Record<number, PlayerExitRequest>> = {};
    for (const seat of seats)
      additions[seat] = {
        id: ++serial.current,
        startedAt: performance.now(),
        settings,
        hideRole: before.privacyHidden || privacyHidden,
      };
    setRequests((current) => ({ ...current, ...additions }));
  }, [game, live, privacyHidden, settings]);

  useEffect(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const interrupt = () => {
      if (document.hidden || motion?.matches) setRequests({});
    };
    document.addEventListener("visibilitychange", interrupt);
    motion?.addEventListener("change", interrupt);
    return () => {
      document.removeEventListener("visibilitychange", interrupt);
      motion?.removeEventListener("change", interrupt);
    };
  }, []);

  // Expire even if a phase temporarily has no table. New table instances join the same clock.
  useEffect(() => {
    const timers = Object.entries(requests).flatMap(([seat, request]) =>
      request
        ? [
            window.setTimeout(
              () => complete(Number(seat), request.id),
              Math.max(
                0,
                request.startedAt +
                  request.settings.liftMs +
                  request.settings.landingMs -
                  performance.now(),
              ),
            ),
          ]
        : [],
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [requests, complete]);

  return (
    <PlayerExitContext.Provider
      value={{ requests, waiting: live ? pendingGoodbyeSeats(game) : [], privacyHidden, complete }}
    >
      {children}
    </PlayerExitContext.Provider>
  );
};
