import { useEffect, useRef } from "react";
import { createFiniteGlassSweep } from "./finite-glass-sweep.js";
import "./LiquidCardGlass.css";
import "./ActivationGlassSweep.css";

/** Native click covers pointer and keyboard once, without authoring either. */
export const ActivationGlassSweep = ({ disabled = false }: { readonly disabled?: boolean }) => {
  const surfaceRef = useRef<HTMLSpanElement>(null);
  const lightRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const host = surfaceRef.current?.parentElement;
    const light = lightRef.current;
    if (disabled || host == null || light === null) return;
    const { sweep, dispose } = createFiniteGlassSweep(host, light);
    host.addEventListener("click", sweep, { passive: true });
    return () => {
      host.removeEventListener("click", sweep);
      dispose();
    };
  }, [disabled]);

  return (
    <span ref={surfaceRef} className="activation-glass-sweep" aria-hidden="true">
      <span className="liquid-card-glass__caustics" aria-hidden="true">
        <span ref={lightRef} className="liquid-card-glass__light" aria-hidden="true" />
      </span>
    </span>
  );
};
