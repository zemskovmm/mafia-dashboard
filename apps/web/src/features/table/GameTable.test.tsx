import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GameTable, type TableSeatView } from "./GameTable.js";

const seats: TableSeatView[] = Array.from({ length: 10 }, (_, index) => ({
  seat: index + 1,
  name: `Player ${index + 1}`,
}));

describe("GameTable", () => {
  it("places the host and ten players in eleven equally spaced circular slots", () => {
    render(<GameTable seats={seats} hostName="Host Player" />);

    const seatOneAnchor = screen.getByRole("button", { name: "Seat 1: Player 1" }).parentElement;
    const hostAnchor = screen.getByRole("group", { name: "Host: Host Player" }).parentElement;

    expect(hostAnchor).toHaveStyle({ "--seat-angle": "180deg" });
    expect(seatOneAnchor).toHaveStyle({ "--seat-angle": `${180 + 360 / 11}deg` });
  });

  it("uses the same card footprint for host and players", () => {
    render(<GameTable seats={seats} hostName="Host Player" />);

    expect(screen.getByRole("group", { name: "Host: Host Player" })).toHaveClass("table-card");
    expect(screen.getByRole("button", { name: "Seat 1: Player 1" })).toHaveClass("table-card");
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
});
