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
  className = "",
}: {
  readonly title: string;
  readonly closeLabel: string;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
  readonly active?: boolean;
  readonly suspended?: boolean;
  readonly className?: string;
}) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !active) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else {
      dialog.setAttribute("open", "");
    }
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
  }, [active]);
  return createPortal(
    <dialog
      ref={ref}
      className={`federation-judge-dialog ${className}`}
      aria-labelledby={titleId}
      inert={suspended}
      aria-hidden={suspended || undefined}
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
