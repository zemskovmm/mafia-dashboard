import { useMessages } from "../../i18n/I18nProvider.js";
import { setupMessages } from "../../i18n/messages/setup.js";
import { ScreenTutorial, type TutorialSlide } from "../tutorial/ScreenTutorial.js";
import "./RoleGiveawayTutorial.css";

interface TutorialSeat {
  readonly seat: number;
  readonly dealt: boolean;
}

export const RoleGiveawayTutorial = ({
  seats,
  continueLabel,
  onVisibilityChange,
}: {
  readonly seats: readonly TutorialSeat[];
  readonly continueLabel: string;
  readonly onVisibilityChange: () => void;
}) => {
  const { t } = useMessages(setupMessages);
  const undealt = seats.find(({ dealt }) => !dealt);
  const dealt = seats.find(({ dealt }) => dealt);
  const slides: readonly TutorialSlide[] = [
    {
      title: t("tutorial.revealTitle"),
      body: t("tutorial.revealBody"),
      target: undealt ? `.seat-anchor[data-seat="${undealt.seat}"] .table-card` : undefined,
      forceExample: !undealt,
      exampleLabel: t("tutorial.exampleUndealt"),
      exampleSymbol: "?",
    },
    {
      title: t("tutorial.rerollTitle"),
      body: t("tutorial.rerollBody"),
      note: t("tutorial.rerollNote"),
      target: undealt && dealt ? `.seat-anchor[data-seat="${dealt.seat}"] .table-card` : undefined,
      forceExample: !undealt || !dealt,
      gesture: "triple-tap",
      exampleLabel: t("tutorial.exampleDealt"),
      exampleSymbol: "◆",
    },
    {
      title: t("tutorial.readyTitle"),
      body: t("tutorial.readyBody", { action: continueLabel }),
      target: ".table-advance button",
      exampleLabel: continueLabel,
      exampleSymbol: "→",
    },
  ];
  return (
    <ScreenTutorial
      helpLabel={t("tutorial.help")}
      title={t("tutorial.title")}
      slides={slides}
      safetyNote={t("tutorial.demoNote")}
      onVisibilityChange={onVisibilityChange}
    />
  );
};
