import { useMessages } from "../../i18n/I18nProvider.js";
import { setupMessages } from "../../i18n/messages/setup.js";

export type ClubDeviationAcknowledgement = "casper" | "best-move-disabled" | "role-reroll";

export const FederationRulesNotice = ({
  federation,
  clubDeviationsAcknowledged = [],
}: {
  readonly federation: boolean;
  readonly clubDeviationsAcknowledged?: readonly ClubDeviationAcknowledgement[];
}) => {
  const { t } = useMessages(setupMessages);
  if (!federation || clubDeviationsAcknowledged.length === 0) return null;
  return (
    <div className="federation-rules-notice" role="group" aria-label={t("setup.deviations.title")}>
      <details>
        <summary>{t("setup.deviations.title")}</summary>
        <ul>
          {[...new Set(clubDeviationsAcknowledged)].map((deviation) => (
            <li key={deviation}>{t(`setup.deviations.${deviation}`)}</li>
          ))}
        </ul>
      </details>
    </div>
  );
};
