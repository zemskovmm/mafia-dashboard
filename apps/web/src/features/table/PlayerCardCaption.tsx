import type { Ref } from "react";
import "./PlayerCardCaption.css";

/** Face-down/departed identity stays outside the rotating/fading card and its backs. */
export const PlayerCardCaption = ({
  name,
  ref,
}: Readonly<{ name: string; ref?: Ref<HTMLSpanElement> }>) => (
  <span ref={ref} className="seat-name player-seat-caption" title={name} aria-hidden="true">
    {name}
  </span>
);
