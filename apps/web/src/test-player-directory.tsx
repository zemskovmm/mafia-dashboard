import { render as renderView } from "@testing-library/react";
import { CASPER_PLAYER_ID } from "@mafia/game-domain";
import { PlayerDirectoryProvider, type DisplayProfile } from "./features/players/player-display.js";

// These names belong to the test presentation directory, never to canonical games.
export const playerLabel = ({ seat }: { readonly seat: number }): string => `Player ${seat}`;

export const namedProfiles = (prefix: string): readonly DisplayProfile[] =>
  Array.from({ length: 10 }, (_, index) => ({
    id: `${prefix}${index + 1}`,
    nickname: `Player ${index + 1}`,
  })).filter(({ id }) => id !== CASPER_PLAYER_ID);

export const renderWithProfiles = (
  ui: Parameters<typeof renderView>[0],
  profiles: readonly DisplayProfile[],
  options?: Parameters<typeof renderView>[1],
): ReturnType<typeof renderView> => {
  const wrapped = (view: Parameters<typeof renderView>[0]) => (
    <PlayerDirectoryProvider profiles={profiles}>{view}</PlayerDirectoryProvider>
  );
  const result = renderView(wrapped(ui), options);
  return { ...result, rerender: (view) => result.rerender(wrapped(view)) };
};
