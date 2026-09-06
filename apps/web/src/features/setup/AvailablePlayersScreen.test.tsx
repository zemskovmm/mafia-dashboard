import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PlayerProfile } from "../../api/client.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { AvailablePlayersScreen } from "./AvailablePlayersScreen.js";

const player = (id: string, nickname: string): PlayerProfile => ({
  id,
  nickname,
  consent: true,
  clubAccess: "none",
  managerLocked: false,
  firstName: null,
  lastName: null,
  email: null,
  consentAt: null,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  lastPlayedAt: null,
  statistics: {
    hostedGames: 0,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    redGames: 0,
    redWins: 0,
    blackGames: 0,
    blackWins: 0,
    sheriffGames: 0,
    citizenGames: 0,
    mafiaGames: 0,
    donGames: 0,
    totalFouls: 0,
    eliminations: 0,
    redCards: 0,
    bestMoves: 0,
    bestMoveMafiaHits: 0,
  },
});

const players = [
  player("00000000-0000-4000-8000-000000000001", "Alpha"),
  player("00000000-0000-4000-8000-000000000002", "Bravo"),
];

const Harness = ({
  onAvailabilityChange = vi.fn(),
  onClose = vi.fn(),
}: Readonly<{
  onAvailabilityChange?: (playerId: string, available: boolean) => void;
  onClose?: () => void;
}>) => {
  const [availablePlayerIds, setAvailablePlayerIds] = useState<ReadonlySet<string>>(new Set());
  return (
    <I18nProvider locale="en">
      <AvailablePlayersScreen
        players={players}
        availablePlayerIds={availablePlayerIds}
        onAvailabilityChange={(playerId, available) => {
          onAvailabilityChange(playerId, available);
          setAvailablePlayerIds((current) => {
            const next = new Set(current);
            if (available) next.add(playerId);
            else next.delete(playerId);
            return next;
          });
        }}
        onClose={onClose}
      />
    </I18nProvider>
  );
};

describe("AvailablePlayersScreen", () => {
  it("commits a binary card and icon state in the interaction render", async () => {
    const user = userEvent.setup();
    const onAvailabilityChange = vi.fn();
    render(<Harness onAvailabilityChange={onAvailabilityChange} />);

    const card = screen.getByRole("button", { name: "Mark Alpha available" });
    const icon = card.querySelector(".person-icon");
    expect(card).toHaveAttribute("aria-pressed", "false");
    expect(card).toHaveAttribute("data-availability-state", "unselected");
    expect(icon).toHaveAttribute("data-availability-state", "unselected");

    await user.click(card);

    const selectedCard = screen.getByRole("button", { name: "Mark Alpha unavailable" });
    expect(selectedCard).toHaveAttribute("aria-pressed", "true");
    expect(selectedCard).toHaveAttribute("data-availability-state", "selected");
    expect(selectedCard.querySelector(".person-icon")).toHaveAttribute(
      "data-availability-state",
      "selected",
    );
    expect(selectedCard).toHaveTextContent("Available");
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(players[0]!.id, true);

    await user.click(selectedCard);

    expect(screen.getByRole("button", { name: "Mark Alpha available" })).toHaveAttribute(
      "data-availability-state",
      "unselected",
    );
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(players[0]!.id, false);
  });

  it("applies rapid availability changes without leaving an intermediate selection state", async () => {
    const user = userEvent.setup();
    const onAvailabilityChange = vi.fn();
    render(<Harness onAvailabilityChange={onAvailabilityChange} />);

    await user.click(screen.getByRole("button", { name: "Mark Alpha available" }));
    await user.click(screen.getByRole("button", { name: "Mark Alpha unavailable" }));
    await user.click(screen.getByRole("button", { name: "Mark Alpha available" }));

    const card = screen.getByRole("button", { name: "Mark Alpha unavailable" });
    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(card).toHaveAttribute("data-availability-state", "selected");
    expect(onAvailabilityChange).toHaveBeenNthCalledWith(1, players[0]!.id, true);
    expect(onAvailabilityChange).toHaveBeenNthCalledWith(2, players[0]!.id, false);
    expect(onAvailabilityChange).toHaveBeenNthCalledWith(3, players[0]!.id, true);
  });

  it("preserves the search query while availability changes", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const search = screen.getByRole("searchbox", { name: "Search available players" });
    await user.type(search, "brav");
    await user.click(screen.getByRole("button", { name: "Mark Bravo available" }));

    expect(search).toHaveValue("brav");
    expect(screen.getByRole("button", { name: "Mark Bravo unavailable" })).toHaveAttribute(
      "data-availability-state",
      "selected",
    );
    expect(screen.queryByRole("button", { name: /mark alpha/i })).not.toBeInTheDocument();
  });

  it("keeps the close control available", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Close available players" }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
