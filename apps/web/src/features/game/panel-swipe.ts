export type PanelSwipe = "up" | "down" | "left" | "right";

export const classifyPanelSwipe = (
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  threshold = 44,
): PanelSwipe | null => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const absoluteDx = Math.abs(dx);
  const absoluteDy = Math.abs(dy);

  if (Math.max(absoluteDx, absoluteDy) < threshold) return null;
  if (absoluteDx > absoluteDy * 1.25) return dx > 0 ? "right" : "left";
  if (absoluteDy > absoluteDx * 1.25) return dy > 0 ? "down" : "up";
  return null;
};
