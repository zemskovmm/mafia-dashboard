/** A finite, replaceable highlight only; callers own activation semantics. */
export const createFiniteGlassSweep = (host: HTMLElement, light: HTMLElement) => {
  const view = host.ownerDocument.defaultView;
  const motion = view?.matchMedia?.("(prefers-reduced-motion: reduce)");
  const transparency = view?.matchMedia?.("(prefers-reduced-transparency: reduce)");
  let animation: Animation | null = null;
  const cancel = () => {
    if (animation === null) return;
    animation.onfinish = null;
    animation.cancel();
    animation = null;
  };
  const sweep = () => {
    if (
      motion?.matches ||
      transparency?.matches ||
      host.matches(":disabled, [aria-disabled='true']") ||
      typeof light.animate !== "function"
    )
      return;
    cancel();
    // No host/content transform, frame callback, bitmap rebuild or React update.
    try {
      const nextAnimation = light.animate(
        [
          { transform: "rotate(0deg) scale(1)", opacity: 1 },
          { transform: "rotate(170deg) scale(1.06)", opacity: 0.85, offset: 0.55 },
          { transform: "rotate(360deg) scale(1)", opacity: 1 },
        ],
        { duration: 1050, easing: "ease-in-out", iterations: 1, fill: "none" },
      );
      animation = nextAnimation;
      nextAnimation.onfinish = () => {
        if (animation === nextAnimation) animation = null;
      };
    } catch {
      // Decorative WAAPI failure must not interrupt the host's native action.
    }
  };
  motion?.addEventListener?.("change", cancel);
  transparency?.addEventListener?.("change", cancel);
  return {
    sweep,
    dispose: () => {
      cancel();
      motion?.removeEventListener?.("change", cancel);
      transparency?.removeEventListener?.("change", cancel);
    },
  };
};
