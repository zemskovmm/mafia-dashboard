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
});
