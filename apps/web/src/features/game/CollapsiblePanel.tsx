import type { ReactNode } from "react";
import "./CollapsiblePanel.css";

/** Collapse only presentation: timer/player children retain their identity and state. */
export const CollapsiblePanel = ({
  expanded,
  id,
  className = "",
  children,
}: Readonly<{
  expanded: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}>) => (
  <div
    id={id}
    className={`panel-reveal ${className}`.trim()}
    data-expanded={expanded}
    aria-hidden={!expanded}
    inert={!expanded}
  >
    <div className="panel-reveal-content">{children}</div>
  </div>
);
