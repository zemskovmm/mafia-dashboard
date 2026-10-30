import type { CSSProperties, ReactNode } from "react";
import type { PlayerExitRequest } from "../game/PlayerExitProvider.js";
import type { PlayerDepartureCause } from "../game/player-action-presentation.js";
import { playerDepartureTimeline } from "../effects/player-departure-timeline.js";
import type { PlayerExitSettings } from "../effects/player-exit-preferences.js";
import { PLAYER_TEAR_LEFT_CLIP, PLAYER_TEAR_RIGHT_CLIP } from "../effects/player-tear-geometry.js";
import "./PlayerDepartureEffects.css";

export const departurePresentationStyle = (
  cause: PlayerDepartureCause | undefined,
  settings: PlayerExitSettings,
): CSSProperties =>
  ({
    "--player-exit-tear": cause === "vote" ? 1 : 0,
    "--player-exit-gap": settings.gap,
    "--player-exit-fade": cause === undefined ? 1 : settings.finalOpacity / 100,
    "--player-exit-hit": 3,
  }) as CSSProperties;

export const DepartureMarks = ({ cause }: Readonly<{ cause?: PlayerDepartureCause }>) =>
  cause === "mafia" ? (
    <span className="player-bullet-holes" aria-hidden="true">
      {[1, 2, 3].map((index) => (
        <span
          key={index}
          className="player-bullet-hole"
          style={{ "--hole": index } as CSSProperties}
        />
      ))}
    </span>
  ) : cause === "discipline" ? (
    <>
      <span className="player-disciplinary-card" aria-hidden="true" />
      <span className="player-disciplinary-ribbon" aria-hidden="true" />
    </>
  ) : null;

/** The two real surfaces are the only backing. Public identity belongs outside these pieces. */
export const TornReverse = ({ children }: Readonly<{ children: ReactNode }>) => (
  <>
    {[PLAYER_TEAR_LEFT_CLIP, PLAYER_TEAR_RIGHT_CLIP].map((clipPath, index) => (
      <span
        key={index}
        className={`player-torn-fragment player-torn-fragment--${index ? "right" : "left"}`}
        style={{ clipPath }}
        aria-hidden="true"
      >
        {children}
      </span>
    ))}
  </>
);

/** Append immediately so the caller owns every track, even if later startup fails. */
export const animateDepartureEffects = (
  host: HTMLElement,
  moving: HTMLElement,
  request: PlayerExitRequest,
  animations: Animation[],
): void => {
  const { cause, settings } = request;
  const timeline = playerDepartureTimeline(settings, cause);
  const options: KeyframeAnimationOptions = {
    duration: timeline.duration,
    easing: "linear",
    fill: "both",
  };
  const track = (target: HTMLElement, frames: Keyframe[]) => {
    const animation = target.animate(frames, options);
    animations.push(animation);
    animation.id = `player-exit-${request.id}`;
  };
  if (cause === "mafia") {
    const impacts = [0.08, 0.4, 0.72].map(
      (fraction) => (fraction * settings.impactMs) / timeline.duration,
    );
    track(host, [
      { "--player-exit-hit": 0, offset: 0, easing: "steps(1, end)" },
      ...impacts.map((offset, index) => ({
        "--player-exit-hit": index + 1,
        offset,
        easing: "steps(1, end)",
      })),
      { "--player-exit-hit": 3, offset: 1 },
    ]);
    track(moving, [
      { translate: "0 0", offset: 0 },
      ...impacts.flatMap((offset) => [
        { translate: "0 0", offset },
        { translate: "1px -2px", offset: offset + 30 / timeline.duration },
        { translate: "0 0", offset: offset + 75 / timeline.duration },
      ]),
      { translate: "0 0", offset: 1 },
    ]);
  }
  if (cause === "vote") {
    track(host, [
      { "--player-exit-tear": 0, offset: 0 },
      {
        "--player-exit-tear": 0,
        offset: timeline.tearStart / timeline.duration,
        easing: "ease-in-out",
      },
      { "--player-exit-tear": 1, offset: timeline.fadeStart / timeline.duration },
      { "--player-exit-tear": 1, offset: 1 },
    ]);
  }
  track(host, [
    { "--player-exit-fade": 1, offset: 0 },
    { "--player-exit-fade": 1, offset: timeline.fadeStart / timeline.duration },
    { "--player-exit-fade": settings.finalOpacity / 100, offset: 1 },
  ]);
  if (cause === "discipline") {
    track(host, [
      { "--player-exit-sanction": 0, offset: 0 },
      { "--player-exit-sanction": 1, offset: (settings.disciplineMs * 0.3) / timeline.duration },
      { "--player-exit-sanction": 0, offset: settings.disciplineMs / timeline.duration },
      { "--player-exit-sanction": 0, offset: 1 },
    ]);
  }
  host.dispatchEvent(
    new CustomEvent("player-exit-motion", {
      bubbles: true,
      detail: {
        duration: Math.max(0, request.startedAt + timeline.duration - performance.now()),
      },
    }),
  );
};
