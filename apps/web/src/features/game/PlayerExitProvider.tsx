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
import {
  pendingGoodbyeSeats,
  pendingPublicDepartureSeats,
  playerExitSeats,
} from "./player-exit-transitions.js";
import { useFancyFeatures } from "../effects/FancyFeaturesContext.js";
import type { PlayerFeedbackRequest } from "../table/PlayerFeedback.js";
import { PlayerCardStyleContext } from "../theme/PlayerCardStyleContext.js";
import { playerDepartureTimeline } from "../effects/player-departure-timeline.js";
import {
  advanceDepartureCauses,
  publicDepartureCauses,
  type PlayerActionPresentation,
  type PlayerDepartureCause,
  type PlayerDepartureCauses,
} from "./player-action-presentation.js";

export interface PlayerExitRequest {
  readonly id: number;
  readonly startedAt: number;
  readonly settings: PlayerExitSettings;
  readonly hideRole: boolean;
  /** Capture the outgoing printed side before child layout effects see the new game. */
  readonly fromFaceDown?: boolean;
  readonly cause?: PlayerDepartureCause;
}

type Requests = Readonly<Partial<Record<number, PlayerExitRequest>>>;
const PlayerExitContext = createContext<{
  requests: Requests;
  waiting: readonly number[];
  pendingDepartures: readonly number[];
  privacyHidden: boolean;
  endpoints: PlayerDepartureCauses;
  settings?: PlayerExitSettings;
  feedback: Readonly<Partial<Record<number, PlayerFeedbackRequest>>>;
  adjudication?: PlayerFeedbackRequest;
  complete: (seat: number, id: number) => void;
}>({
  requests: {},
  waiting: [],
  pendingDepartures: [],
  privacyHidden: false,
  endpoints: {},
  feedback: {},
  complete: () => undefined,
});

export const usePlayerExits = () => useContext(PlayerExitContext);

export const PlayerExitProvider = ({
  game,
  live,
  privacyHidden,
  settings,
  presentation,
  children,
}: Readonly<{
  game: GameState;
  live: boolean;
  privacyHidden: boolean;
  settings: PlayerExitSettings;
  presentation?: PlayerActionPresentation;
  children: ReactNode;
}>) => {
  const fancyEnabled = useFancyFeatures();
  const { style } = useContext(PlayerCardStyleContext);
  const previous = useRef({
    game: presentation?.action?.after ?? game,
    style,
    live,
    privacyHidden,
    fancyEnabled,
    actionId: presentation?.action?.id,
    causes: {} as PlayerDepartureCauses,
  });
  const styleChanged = previous.current.style !== style;
  const causes = advanceDepartureCauses(previous.current.causes, previous.current.game, game);
  const endpoints = presentation?.endpoints ?? publicDepartureCauses(game, causes);
  const serial = useRef(0);
  const [requests, setRequests] = useState<Requests>({});
  const [feedback, setFeedback] = useState<
    Readonly<Partial<Record<number | "result", PlayerFeedbackRequest>>>
  >({});
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
    previous.current = {
      game: presentation?.action?.after ?? game,
      style,
      live,
      privacyHidden,
      fancyEnabled,
      actionId: presentation?.action?.id,
      causes,
    };
    const replacement =
      before.game.players.length !== game.players.length ||
      game.players.some(
        (player) =>
          !before.game.players.some((old) => old.seat === player.seat && old.id === player.id),
      );
    if (
      !live ||
      !before.live ||
      !fancyEnabled ||
      !before.fancyEnabled ||
      replacement ||
      styleChanged ||
      !settings.enabled ||
      game.phase === "draw" ||
      game.phase === "cancelled"
    ) {
      setRequests((current) => (Object.keys(current).length ? {} : current));
      setFeedback((current) => (Object.keys(current).length ? {} : current));
      return;
    }
    if (
      before.game === game ||
      (presentation !== undefined && before.actionId === presentation.action?.id) ||
      document.hidden ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const startedAt = performance.now();
    const fouls =
      presentation?.action?.fouls ??
      Object.fromEntries(
        game.players.flatMap((player) => {
          const old = before.game.players.find((p) => p.id === player.id && p.seat === player.seat);
          return old &&
            player.status === "active" &&
            player.fouls === old.fouls + 1 &&
            player.fouls <= 3
            ? [[player.seat, player.fouls]]
            : [];
        }),
      );
    const cues: Partial<Record<number | "result", PlayerFeedbackRequest>> = {};
    for (const [seat, foulNumber] of Object.entries(fouls))
      cues[Number(seat)] = { id: ++serial.current, startedAt, settings, foulNumber };
    if (
      presentation?.action?.adjudication ||
      (!presentation && game.adjudication && !before.game.adjudication)
    )
      cues.result = { id: ++serial.current, startedAt, settings };
    if (Object.keys(cues).length) setFeedback((current) => ({ ...current, ...cues }));
    if (game.adjudication) {
      setRequests((current) => (Object.keys(current).length ? {} : current));
      return;
    }
    const seats = playerExitSeats(before.game, game);
    if (!seats.length) return;
    const additions: Partial<Record<number, PlayerExitRequest>> = {};
    const pendingBefore = pendingPublicDepartureSeats(before.game);
    for (const seat of seats) {
      const statusBefore = before.game.players.find((player) => player.seat === seat)?.status;
      additions[seat] = {
        id: ++serial.current,
        startedAt,
        settings,
        cause: endpoints[seat] ?? "unknown",
        hideRole: before.privacyHidden || privacyHidden,
        fromFaceDown:
          before.privacyHidden ||
          statusBefore === "red-carded" ||
          (statusBefore === "eliminated" && !pendingBefore.includes(seat)),
      };
    }
    setRequests((current) => ({ ...current, ...additions }));
  }, [
    fancyEnabled,
    game,
    live,
    privacyHidden,
    settings,
    presentation,
    causes,
    endpoints,
    style,
    styleChanged,
  ]);

  useEffect(() => {
    if (!fancyEnabled || !settings.enabled) return;
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const interrupt = () => {
      if (document.hidden || motion?.matches) {
        setRequests({});
        setFeedback({});
      }
    };
    document.addEventListener("visibilitychange", interrupt);
    motion?.addEventListener("change", interrupt);
    return () => {
      document.removeEventListener("visibilitychange", interrupt);
      motion?.removeEventListener("change", interrupt);
    };
  }, [fancyEnabled, settings.enabled]);

  // Expire even if a phase temporarily has no table. New table instances join the same clock.
  useEffect(() => {
    if (!fancyEnabled) return;
    const timers = Object.entries(requests).flatMap(([seat, request]) =>
      request
        ? [
            window.setTimeout(
              () => complete(Number(seat), request.id),
              Math.max(
                0,
                request.startedAt +
                  playerDepartureTimeline(request.settings, request.cause).duration -
                  performance.now(),
              ),
            ),
          ]
        : [],
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [fancyEnabled, requests, complete]);

  useEffect(() => {
    if (!fancyEnabled) return;
    const timers = Object.entries(feedback).map(([key, cue]) =>
      cue
        ? window.setTimeout(
            () => {
              setFeedback((current) => {
                const seat = key === "result" ? key : Number(key);
                if (current[seat]?.id !== cue.id) return current;
                const next = { ...current };
                delete next[seat];
                return next;
              });
            },
            Math.max(0, cue.startedAt + cue.settings.disciplineMs - performance.now()),
          )
        : undefined,
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [fancyEnabled, feedback]);

  return (
    <PlayerExitContext.Provider
      value={{
        requests: fancyEnabled && !styleChanged ? requests : {},
        waiting: live ? pendingGoodbyeSeats(game) : [],
        pendingDepartures: pendingPublicDepartureSeats(game),
        privacyHidden,
        endpoints,
        settings,
        feedback: fancyEnabled && !styleChanged ? feedback : {},
        adjudication: fancyEnabled && !styleChanged ? feedback.result : undefined,
        complete,
      }}
    >
      {children}
    </PlayerExitContext.Provider>
  );
};
