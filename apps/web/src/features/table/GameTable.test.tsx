import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GameTable, type TableSeatView } from "./GameTable.js";

const seats: TableSeatView[] = Array.from({ length: 10 }, (_, index) => ({
  seat: index + 1,
  name: `Player ${index + 1}`,
}));

describe("GameTable", () => {
  it("places seat 1 in the table position immediately left of the host", () => {
    render(<GameTable seats={seats} />);

    const seatOneAnchor = screen.getByRole("button", { name: "Seat 1: Player 1" }).parentElement;

    expect(seatOneAnchor).toHaveStyle({ "--seat-angle": "198deg" });
  });
});
