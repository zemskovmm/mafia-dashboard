import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";
import {
  backgroundAsset,
  isCityBackground,
  readBackground,
  validateBackground,
  writeBackground,
  type BackgroundId,
} from "./background-preferences.js";
import "./AppBackground.css";

const BackgroundContext = createContext<{
  background: BackgroundId;
  changeBackground: (background: BackgroundId) => void;
  reloadBackground: () => void;
} | null>(null);

export const useAppBackground = () => {
  const context = useContext(BackgroundContext);
  if (context === null) throw new Error("Missing application background provider");
  return context;
};

const BackgroundOwner = ({ children }: { readonly children: ReactNode }) => {
  const [background, setBackground] = useState(readBackground);
  const asset = backgroundAsset(background);
  return (
    <BackgroundContext.Provider
      value={{
        background,
        changeBackground: (value) => {
          const next = validateBackground(value);
          setBackground(next);
          writeBackground(next);
        },
        reloadBackground: () => setBackground(readBackground()),
      }}
    >
      <div
        className="app-background-root"
        data-background={background}
        data-background-kind={isCityBackground(background) ? "city" : "plain"}
        style={
          { "--app-background-image": asset === null ? "none" : `url("${asset}")` } as CSSProperties
        }
      >
        <div className="app-background" aria-hidden="true" />
        {children}
      </div>
    </BackgroundContext.Provider>
  );
};

// App owns the preference across club entry/exit. The exported workspace also
// works standalone in the existing fixtures, without a second owner when nested.
export const AppBackgroundProvider = ({ children }: { readonly children: ReactNode }) =>
  useContext(BackgroundContext) === null ? <BackgroundOwner>{children}</BackgroundOwner> : children;
