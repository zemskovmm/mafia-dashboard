import { useMessages } from "../../i18n/I18nProvider.js";
import { tutorialMessages, type TutorialMessageKey } from "../../i18n/messages/tutorial.js";
import { ScreenTutorial, type TutorialSlide } from "./ScreenTutorial.js";

// Only presentation/eligibility crosses this boundary: no roles, identities,
// assignments, private answers, GameState, or gameplay callbacks.
export type GameTutorialPhase =
  | "day"
  | "voting"
  | "car-crash"
  | "car-crash-decision"
  | "voting-cancelled"
  | "car-crash-skipped"
  | "car-crash-result"
  | "mafia-planning"
  | "mafia-sleep"
  | "don-identification"
  | "sheriff-identification"
  | "free-seating"
  | "night-mafia"
  | "night-mafia-result"
  | "night-don"
  | "night-don-result"
  | "night-sheriff"
  | "night-sheriff-result"
  | "night-resolution";

const supported: ReadonlySet<string> = new Set<GameTutorialPhase>([
  "day",
  "voting",
  "car-crash",
  "car-crash-decision",
  "voting-cancelled",
  "car-crash-skipped",
  "car-crash-result",
  "mafia-planning",
  "mafia-sleep",
  "don-identification",
  "sheriff-identification",
  "free-seating",
  "night-mafia",
  "night-mafia-result",
  "night-don",
  "night-don-result",
  "night-sheriff",
  "night-sheriff-result",
  "night-resolution",
]);
export const isGameTutorialPhase = (phase: string): phase is GameTutorialPhase =>
  supported.has(phase);

export const GameTutorial = ({
  phase,
  advanceLabel = "",
  nominationAvailable = true,
  foulAvailable = true,
  penaltyAvailable = true,
  checkAvailable = true,
  ballotPaused = false,
}: {
  readonly phase: GameTutorialPhase;
  readonly advanceLabel?: string;
  readonly nominationAvailable?: boolean;
  readonly foulAvailable?: boolean;
  readonly penaltyAvailable?: boolean;
  readonly checkAvailable?: boolean;
  readonly ballotPaused?: boolean;
}) => {
  const { t } = useMessages(tutorialMessages);
  const category =
    phase === "day"
      ? "day"
      : phase === "voting" || phase.startsWith("car-crash") || phase === "voting-cancelled"
        ? "voting"
        : "night";
  const card = ".table-card";
  const activeCard = ".table-card.status-active";
  const advance = ".table-advance button";
  const slide = (
    title: TutorialMessageKey,
    body: TutorialMessageKey,
    target = advance,
    example: TutorialMessageKey = "exampleAction",
    extra: Partial<TutorialSlide> = {},
  ): TutorialSlide => ({
    title: t(title),
    body: t(body, { action: advanceLabel }),
    target,
    exampleLabel: t(example),
    ...extra,
  });
  const getSlides = (scope: HTMLElement | null): readonly TutorialSlide[] => {
    switch (phase) {
      case "day":
        return [
          slide(
            "dayTapTitle",
            nominationAvailable ? "dayTapBody" : "dayTapUnavailable",
            activeCard,
            "exampleCard",
            { forceExample: !nominationAvailable },
          ),
          slide(
            "foulTitle",
            foulAvailable ? "foulBody" : "foulUnavailable",
            activeCard,
            "exampleCard",
            { gesture: "down", forceExample: !foulAvailable },
          ),
          slide(
            "penaltyTitle",
            penaltyAvailable ? "penaltyBody" : "penaltyUnavailable",
            card,
            "exampleCard",
            { gesture: "up", forceExample: !penaltyAvailable },
          ),
          slide("advanceTitle", "advanceBody"),
        ];
      case "voting":
        return ballotPaused
          ? [
              slide(
                "disputeTitle",
                "disputeBody",
                ".federation-ballot-tools summary",
                "exampleAction",
              ),
            ]
          : [
              slide(
                "nomineeTitle",
                "nomineeBody",
                ".nomination-panel .nomination-row-target",
                "exampleNominee",
              ),
              slide("voteTitle", "voteBody", card, "exampleCard"),
              slide("candidateTitle", "candidateBody", "[data-tutorial-action='next-candidate']"),
              slide("finishTitle", "finishBody", "[data-tutorial-action='finish-voting']"),
            ];
      case "car-crash":
        return [slide("tieTitle", "tieBody")];
      case "car-crash-decision":
        return [
          slide("collectiveTitle", "collectiveBody", card, "exampleCard"),
          slide(
            "correctionTitle",
            "correctionBody",
            ".federation-ballot-tools select",
            "exampleCorrection",
            { exampleSymbol: "✓ / × / —" },
          ),
          slide("collectiveFinishTitle", "collectiveFinishBody"),
        ];
      case "voting-cancelled":
        return [slide("cancelledTitle", "cancelledBody")];
      case "car-crash-skipped":
        return [slide("skippedTitle", "skippedBody")];
      case "car-crash-result":
        return [slide("ballotResultTitle", "ballotResultBody")];
      case "mafia-planning":
        return [slide("planningTitle", "planningBody")];
      case "mafia-sleep":
        return [slide("sleepTitle", "sleepBody")];
      case "don-identification":
        return [slide("openingTitle", "openingBody")];
      case "sheriff-identification":
        return [slide("greetingTitle", "greetingBody")];
      case "free-seating":
        return [slide("zeroTitle", "zeroBody")];
      case "night-mafia": {
        // This public presentation flag belongs to NightStage, not the game record.
        // Read it when manually opening; never toggle it to illustrate a slide.
        const observing =
          scope
            ?.querySelector(".federation-shooting-observation button")
            ?.getAttribute("aria-pressed") === "true";
        return [
          slide(
            observing ? "observationTitle" : "shotsTitle",
            observing ? "observationBody" : "shotsBody",
            card,
            "exampleCard",
          ),
          slide(
            "observationToggleTitle",
            "observationToggleBody",
            ".federation-shooting-observation button",
            "exampleObservation",
          ),
          slide("evaluateTitle", "evaluateBody"),
        ];
      }
      case "night-mafia-result":
        return [slide("shootingResultTitle", "shootingResultBody")];
      case "night-don":
      case "night-sheriff":
        return [
          slide(
            checkAvailable
              ? phase === "night-don"
                ? "donTitle"
                : "sheriffTitle"
              : "checkUnavailableTitle",
            checkAvailable
              ? phase === "night-don"
                ? "donBody"
                : "sheriffBody"
              : "checkUnavailableBody",
            card,
            "exampleCard",
            { forceExample: !checkAvailable },
          ),
          slide("skipTitle", "skipBody", ".table-advance-secondary"),
        ];
      case "night-don-result":
        return [slide("privateTitle", "privateBody")];
      case "night-sheriff-result":
        return [slide("privateTitle", "sheriffResultBody")];
      case "night-resolution":
        return [slide("resolutionTitle", "resolutionBody")];
    }
  };
  return (
    <ScreenTutorial
      helpLabel={t(`${category}Help`)}
      title={t(`${category}Title`)}
      slides={getSlides}
    />
  );
};
