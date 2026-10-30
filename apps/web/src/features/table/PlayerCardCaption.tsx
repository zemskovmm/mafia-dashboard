import "./PlayerCardCaption.css";

/** Public identity stays outside the rotating/fading card and its private faces. */
export const PlayerCardCaption = ({ name }: Readonly<{ name: string }>) => (
  <span className="seat-name player-seat-caption" title={name} aria-hidden="true">
    {name}
  </span>
);
