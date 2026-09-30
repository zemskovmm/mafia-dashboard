import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GameTable, type TableSeatView } from "./GameTable.js";

const seats: TableSeatView[] = Array.from({ length: 10 }, (_, index) => ({
  seat: index + 1,
  name: `Player ${index + 1}`,
}));

const ContextActionHarness = () => {
  const [swipedSeat, setSwipedSeat] = useState<number | null>(null);
  return (
    <GameTable
      seats={seats}
      onSeatSwipe={(seat) => setSwipedSeat((current) => (current === seat ? null : seat))}
      onDismissSwipeAction={() => setSwipedSeat(null)}
      swipeAction={
        swipedSeat === null ? undefined : (
          <button type="button" className="table-swipe-red-card">
            Red card Player {swipedSeat}
          </button>
        )
      }
    />
  );
};

describe("GameTable", () => {
  it("starts the ten-seat orbit at 198 degrees so seats 1 and 10 split the lower edge", () => {
    render(<GameTable seats={seats} hostName="Host Player" />);

    const playerCards = seats.map((seat, index) => {
      const card = screen.getByRole("button", { name: `Seat ${seat.seat}: ${seat.name}` });
      expect(card).toHaveTextContent(String(seat.seat));
      expect(card.parentElement).toHaveStyle({ "--seat-angle": `${198 + index * 36}deg` });
      return card;
    });

    expect(playerCards[0]!.parentElement).toHaveStyle({ "--seat-angle": "198deg" });
    expect(playerCards[9]!.parentElement).toHaveStyle({ "--seat-angle": "522deg" });
    expect(document.querySelectorAll(".seat-anchor")).toHaveLength(10);
    expect(playerCards).toHaveLength(10);
  });

  it("keeps player-seat click actions available on the ten-seat layout", () => {
    const onSeatClick = vi.fn();
    const onSeatSwipe = vi.fn();
    render(<GameTable seats={seats} onSeatClick={onSeatClick} onSeatSwipe={onSeatSwipe} />);

    fireEvent.click(screen.getByRole("button", { name: "Seat 7: Player 7" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Seat 9: Player 9" }), {
      key: "ContextMenu",
    });

    expect(onSeatClick).toHaveBeenCalledOnce();
    expect(onSeatClick).toHaveBeenCalledWith(7);
    expect(onSeatSwipe).toHaveBeenCalledOnce();
    expect(onSeatSwipe).toHaveBeenCalledWith(9);
  });

  it("prepares a V-GPU table surface for the default renderer request", () => {
    const { container } = render(<GameTable seats={seats} />);

    expect(container.querySelector(".round-table > .vgpu-table-lighting-host")).not.toBeNull();
  });

  it("keeps the nickname separate while player status pills wrap together", () => {
    render(
      <GameTable
        seats={seats.map((seat) =>
          seat.seat === 1 ? { ...seat, role: "citizen", fouls: 1, nominated: true } : seat,
        )}
      />,
    );

    const player = screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(player.querySelector(".seat-name")).toHaveTextContent("Player 1");
    const badges = player.querySelector(".seat-badges");
    expect(badges).toHaveTextContent("citizen");
    expect(badges).toHaveTextContent("Foul ×1");
    expect(badges).toHaveTextContent("Nominated");
  });

  it("maps game-state highlights into V-GPU player lighting surfaces", () => {
    render(
      <GameTable
        seats={seats.map((seat) =>
          seat.seat === 1
            ? { ...seat, current: true }
            : seat.seat === 2
              ? { ...seat, mafiaShooter: true }
              : seat.seat === 3
                ? { ...seat, sheriffHighlight: true }
                : seat.seat === 4
                  ? { ...seat, goodbyeHighlight: true }
                  : seat.seat === 5
                    ? { ...seat, votingHighlight: true }
                    : seat,
        )}
      />,
    );

    for (const seat of [1, 2, 3, 4, 5]) {
      expect(
        screen
          .getByRole("button", { name: `Seat ${seat}: Player ${seat}` })
          .querySelector(".vgpu-player-lighting"),
      ).not.toBeNull();
    }
  });

  it("suppresses role-only CSS and GPU lighting inputs when masked without hiding attention cues", () => {
    const roleSeats = seats.map((seat) =>
      seat.seat === 2
        ? { ...seat, role: "mafia" as const, mafiaShooter: true }
        : seat.seat === 3
          ? { ...seat, role: "sheriff" as const, sheriffHighlight: true }
          : seat.seat === 4
            ? { ...seat, votingHighlight: true, nominated: true }
            : seat,
    );
    const { rerender } = render(<GameTable seats={roleSeats} privacyHidden />);
    for (const seat of [2, 3]) {
      const card = screen.getByRole("button", { name: `Seat ${seat}: Player ${seat}` });
      expect(card).not.toHaveClass(seat === 2 ? "is-mafia-shooter" : "is-sheriff-highlight");
      expect(card.querySelector(".vgpu-player-lighting")).toBeNull();
      expect(card.querySelector(".role-badge")).toBeNull();
    }
    const attention = screen.getByRole("button", { name: "Seat 4: Player 4" });
    expect(attention).toHaveClass("is-voting-highlight");
    expect(attention.querySelector(".vgpu-player-lighting")).not.toBeNull();
    expect(attention).toHaveTextContent("Nominated");
    rerender(<GameTable seats={roleSeats} />);
    expect(screen.getByRole("button", { name: "Seat 2: Player 2" })).toHaveClass(
      "is-mafia-shooter",
    );
    expect(screen.getByRole("button", { name: "Seat 3: Player 3" })).toHaveClass(
      "is-sheriff-highlight",
    );
  });

  it("adds a visual cross to an eliminated player", () => {
    const { container } = render(
      <GameTable
        seats={seats.map((seat) => (seat.seat === 1 ? { ...seat, status: "eliminated" } : seat))}
      />,
    );

    expect(screen.getByRole("button", { name: "Seat 1: Player 1" })).toHaveClass(
      "status-eliminated",
    );
    expect(container.querySelector(".deceased-cross")).not.toBeNull();
  });

  it("keeps information in the center and a persistent advance control below it", () => {
    const { container, rerender } = render(
      <GameTable
        seats={seats}
        center={<strong>Phase information</strong>}
        advance={<button disabled>Resolve phase</button>}
      />,
    );

    expect(container.querySelector(".table-center")).toHaveTextContent("Phase information");
    expect(container.querySelector(".table-center button")).toBeNull();
    expect(container.querySelector(".table-advance")).toContainElement(
      screen.getByRole("button", { name: "Resolve phase" }),
    );
    expect(screen.getByRole("button", { name: "Resolve phase" })).toBeDisabled();

    rerender(<GameTable seats={seats} center={<strong>Waiting</strong>} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("shows a table action menu after horizontally swiping a player card", () => {
    const Harness = () => {
      const [swipedSeat, setSwipedSeat] = useState<number | null>(null);
      return (
        <GameTable
          seats={seats}
          onSeatSwipe={setSwipedSeat}
          swipeAction={
            swipedSeat === null ? undefined : (
              <button type="button" className="table-swipe-red-card">
                Red card Player {swipedSeat}
              </button>
            )
          }
        />
      );
    };
    render(<Harness />);
    const player = screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(screen.queryByRole("button", { name: "Red card Player 1" })).toBeNull();

    fireEvent.touchStart(player, { touches: [{ clientX: 10, clientY: 40 }] });
    fireEvent.touchEnd(player, { changedTouches: [{ clientX: 70, clientY: 42 }] });

    expect(screen.getByRole("button", { name: "Red card Player 1" })).toHaveClass(
      "table-swipe-red-card",
    );
    expect(screen.getByRole("button", { name: "Red card Player 1" }).parentElement).toHaveClass(
      "table-swipe-menu",
    );
  });

  it("intercepts outside interaction without activating a seat and allows reopening", () => {
    const onSeatClick = vi.fn();
    const Harness = () => {
      const [seat, setSeat] = useState<number | null>(null);
      return (
        <GameTable
          seats={seats}
          onSeatSwipe={setSeat}
          onSeatClick={onSeatClick}
          onDismissSwipeAction={() => setSeat(null)}
          swipeAction={seat === null ? undefined : <button>Red card Player {seat}</button>}
        />
      );
    };
    render(<Harness />);
    const first = screen.getByRole("button", { name: "Seat 1: Player 1" });
    fireEvent.keyDown(first, { key: "ContextMenu" });
    expect(screen.getByRole("button", { name: "Red card Player 1" })).toBeInTheDocument();
    const backdrop = document.querySelector(".table-swipe-backdrop");
    expect(backdrop).not.toBeNull();
    expect(backdrop?.parentElement).toBe(document.body);
    expect(first.closest(".table-stage")).toHaveClass("is-context-action-open");
    fireEvent.click(backdrop!);
    expect(screen.queryByRole("button", { name: "Red card Player 1" })).toBeNull();
    expect(onSeatClick).not.toHaveBeenCalled();
    expect(document.querySelector(".table-swipe-backdrop")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Seat 2: Player 2" }), {
      key: "ContextMenu",
    });
    expect(screen.getByRole("button", { name: "Red card Player 2" })).toBeInTheDocument();
  });

  it("opens a seat context action with Shift+F10 and focuses its first control", async () => {
    render(<ContextActionHarness />);
    const player = screen.getByRole("button", { name: "Seat 1: Player 1" });
    player.focus();

    fireEvent.keyDown(player, { key: "F10", shiftKey: true });

    const action = screen.getByRole("button", { name: "Red card Player 1" });
    await waitFor(() => expect(action).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Player actions" })).toContainElement(action);
    expect(player).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("closes a keyboard-opened seat context action with Escape and restores seat focus", async () => {
    render(<ContextActionHarness />);
    const player = screen.getByRole("button", { name: "Seat 1: Player 1" });
    player.focus();
    fireEvent.keyDown(player, { key: "ContextMenu" });
    const action = screen.getByRole("button", { name: "Red card Player 1" });
    await waitFor(() => expect(action).toHaveFocus());

    fireEvent.keyDown(action, { key: "Escape" });

    await waitFor(() => expect(player).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Red card Player 1" })).toBeNull();
  });

  it.each([
    ["eliminated", { status: "eliminated" as const }],
    ["otherwise inactive", { inactive: true }],
  ])("does not advertise or open context actions for %s seats", (_, state) => {
    const onSeatSwipe = vi.fn();
    render(
      <GameTable
        seats={seats.map((seat) => (seat.seat === 1 ? { ...seat, ...state } : seat))}
        onSeatSwipe={onSeatSwipe}
      />,
    );
    const player = screen.getByRole("button", { name: "Seat 1: Player 1" });

    expect(player).not.toHaveAttribute("aria-haspopup");
    fireEvent.keyDown(player, { key: "F10", shiftKey: true });
    expect(onSeatSwipe).not.toHaveBeenCalled();
  });
});
