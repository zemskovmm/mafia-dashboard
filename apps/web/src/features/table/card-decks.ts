import classic01 from "../../assets/player-cards/classic/face-01.svg?no-inline";
import classic02 from "../../assets/player-cards/classic/face-02.svg?no-inline";
import classic03 from "../../assets/player-cards/classic/face-03.svg?no-inline";
import classic04 from "../../assets/player-cards/classic/face-04.svg?no-inline";
import classic05 from "../../assets/player-cards/classic/face-05.svg?no-inline";
import classic06 from "../../assets/player-cards/classic/face-06.svg?no-inline";
import classic07 from "../../assets/player-cards/classic/face-07.svg?no-inline";
import classic08 from "../../assets/player-cards/classic/face-08.svg?no-inline";
import classic09 from "../../assets/player-cards/classic/face-09.svg?no-inline";
import classic10 from "../../assets/player-cards/classic/face-10.svg?no-inline";
import classicBack from "../../assets/player-cards/classic/back.svg?no-inline";
import heritage01 from "../../assets/player-cards/heritage/face-01.svg?no-inline";
import heritage02 from "../../assets/player-cards/heritage/face-02.svg?no-inline";
import heritage03 from "../../assets/player-cards/heritage/face-03.svg?no-inline";
import heritage04 from "../../assets/player-cards/heritage/face-04.svg?no-inline";
import heritage05 from "../../assets/player-cards/heritage/face-05.svg?no-inline";
import heritage06 from "../../assets/player-cards/heritage/face-06.svg?no-inline";
import heritage07 from "../../assets/player-cards/heritage/face-07.svg?no-inline";
import heritage08 from "../../assets/player-cards/heritage/face-08.svg?no-inline";
import heritage09 from "../../assets/player-cards/heritage/face-09.svg?no-inline";
import heritage10 from "../../assets/player-cards/heritage/face-10.svg?no-inline";
import heritageBack from "../../assets/player-cards/heritage/back.svg?no-inline";
import noir01 from "../../assets/player-cards/noir/face-01.svg?no-inline";
import noir02 from "../../assets/player-cards/noir/face-02.svg?no-inline";
import noir03 from "../../assets/player-cards/noir/face-03.svg?no-inline";
import noir04 from "../../assets/player-cards/noir/face-04.svg?no-inline";
import noir05 from "../../assets/player-cards/noir/face-05.svg?no-inline";
import noir06 from "../../assets/player-cards/noir/face-06.svg?no-inline";
import noir07 from "../../assets/player-cards/noir/face-07.svg?no-inline";
import noir08 from "../../assets/player-cards/noir/face-08.svg?no-inline";
import noir09 from "../../assets/player-cards/noir/face-09.svg?no-inline";
import noir10 from "../../assets/player-cards/noir/face-10.svg?no-inline";
import noirBack from "../../assets/player-cards/noir/back.svg?no-inline";
import type { PrintedCardStyle } from "../theme/player-card-preferences.js";

// Explicit imports are the complete allowlist. no-inline keeps even small replacements
// as independently cache-busted Vite assets, rather than embedding SVG in the JS bundle.
const decks = {
  classic: {
    faces: [
      classic01,
      classic02,
      classic03,
      classic04,
      classic05,
      classic06,
      classic07,
      classic08,
      classic09,
      classic10,
    ],
    back: classicBack,
  },
  heritage: {
    faces: [
      heritage01,
      heritage02,
      heritage03,
      heritage04,
      heritage05,
      heritage06,
      heritage07,
      heritage08,
      heritage09,
      heritage10,
    ],
    back: heritageBack,
  },
  noir: {
    faces: [noir01, noir02, noir03, noir04, noir05, noir06, noir07, noir08, noir09, noir10],
    back: noirBack,
  },
} as const satisfies Record<
  PrintedCardStyle,
  { readonly faces: readonly string[]; readonly back: string }
>;

/** Decorative artwork is keyed only by printed style and the public seat number. */
export function getCardArtwork(
  style: PrintedCardStyle,
  seat: number,
): { readonly front: string; readonly back: string } {
  const deck = decks[style];
  const front =
    Number.isInteger(seat) && seat >= 1 && seat <= 10 ? deck.faces[seat - 1] : undefined;
  return { front: front ?? deck.back, back: deck.back };
}
