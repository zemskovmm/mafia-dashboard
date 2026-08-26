import { refractive } from "@hashintel/refractive";
import type { ComponentType, CSSProperties, HTMLAttributes, ReactNode } from "react";
import { sanitizeGlassSettings, type GlassSettings } from "./glass-settings.js";

export type GlassTheme = "midnight" | "malaga" | "malaga-glass";
export type GlassSurfaceTag = "article" | "aside" | "div" | "header" | "main" | "nav" | "section";

export const GLASS_SURFACE_RADIUS_BOUNDS = Object.freeze({ min: 1, max: 256 });

export interface GlassSurfaceProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  readonly as?: GlassSurfaceTag;
  readonly theme: GlassTheme;
  readonly supportsTrueRefraction: boolean;
  readonly settings: Readonly<GlassSettings>;
  readonly radius: number;
  readonly children?: ReactNode;
}

const joinClasses = (...classes: ReadonlyArray<string | undefined>): string =>
  classes.filter((className): className is string => Boolean(className)).join(" ");

type DocumentedRefractionSettings = {
  readonly radius: number;
  readonly blur: number;
  readonly glassThickness: number;
  readonly bezelWidth: number;
  readonly refractiveIndex: number;
  readonly specularOpacity: number;
  readonly specularAngle: number;
};

type RefractiveSurfaceProps = HTMLAttributes<HTMLElement> & {
  readonly refraction: DocumentedRefractionSettings;
};

export const GlassSurface = ({
  as: Tag = "div",
  theme,
  supportsTrueRefraction,
  settings,
  radius,
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
  const safeSettings = sanitizeGlassSettings(settings, safeRadius);
  const glassStyle: CSSProperties = { ...style };
  delete glassStyle.backdropFilter;
  delete glassStyle.WebkitBackdropFilter;
  const useTrueRefraction =
    theme === "malaga-glass" && supportsTrueRefraction && safeSettings.enabled;

  if (useTrueRefraction) {
    const RefractiveTag = refractive[Tag] as ComponentType<RefractiveSurfaceProps>;
    const refractiveStyle: CSSProperties = {
      ...glassStyle,
      borderRadius: `${safeRadius}px`,
    };

    return (
      <RefractiveTag
        {...htmlProps}
        className={joinClasses("glass-surface", "is-glass-refractive", className)}
        style={refractiveStyle}
        refraction={{
          radius: safeRadius,
          blur: safeSettings.blur,
          glassThickness: safeSettings.glassThickness,
          bezelWidth: Math.max(0, Math.min(safeSettings.bezelWidth, safeRadius - 1)),
          refractiveIndex: safeSettings.refractiveIndex,
          specularOpacity: safeSettings.specularOpacity,
          specularAngle: safeSettings.specularAngle,
        }}
      >
        {children}
      </RefractiveTag>
    );
  }

  if (theme === "malaga-glass") {
    const fallbackStyle = {
      ...glassStyle,
      borderRadius: `${safeRadius}px`,
      "--glass-fallback-opacity": String(safeSettings.enabled ? safeSettings.fallbackOpacity : 1),
      "--glass-fallback-blur": `${safeSettings.enabled ? safeSettings.blur : 0}px`,
    } as CSSProperties;

    return (
      <Tag
        {...htmlProps}
        className={joinClasses(
          "glass-surface",
          "is-glass-fallback",
          safeSettings.enabled ? undefined : "is-glass-disabled",
          className,
        )}
        style={fallbackStyle}
      >
        {children}
      </Tag>
    );
  }

  const plainStyle: CSSProperties = {
    ...style,
    borderRadius: `${safeRadius}px`,
  };

  return (
    <Tag
      {...htmlProps}
      className={joinClasses("glass-surface", "is-glass-plain", className)}
      style={plainStyle}
    >
      {children}
    </Tag>
  );
};
