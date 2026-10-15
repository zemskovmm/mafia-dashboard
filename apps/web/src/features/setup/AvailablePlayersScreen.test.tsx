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
  roster = players,
  initialAvailableIds = [],
}: Readonly<{
  onAvailabilityChange?: (playerId: string, available: boolean) => void;
  onClose?: () => void;
  roster?: readonly PlayerProfile[];
  initialAvailableIds?: readonly string[];
}>) => {
  const [availablePlayerIds, setAvailablePlayerIds] = useState<ReadonlySet<string>>(
    () => new Set(initialAvailableIds),
  );
  return (
    <I18nProvider locale="en">
      <AvailablePlayersScreen
        players={roster}
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
  it("uses one shared decorative glass child on selected and unselected availability cards", async () => {
    const user = userEvent.setup();
    const onAvailabilityChange = vi.fn();
    const { container } = render(
      <Harness
        initialAvailableIds={[players[0]!.id]}
        onAvailabilityChange={onAvailabilityChange}
      />,
    );
    for (const card of screen.getAllByRole("button", { name: /^Mark / })) {
      expect(card).toHaveAttribute("data-player-glass", "availability");
      expect(card.firstElementChild).toHaveClass("liquid-card-glass");
      expect(card.firstElementChild).toHaveAttribute("aria-hidden", "true");
      expect(card.querySelectorAll(".liquid-card-glass")).toHaveLength(1);
    }
    expect(container.querySelectorAll("[data-player-glass]")).toHaveLength(2);
    const card = screen.getByRole("button", { name: "Mark Bravo available" });
    card.focus();
    await user.keyboard("{Enter}");
    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(card).toHaveAttribute("data-availability-state", "selected");
    expect(card.firstElementChild).toHaveClass("liquid-card-glass");
    expect(screen.getByText("2 available · 2 registered")).toBeInTheDocument();
    expect(onAvailabilityChange).toHaveBeenCalledExactlyOnceWith(players[1]!.id, true);
    await user.type(screen.getByRole("searchbox"), "brav");
    expect(container.querySelectorAll('[data-player-glass="availability"]')).toHaveLength(1);
    expect(card.querySelector(".seat-name")).not.toHaveAttribute("data-player-glass");
  });

  it("does not mount availability fire or lighting canvases before or after selection changes", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initialAvailableIds={[players[0]!.id]} />);
    expect(container.querySelector(".vgpu-player-lighting, canvas")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mark Alpha unavailable" }));
    await user.click(screen.getByRole("button", { name: "Mark Bravo available" }));
    expect(container.querySelector(".vgpu-player-lighting, canvas")).toBeNull();
    expect(screen.getByText("1 available · 2 registered")).toBeInTheDocument();
  });

  it("excludes only the synthetic ID from cards, search and counts, retaining a real Casper profile", async () => {
    const user = userEvent.setup();
    const onAvailabilityChange = vi.fn();
    const realCasper = player("00000000-0000-4000-8000-000000000003", "Casper");
    render(
      <Harness
        roster={[...players, player("casper", "Virtual Casper"), realCasper]}
        initialAvailableIds={[players[0]!.id, "casper", realCasper.id]}
        onAvailabilityChange={onAvailabilityChange}
      />,
    );

    expect(screen.getByText("2 available · 3 registered")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Mark .* unavailable$/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Mark Casper unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Virtual Casper/ })).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search available players" }), "virtual");
    expect(screen.getByText("No matching players")).toBeInTheDocument();
    expect(screen.getByText("2 available · 3 registered")).toBeInTheDocument();
    expect(onAvailabilityChange).not.toHaveBeenCalled();
    await user.clear(screen.getByRole("searchbox", { name: "Search available players" }));
    await user.click(screen.getByRole("button", { name: "Mark Casper unavailable" }));
    expect(onAvailabilityChange).toHaveBeenCalledWith(realCasper.id, false);
    expect(screen.getByText("1 available · 3 registered")).toBeInTheDocument();
  });

  it("treats a synthetic-only roster as empty despite its selected availability ID", () => {
    render(<Harness roster={[player("casper", "Casper")]} initialAvailableIds={["casper"]} />);
    expect(screen.getByText("0 available · 0 registered")).toBeInTheDocument();
    expect(screen.getByText("No matching players")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mark Casper/ })).not.toBeInTheDocument();
  });

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
