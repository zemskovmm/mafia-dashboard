export type HostView = "table" | "ledger";
export const HOST_VIEW_STORAGE_KEY = "mafia-dashboard.host-view.v1";

export const readHostView = (
  storage: () => Pick<Storage, "getItem"> = () => window.localStorage,
): HostView => {
  try {
    return storage().getItem(HOST_VIEW_STORAGE_KEY) === "ledger" ? "ledger" : "table";
  } catch {
    return "table";
  }
};

export const writeHostView = (
  view: HostView,
  storage: () => Pick<Storage, "setItem"> = () => window.localStorage,
): void => {
  try {
    storage().setItem(HOST_VIEW_STORAGE_KEY, view);
  } catch {
    // The view remains usable when the browser denies preference persistence.
  }
};
