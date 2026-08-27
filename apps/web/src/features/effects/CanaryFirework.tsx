import { Bird } from "lucide-react";
import type { CSSProperties } from "react";

interface CanaryFireworkProps {
  readonly burstKey: number;
}

const particles = Array.from({ length: 32 }, (_, index) => {
  const angle = (index / 32) * Math.PI * 2;
  const distance = 48 + (index % 4) * 8;
  return {
    x: Math.round(Math.cos(angle) * distance),
    y: Math.max(-18, Math.round(Math.sin(angle) * distance)),
    delay: (index % 8) * 18,
    rotation: (index % 2 === 0 ? 1 : -1) * (120 + (index % 5) * 35),
  };
});

export const CanaryFirework = ({ burstKey }: CanaryFireworkProps) => (
  <span key={burstKey} className="canary-firework" data-burst-key={burstKey} aria-hidden="true">
    {particles.map(({ x, y, delay, rotation }, index) => (
      <span
        key={`${burstKey}-${index}`}
        data-canary-particle=""
        style={
          {
            "--canary-x": `${x}px`,
            "--canary-y": `${y}px`,
            "--canary-delay": `${delay}ms`,
            "--canary-rotation": `${rotation}deg`,
          } as CSSProperties
        }
      >
        <Bird fill="currentColor" strokeWidth={1.8} />
      </span>
    ))}
  </span>
);
