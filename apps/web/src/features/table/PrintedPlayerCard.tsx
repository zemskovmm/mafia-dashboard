import type { Role } from "@mafia/game-domain";
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useMessages } from "../../i18n/I18nProvider.js";
import { gameMessages } from "../../i18n/messages/game.js";
import { useFancyFeatures } from "../effects/FancyFeaturesContext.js";
import { playerExitMotion } from "../effects/player-exit-motion.js";
import { playerDepartureTimeline } from "../effects/player-departure-timeline.js";
import { synchronizeCardAnimations } from "../effects/synchronize-card-animations.js";
import type { PlayerDepartureCause } from "../game/player-action-presentation.js";
import { animateDepartureEffects, DepartureMarks, TornReverse } from "./PlayerDepartureEffects.js";
import { DEFAULT_PLAYER_EXIT_SETTINGS } from "../effects/player-exit-preferences.js";
import type { PlayerExitRequest } from "../game/PlayerExitProvider.js";
import type { PrintedCardStyle, PrintedRolePlacement } from "../theme/player-card-preferences.js";
import { getCardArtwork } from "./card-decks.js";
import type { RoleDrawRequest } from "./RoleDrawPresentation.js";
import "./PrintedPlayerCard.css";

type Turn = Readonly<{ fromDown: boolean; fromRole?: Role }> &
  (
    | Readonly<{ kind: "draw"; request: RoleDrawRequest }>
    | Readonly<{ kind: "exit"; request: PlayerExitRequest }>
    | Readonly<{ kind: "privacy"; startedAt: number }>
  );

/** Presentation only: the parent owns privacy eligibility, public departure and native actions. */
export const PrintedPlayerCard = ({
  style,
  seat,
  suit,
  role,
  rolePlacement,
  faceDown,
  privacyHidden,
  roleDrawRequest,
  exitRequest,
  departureCause,
  onRoleDrawComplete,
  onExitComplete,
  children,
}: Readonly<{
  style: PrintedCardStyle;
  seat: number;
  suit: string;
  role?: Role;
  rolePlacement: PrintedRolePlacement;
  faceDown: boolean;
  privacyHidden: boolean;
  roleDrawRequest?: RoleDrawRequest;
  exitRequest?: PlayerExitRequest;
  departureCause?: PlayerDepartureCause;
  onRoleDrawComplete?: (id: number) => void;
  onExitComplete?: (id: number) => void;
  children?: ReactNode;
}>) => {
  const { t } = useMessages(gameMessages);
  const fancy = useFancyFeatures();
  const artwork = getCardArtwork(style, seat);
  const motionElement = useRef<HTMLSpanElement>(null);
  const outgoing = useRef<HTMLSpanElement>(null);
  const current = useRef<HTMLSpanElement>(null);
  const publicIdentity = useRef<HTMLSpanElement>(null);
  const [turn, setTurn] = useState<Turn>();
  const active = useRef<Turn>(undefined);
  const previous = useRef<{
    down: boolean;
    privacy: boolean;
    style: PrintedCardStyle;
    role?: Role;
  }>(undefined);
  const seen = useRef({ draw: new Set<number>(), exit: new Set<number>() });
  const completed = useRef({ draw: new Set<number>(), exit: new Set<number>() });
  const callbacks = useRef({ draw: onRoleDrawComplete, exit: onExitComplete });
  useLayoutEffect(() => {
    callbacks.current = { draw: onRoleDrawComplete, exit: onExitComplete };
  });
  const finishRequest = useCallback((kind: "draw" | "exit", id: number) => {
    if (completed.current[kind].has(id)) return;
    completed.current[kind].add(id);
    callbacks.current[kind]?.(id);
  }, []);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { down: faceDown, privacy: privacyHidden, style, role };
    const newDraw = roleDrawRequest && !seen.current.draw.has(roleDrawRequest.id);
    const newExit = exitRequest && !seen.current.exit.has(exitRequest.id);
    if (roleDrawRequest) seen.current.draw.add(roleDrawRequest.id);
    if (exitRequest) seen.current.exit.add(exitRequest.id);
    const replace = (next?: Turn) => {
      active.current = next;
      setTurn(next);
    };
    if (!before || before.style !== style) {
      // A mount/style switch is a snapshot, not a newly accepted gameplay action.
      replace();
      if (roleDrawRequest) finishRequest("draw", roleDrawRequest.id);
      if (exitRequest) finishRequest("exit", exitRequest.id);
      return;
    }
    if (newExit) {
      replace({
        kind: "exit",
        request: exitRequest,
        fromDown: exitRequest.fromFaceDown ?? before.down,
      });
    } else if (newDraw) {
      replace({
        kind: "draw",
        request: roleDrawRequest,
        fromDown: before.down,
        fromRole: roleDrawRequest.previousRole,
      });
    } else if (before.privacy !== privacyHidden && before.down !== faceDown) {
      // Privacy interrupts an accepted action at its correct endpoint, then turns
      // the already-redacted paper. It must not retain an obsolete role face.
      const interrupted = active.current;
      if (interrupted && interrupted.kind !== "privacy")
        finishRequest(interrupted.kind, interrupted.request.id);
      replace({
        kind: "privacy",
        startedAt: performance.now(),
        fromDown: before.down,
        fromRole: before.role,
      });
    } else if (
      before.down !== faceDown ||
      (active.current?.kind === "draw" && active.current.request.id !== roleDrawRequest?.id) ||
      (active.current?.kind === "exit" && active.current.request.id !== exitRequest?.id)
    ) {
      // Undo, corrections and removed/replaced requests settle without inventing events.
      replace();
    }
  }, [faceDown, privacyHidden, style, role, roleDrawRequest, exitRequest, finishRequest]);

  useLayoutEffect(() => {
    if (!turn || active.current !== turn) return;
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const settings = turn.kind === "exit" ? turn.request.settings : DEFAULT_PLAYER_EXIT_SETTINGS;
    const motion =
      turn.kind === "exit"
        ? playerDepartureTimeline(settings, turn.request.cause)
        : playerExitMotion(settings);
    const startedAt = turn.kind === "privacy" ? turn.startedAt : turn.request.startedAt;
    const elapsed = Math.max(0, performance.now() - startedAt);
    const animations: Animation[] = [];
    let running = true;
    let disposed = false;
    let timeout: number | undefined = undefined;
    const interrupt = () => {
      if (document.hidden || preference?.matches) settle();
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(timeout);
      animations.forEach((animation) => animation.cancel());
      document.removeEventListener("visibilitychange", interrupt);
      preference?.removeEventListener?.("change", interrupt);
    };
    const settle = () => {
      if (!running || active.current !== turn) return;
      running = false;
      // Keep filled native frames until the commit installs the static paper
      // and public plane; the layout cleanup then releases all tracks together.
      active.current = undefined;
      setTurn(undefined);
      if (turn.kind !== "privacy") finishRequest(turn.kind, turn.request.id);
    };
    const host = motionElement.current?.closest<HTMLElement>(".player-seat");
    if (
      !fancy ||
      !settings.enabled ||
      document.hidden ||
      preference?.matches ||
      !host?.animate ||
      !outgoing.current ||
      !current.current ||
      !publicIdentity.current ||
      elapsed >= motion.duration
    ) {
      settle();
      return;
    }
    const cleanup = () => {
      running = false;
      dispose();
    };
    try {
      const options: KeyframeAnimationOptions = {
        duration: motion.duration,
        fill: "both",
        easing: "linear",
      };
      const publicTurn = motion.turn.map((frame) => {
        const degrees = Number.parseFloat(String(frame.rotate).split(/\s+/).at(-1) ?? "0");
        return { ...frame, rotate: `y ${-degrees}deg` };
      });
      for (const [target, frames] of [
        [host, motion.lift],
        [host, motion.turn],
        [outgoing.current, motion.front],
        [current.current, motion.back],
        [publicIdentity.current, publicTurn],
      ] as const) {
        const animation = target.animate(frames, options);
        animations.push(animation);
        animation.id = `printed-card-${turn.kind}-${turn.kind === "privacy" ? startedAt : turn.request.id}`;
      }
      if (turn.kind === "exit") {
        animateDepartureEffects(host, host, turn.request, animations);
      }
      synchronizeCardAnimations(animations, startedAt);
    } catch {
      // Observe cancellation of any animations started before a later animate() failed.
      void Promise.all(animations.map((animation) => animation.finished)).catch(() => {});
      settle();
      // Register the same commit-owned cleanup even when startup was partial.
      return cleanup;
    }
    void Promise.all(animations.map((animation) => animation.finished)).then(settle, settle);
    timeout = window.setTimeout(settle, motion.duration - elapsed + 80);
    document.addEventListener("visibilitychange", interrupt);
    preference?.addEventListener?.("change", interrupt);
    return cleanup;
  }, [turn, fancy, finishRequest]);

  // Never cache revealing markup. This guard applies on the very render that
  // hides/departs, including the outgoing face of an interrupted turn.
  const permittedRole = !faceDown && !privacyHidden && !exitRequest?.hideRole;
  const roleLabel = (faceRole?: Role) =>
    permittedRole && faceRole ? (
      <span className="printed-player-card__role">{t(`role.${faceRole}`)}</span>
    ) : null;
  const face = (down: boolean, faceRole?: Role) =>
    down ? (
      <img className="printed-player-card__back-art" src={artwork.back} alt="" draggable={false} />
    ) : (
      <>
        <PrintedFrame style={style} />
        {[false, true].map((lower) => (
          <span
            key={String(lower)}
            className={`printed-player-card__index${lower ? " printed-player-card__index--lower" : ""}${suit === "♥" || suit === "♦" ? " printed-player-card__index--red" : ""}`}
            aria-hidden="true"
          >
            <span>{seat}</span>
            <span className="printed-player-card__suit">{suit}</span>
          </span>
        ))}
        <img className="printed-player-card__art" src={artwork.front} alt="" draggable={false} />
        {rolePlacement === "ribbon" && faceRole ? (
          <span className="printed-player-card__role-band">{roleLabel(faceRole)}</span>
        ) : (
          roleLabel(faceRole)
        )}
      </>
    );
  return (
    <span
      className={`printed-player-card printed-player-card--${style}`}
      data-down={faceDown}
      data-turning={turn ? "true" : undefined}
      data-role-placement={rolePlacement}
    >
      <span ref={motionElement} className="printed-player-card__motion">
        {turn ? (
          <span
            ref={outgoing}
            className="printed-player-card__surface printed-player-card__outgoing"
            aria-hidden="true"
          >
            {face(turn.fromDown, turn.fromRole)}
            <DepartureMarks cause={departureCause} />
          </span>
        ) : null}
        <span
          ref={current}
          className={`${departureCause === "vote" ? "player-torn-reverse" : "printed-player-card__surface"} printed-player-card__current${turn ? " printed-player-card__incoming" : ""}`}
        >
          {departureCause === "vote" ? (
            <TornReverse>
              <span className="printed-player-card__surface">{face(true)}</span>
            </TornReverse>
          ) : (
            <>
              {face(faceDown, role)}
              <DepartureMarks cause={departureCause} />
            </>
          )}
        </span>
      </span>
      <span ref={publicIdentity} className="printed-player-card__public">
        <span className="printed-player-card__status">{children}</span>
      </span>
    </span>
  );
};

/** Ornament has no role-bearing data and stays independent of replaceable illustrations. */
const PrintedFrame = ({ style }: Readonly<{ style: PrintedCardStyle }>) => {
  const mask = useId();
  if (style === "classic") return null;
  return (
    <svg className="printed-player-card__frame" viewBox="0 0 230 330" aria-hidden="true">
      <defs>
        <mask id={mask}>
          <rect width="230" height="330" fill="white" />
          <path
            d="M0 0h37v65H0zM193 265h37v65h-37zM0 120h28v85H0zM202 120h28v85h-28z"
            fill="black"
          />
        </mask>
      </defs>
      <g fill="none" stroke="currentColor" strokeWidth=".7" mask={`url(#${mask})`}>
        {style === "noir" ? (
          <path d="M53 8h124l44 44v226l-44 44H53L9 278V52Z M64 15h102l48 48v204l-48 48H64l-48-48V63Z M74 8l41 31 41-31M74 322l41-31 41 31 M9 107v20m0 77v20m212-117v20m0 77v20" />
        ) : (
          <>
            <rect x="5" y="5" width="220" height="320" rx="9" />
            <rect x="10" y="10" width="210" height="310" rx="7" />
            <path d="M51 15c-12 17 13 32 21 15s-12-19-11-7M179 15c12 17-13 32-21 15s12-19 11-7M51 315c-12-17 13-32 21-15s-12 19-11 7M179 315c12-17-13-32-21-15s12 19 11 7M89 17l26-8 26 8-26 7Zm0 296 26-8 26 8-26 7Z" />
          </>
        )}
      </g>
    </svg>
  );
};
