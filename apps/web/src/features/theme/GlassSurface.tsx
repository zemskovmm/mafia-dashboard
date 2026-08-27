import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

export type GlassSurfaceTag = "article" | "aside" | "div" | "header" | "main" | "nav" | "section";

export const GLASS_SURFACE_RADIUS_BOUNDS = Object.freeze({ min: 1, max: 256 });

export interface GlassSurfaceProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  readonly as?: GlassSurfaceTag;
  readonly radius?: number;
  readonly specular?: boolean;
  readonly children?: ReactNode;
}

const joinClasses = (...classes: ReadonlyArray<string | undefined>): string =>
  classes.filter((className): className is string => Boolean(className)).join(" ");

export const GlassSurface = ({
  as: Tag = "div",
  radius = 20,
  specular = false,
  className,
  style,
  children,
  ...htmlProps
}: GlassSurfaceProps) => {
  const finiteRadius = Number.isFinite(radius) ? radius : GLASS_SURFACE_RADIUS_BOUNDS.min;
  const safeRadius = Math.min(
    GLASS_SURFACE_RADIUS_BOUNDS.max,
    Math.max(GLASS_SURFACE_RADIUS_BOUNDS.min, finiteRadius),
  );
  const glassStyle = {
    ...style,
    "--glass-radius": `${safeRadius}px`,
  } as CSSProperties;

  return (
    <Tag
      {...htmlProps}
      className={joinClasses("glass-surface", specular ? "is-specular" : undefined, className)}
      style={glassStyle}
    >
      {children}
    </Tag>
  );
};
