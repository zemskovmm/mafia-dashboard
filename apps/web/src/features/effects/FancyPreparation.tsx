import { useMessages } from "../../i18n/I18nProvider.js";
import { fancyStuffMessages } from "../../i18n/messages/fancy-stuff.js";
import type { FancyPreparationStatus } from "./useFancyPreparation.js";

export const FancyPreparation = ({
  status,
  startup,
  onContinue,
  onRetry,
}: {
  readonly status: FancyPreparationStatus;
  readonly startup: boolean;
  readonly onContinue: () => void;
  readonly onRetry: () => void;
}) => {
  const { t } = useMessages(fancyStuffMessages);
  if (status !== "preparing" && status !== "fallback") return null;
  return (
    <section
      className={`fancy-preparation fancy-preparation--${startup ? "startup" : "inline"}`}
      aria-label={t("section")}
      data-preparation={status}
    >
      {startup ? <strong>La Verdad</strong> : null}
      <p role="status">{t(status === "preparing" ? "preparing" : "failed")}</p>
      {status === "preparing" ? (
        <button type="button" onClick={onContinue}>
          {t("continue")}
        </button>
      ) : (
        <button type="button" onClick={onRetry}>
          {t("retry")}
        </button>
      )}
    </section>
  );
};
