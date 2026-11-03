import { Circle, TableProperties } from "lucide-react";
import { useMessages } from "../../i18n/I18nProvider.js";
import { ledgerMessages } from "../../i18n/messages/ledger.js";
import type { HostView } from "./host-view-preferences.js";

export const HostViewSwitch = ({
  view,
  onChange,
}: {
  readonly view: HostView;
  readonly onChange: (view: HostView) => void;
}) => {
  const { t } = useMessages(ledgerMessages);
  return (
    <div className="host-view-switch" role="group" aria-label={t("view")}>
      <button type="button" aria-pressed={view === "table"} onClick={() => onChange("table")}>
        <Circle aria-hidden="true" />
        {t("table")}
      </button>
      <button type="button" aria-pressed={view === "ledger"} onClick={() => onChange("ledger")}>
        <TableProperties aria-hidden="true" />
        {t("ledger")}
      </button>
    </div>
  );
};
