interface PrearmGuard {
  readonly transitioning: boolean;
  readonly activeDeck: "a" | "b";
  readonly prearmDeck: "a" | "b";
}

export const shouldStopPrearmedDeck = ({
  transitioning,
  activeDeck,
  prearmDeck,
}: PrearmGuard): boolean => !transitioning && activeDeck === prearmDeck;
