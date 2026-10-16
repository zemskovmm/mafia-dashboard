import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Native modal focus containment and Escape; a minimal fallback supports jsdom. */
export const FederationJudgeDialog = ({
  title,
  closeLabel,
  onDismiss,
  children,
  active = true,
  suspended = false,
  returnFocus,
  className = "",
}: {
  readonly title: string;
  readonly closeLabel: string;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
  readonly active?: boolean;
  readonly suspended?: boolean;
  readonly returnFocus?: HTMLElement | null;
  readonly className?: string;
}) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !active) return;
    const previousFocus =
      returnFocus ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);

    if (typeof dialog.showModal === "function") dialog.showModal();
    else {
      dialog.setAttribute("open", "");
      dialog.querySelector<HTMLButtonElement>("button")?.focus();
    }
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active, returnFocus]);
  return createPortal(
    <dialog
      ref={ref}
      className={`federation-judge-dialog ${className}`}
      aria-labelledby={titleId}
      inert={suspended}
      aria-hidden={suspended || undefined}
      onKeyDown={(event) => {
        if (suspended) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']",
          ),
        ];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!suspended) onDismiss();
      }}
    >
      <header>
        <strong id={titleId}>{title}</strong>
        <button type="button" onClick={onDismiss}>
          {closeLabel}
        </button>
      </header>
      {children}
    </dialog>,
    document.body,
  );
};
