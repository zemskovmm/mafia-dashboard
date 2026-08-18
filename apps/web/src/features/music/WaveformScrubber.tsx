import type { PointerEvent } from "react";

interface WaveformScrubberProps {
  readonly label: string;
  readonly waveform: readonly number[];
  readonly durationSeconds: number;
  readonly value: number;
  readonly onChange: (seconds: number) => void;
  readonly playedSeconds?: number;
  readonly disabled?: boolean;
}

const formatTime = (seconds: number) => {
  const safe = Math.max(0, Math.round(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
};

export const WaveformScrubber = ({
  label,
  waveform,
  durationSeconds,
  value,
  onChange,
  playedSeconds,
  disabled = false,
}: WaveformScrubberProps) => {
  const duration = Math.max(0, durationSeconds);
  const selected = Math.min(duration, Math.max(0, value));
  const seekFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const progress = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    onChange(Number((progress * duration).toFixed(1)));
  };
  const peakWidth = waveform.length === 0 ? 100 : 100 / waveform.length;
  const playedPercent = duration === 0 ? 0 : ((playedSeconds ?? selected) / duration) * 100;
  const selectedPercent = duration === 0 ? 0 : (selected / duration) * 100;

  return (
    <div className="waveform-scrubber">
      <div className="waveform-heading">
        <strong>{label}</strong>
        <span>{formatTime(selected)}</span>
      </div>
      <svg
        className="waveform-canvas"
        role="img"
        aria-label={`${label} waveform`}
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) seekFromPointer(event);
        }}
      >
        <rect
          x="0"
          y="0"
          width={Math.min(100, playedPercent)}
          height="40"
          className="waveform-played"
        />
        {(waveform.length === 0 ? [0] : waveform).map((peak, index) => {
          const height = Math.max(1, Math.min(38, peak * 38));
          return (
            <rect
              key={index}
              data-testid="waveform-peak"
              className="waveform-peak"
              x={index * peakWidth}
              y={(40 - height) / 2}
              width={Math.max(0.08, peakWidth * 0.68)}
              height={height}
              rx="0.12"
            />
          );
        })}
        <line
          className="waveform-playhead"
          x1={selectedPercent}
          x2={selectedPercent}
          y1="0"
          y2="40"
        />
      </svg>
      <input
        className="waveform-range"
        type="range"
        aria-label={label}
        min="0"
        max={duration}
        step="0.1"
        value={selected}
        onChange={(event) => {
          if (!disabled) onChange(Number(event.target.value));
        }}
        disabled={disabled}
      />
      <div className="waveform-scale" aria-hidden="true">
        <span>0:00</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
};
