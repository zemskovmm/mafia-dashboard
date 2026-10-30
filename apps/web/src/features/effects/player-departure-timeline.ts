import type { PlayerDepartureCause } from "../game/player-action-presentation.js";
import { playerExitMotion } from "./player-exit-motion.js";
import type { PlayerExitSettings } from "./player-exit-preferences.js";

/** One clock for providers, both renderers and developer previews. */
export const playerDepartureTimeline = (
  settings: PlayerExitSettings,
  cause: PlayerDepartureCause = "unknown",
) => {
  const turn = playerExitMotion(settings);
  const turnStart =
    cause === "mafia" ? settings.impactMs : cause === "discipline" ? settings.disciplineMs : 0;
  const tearStart = turnStart + turn.duration;
  const fadeStart = tearStart + (cause === "vote" ? settings.tearMs : 0);
  const duration = fadeStart + settings.fadeMs;
  const retime = (frames: Keyframe[]): Keyframe[] =>
    turnStart === 0 && duration === turn.duration
      ? frames
      : [
          { ...frames[0], offset: 0 },
          ...frames.map((frame) => ({
            ...frame,
            offset: (turnStart + Number(frame.offset) * turn.duration) / duration,
          })),
          { ...frames.at(-1), offset: 1 },
        ];
  return {
    duration,
    turnStart,
    tearStart,
    fadeStart,
    edge: (turnStart + turn.edge * turn.duration) / duration,
    lift: retime(turn.lift),
    turn: retime(turn.turn),
    front: retime(turn.front),
    back: retime(turn.back),
    material: retime(turn.material),
  };
};
