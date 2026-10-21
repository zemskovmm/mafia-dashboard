import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMessages } from "../../i18n/I18nProvider.js";
import { tutorialMessages } from "../../i18n/messages/tutorial.js";
import { useFancyFeatures } from "../effects/FancyFeaturesContext.js";
import "./ScreenTutorial.css";

export interface TutorialSlide {
  readonly title: string;
  readonly body: string;
  readonly note?: string;
  readonly target?: string;
  readonly gesture?: "tap" | "triple-tap" | "up" | "down";
  readonly exampleLabel: string;
  readonly exampleSymbol?: string;
  readonly forceExample?: boolean;
}

type TutorialSlides = readonly TutorialSlide[];

export const ScreenTutorial = ({
  helpLabel,
  title,
  slides,
  safetyNote,
  onVisibilityChange,
}: {
  readonly helpLabel: string;
  readonly title: string;
  readonly slides: TutorialSlides | ((scope: HTMLElement | null) => TutorialSlides);
  readonly safetyNote?: string;
  readonly onVisibilityChange?: () => void;
}) => {
  const button = useRef<HTMLButtonElement>(null);
  const [visit, setVisit] = useState<{ scope: HTMLElement | null; slides: TutorialSlides } | null>(
    null,
  );
  return (
    <>
      <button
        ref={button}
        type="button"
        className="role-tutorial-help"
        aria-label={helpLabel}
        aria-haspopup="dialog"
        onClick={() => {
          // The nomination rail is a sibling of main, but never search another workspace.
          const scope = button.current?.closest<HTMLElement>(".app-shell, main") ?? null;
          const workspace = scope?.closest<HTMLElement>(".app-shell") ?? scope;
          const content = typeof slides === "function" ? slides(workspace) : slides;
          if (!content.length) return;
          onVisibilityChange?.();
          setVisit({ scope: workspace, slides: content });
        }}
      >
        <span aria-hidden="true">?</span>
      </button>
      {visit && (
        <TutorialDialog
          scope={visit.scope}
          title={title}
          slides={visit.slides}
          safetyNote={safetyNote}
          onDismiss={() => {
            onVisibilityChange?.();
            setVisit(null);
          }}
        />
      )}
    </>
  );
};

// Native modal inertness is not a hidden/disabled target: its geometry stays visible.
const visibleTarget = (target: HTMLElement, width: number, height: number): boolean => {
  const box = target.getBoundingClientRect();
  if (
    target.matches(":disabled, [aria-disabled='true']") ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.left < 0 ||
    box.top < 0 ||
    box.right > width ||
    box.bottom > height
  )
    return false;
  for (let element: HTMLElement | null = target; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (
      element.hidden ||
      element.hasAttribute("inert") ||
      element.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0"
    )
      return false;
    if (
      element instanceof HTMLDetailsElement &&
      !element.open &&
      !element.querySelector("summary")?.contains(target)
    )
      return false;
    if (element !== target) {
      const clip = element.getBoundingClientRect();
      if (
        (/(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflow}`) &&
          (box.left < clip.left || box.right > clip.right)) ||
        (/(hidden|clip|auto|scroll)/.test(`${style.overflowY} ${style.overflow}`) &&
          (box.top < clip.top || box.bottom > clip.bottom))
      )
        return false;
    }
  }
  return true;
};

const TutorialDialog = ({
  scope,
  title,
  slides,
  safetyNote,
  onDismiss,
}: {
  readonly scope: HTMLElement | null;
  readonly title: string;
  readonly slides: TutorialSlides;
  readonly safetyNote?: string;
  readonly onDismiss: () => void;
}) => {
  const { t } = useMessages(tutorialMessages);
  const fancy = useFancyFeatures();
  const [slide, setSlide] = useState(0);
  const [visible, setVisible] = useState(!document.hidden);
  const fullscreen = () =>
    document.fullscreenElement ??
    (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement ??
    document.body;
  const [mount, setMount] = useState(fullscreen);
  const dialog = useRef<HTMLDialogElement>(null);
  const callout = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  const current = slides[slide]!;
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    handAbove: boolean;
    target: { left: number; top: number; width: number; height: number } | null;
  } | null>(null);

  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    if (typeof modal.showModal === "function") modal.showModal();
    else modal.setAttribute("open", "");
    const updateVisibility = () => setVisible(!document.hidden);
    const updateFullscreen = () => setMount(fullscreen());
    document.addEventListener("visibilitychange", updateVisibility);
    document.addEventListener("fullscreenchange", updateFullscreen);
    document.addEventListener("webkitfullscreenchange", updateFullscreen);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      document.removeEventListener("fullscreenchange", updateFullscreen);
      document.removeEventListener("webkitfullscreenchange", updateFullscreen);
      if (modal.open && typeof modal.close === "function") modal.close();
      else modal.removeAttribute("open");
    };
  }, [mount]);

  useLayoutEffect(() => {
    const measure = () => {
      const bounds = dialog.current?.getBoundingClientRect();
      const width = bounds?.width || window.innerWidth;
      const height = bounds?.height || window.innerHeight;
      const target =
        current.forceExample || !current.target
          ? undefined
          : Array.from(scope?.querySelectorAll<HTMLElement>(current.target) ?? []).find((element) =>
              visibleTarget(element, width, height),
            );
      const box = target?.getBoundingClientRect();
      const card = callout.current?.getBoundingClientRect();
      const cw = card?.width || 340;
      const ch = card?.height || 280;
      const gap = 28;
      const inset = 16;
      let left = (width - cw) / 2;
      let top = (height - ch) / 2;
      if (box) {
        const centerX = box.left + box.width / 2;
        const centerY = box.top + box.height / 2;
        if (box.right + gap + cw <= width - inset) {
          left = box.right + gap;
          top = centerY - ch / 2;
        } else if (box.left - gap - cw >= inset) {
          left = box.left - gap - cw;
          top = centerY - ch / 2;
        } else {
          left = centerX - cw / 2;
          top = box.bottom + gap + ch <= height - inset ? box.bottom + gap : box.top - gap - ch;
        }
      }
      setPosition({
        left: Math.max(inset, Math.min(left, width - cw - inset)),
        top: Math.max(inset, Math.min(top, height - ch - inset)),
        handAbove: !!box && box.top + box.height / 2 + 110 > height,
        target: box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null,
      });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (callout.current) observer?.observe(callout.current);
    if (scope) {
      observer?.observe(scope);
      if (current.target)
        for (const target of scope.querySelectorAll(current.target)) observer?.observe(target);
    }
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    document.addEventListener("fullscreenchange", measure);
    document.addEventListener("webkitfullscreenchange", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      document.removeEventListener("fullscreenchange", measure);
      document.removeEventListener("webkitfullscreenchange", measure);
    };
  }, [scope, current, mount]);

  const dismiss = () => {
    // Close while connected so native focus return remains the browser's job.
    if (dialog.current?.open && typeof dialog.current.close === "function") dialog.current.close();
    onDismiss();
  };
  const gesture = (
    <div key={slide} className="role-tutorial-gesture" aria-hidden="true">
      <span className="role-tutorial-tap" />
      <svg className="role-tutorial-hand" viewBox="0 0 64 80" fill="none">
        <path d="M25 76C18 65 8 56 7 50c-1-5 4-8 8-5l8 8V11c0-9 11-9 11 0v26c0-8 11-8 11 0v4c1-7 10-6 10 1v4c1-6 8-4 8 3v11c0 7-4 12-7 16Z" />
        <path d="M34 36v16m11-11v14m10-9v12" />
      </svg>
      <span className="role-tutorial-tap-count">
        {current.gesture === "up"
          ? "↑"
          : current.gesture === "down"
            ? "↓"
            : current.gesture === "triple-tap"
              ? "3×"
              : "1×"}
      </span>
    </div>
  );
  return createPortal(
    <dialog
      ref={dialog}
      className="role-tutorial"
      data-animated={fancy && visible}
      data-gesture={current.gesture ?? "tap"}
      data-taps={current.gesture === "triple-tap" ? 3 : 1}
      aria-label={title}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClose={(event) => {
        // Ignore a queued cleanup close after StrictMode has reopened the dialog.
        if (event.currentTarget === dialog.current && !event.currentTarget.open) onDismiss();
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) {
          swipe.current = null;
          return;
        }
        if ((event.target as Element).closest("button")) return;
        swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerUp={(event) => {
        const start = swipe.current;
        swipe.current = null;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5)
          setSlide((value) => Math.max(0, Math.min(slides.length - 1, value + (dx < 0 ? 1 : -1))));
      }}
      onPointerCancel={() => {
        swipe.current = null;
      }}
      onLostPointerCapture={() => {
        swipe.current = null;
      }}
    >
      {position?.target && (
        <div
          className="role-tutorial-target"
          style={position.target}
          data-example="false"
          data-hand-above={position.handAbove}
          aria-hidden="true"
        >
          {gesture}
        </div>
      )}
      <section
        ref={callout}
        className="role-tutorial-callout"
        style={position ? { left: position.left, top: position.top } : undefined}
        aria-labelledby={titleId}
      >
        <header>
          <span className="role-tutorial-progress" aria-live="polite">
            {t("progress", { current: slide + 1, total: slides.length })}
          </span>
          <button
            type="button"
            className="role-tutorial-close"
            aria-label={t("close")}
            onClick={dismiss}
          >
            ×
          </button>
        </header>
        <div className="role-tutorial-copy" aria-live="polite">
          <h2 id={titleId}>{current.title}</h2>
          <p id={descriptionId}>{current.body}</p>
          {position && !position.target && (
            <div className="role-tutorial-example" role="img" aria-label={current.exampleLabel}>
              <span>{current.exampleLabel}</span>
              <strong aria-hidden="true">{current.exampleSymbol ?? "◇"}</strong>
              {gesture}
            </div>
          )}
          {position && !position.target && <p className="role-tutorial-note">{t("unavailable")}</p>}
          {current.note && <p className="role-tutorial-note">{current.note}</p>}
          <p className="role-tutorial-note">{safetyNote ?? t("harmless")}</p>
        </div>
        <footer>
          <button
            type="button"
            disabled={slide === 0}
            onClick={() => setSlide((value) => Math.max(0, value - 1))}
          >
            {t("back")}
          </button>
          <span className="role-tutorial-dots" aria-hidden="true">
            {slides.map((_, index) => (
              <i key={index} data-active={index === slide} />
            ))}
          </span>
          <button
            type="button"
            onClick={() =>
              slide === slides.length - 1 ? dismiss() : setSlide((value) => value + 1)
            }
          >
            {t(slide === slides.length - 1 ? "done" : "next")}
          </button>
        </footer>
        <small>{t("swipe")}</small>
      </section>
    </dialog>,
    mount,
  );
};
