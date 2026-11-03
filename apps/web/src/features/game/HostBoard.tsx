import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { GameTable } from "../table/GameTable.js";
import { GameLedger } from "../ledger/GameLedger.js";
import type { LedgerModel } from "../ledger/ledger-types.js";
import type { HostView } from "./host-view-preferences.js";

export type HostBoardProps = ComponentProps<typeof GameTable> & {
  readonly phaseTools?: ReactNode;
};
export interface LedgerScrollPosition {
  left: number;
  top: number;
}
export const HostPresentationContext = createContext<{
  readonly view: HostView;
  readonly ledger: LedgerModel | null;
  readonly currentPeriod: "day" | "night" | null;
  readonly scroll?: RefObject<LedgerScrollPosition>;
  readonly controlsTarget?: HTMLDivElement | null;
}>({ view: "table", ledger: null, currentPeriod: null });

/** Only the renderer changes; its phase controller and action owners stay mounted. */
export const HostBoard = ({ phaseTools, ...props }: HostBoardProps) => {
  const { view, ledger, currentPeriod, scroll, controlsTarget } =
    useContext(HostPresentationContext);
  return view === "ledger" && ledger !== null ? (
    <GameLedger
      {...props}
      model={ledger}
      currentPeriod={currentPeriod}
      scrollPosition={scroll}
      controlsTarget={controlsTarget}
      phaseTools={phaseTools}
    />
  ) : (
    <>
      <GameTable {...props} />
      {phaseTools}
    </>
  );
};
