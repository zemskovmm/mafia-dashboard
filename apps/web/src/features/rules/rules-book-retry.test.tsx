import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RulesBookHost } from "./RulesBookHost.js";

const load = vi.hoisted(() => vi.fn());
vi.mock("./rules-book-loading.js", () => ({
  loadRulesBookContent: load,
  prepareRulesBook: vi.fn(),
}));
afterEach(() => {
  load.mockReset();
  vi.restoreAllMocks();
});

describe("reader chunk retry", () => {
  it("opens a new host after another host fulfills the shared reader promise", async () => {
    const reader = Promise.resolve({
      default: () => <p role="status">Shared reader opened</p>,
    });
    load.mockReturnValue(reader);
    const first = render(<RulesBookHost open onClose={vi.fn()} />);
    expect(await screen.findByText("Shared reader opened")).toHaveAttribute("role", "status");
    first.unmount();

    // Opening a different host reuses the module, not the first lazy payload.
    render(<RulesBookHost open onClose={vi.fn()} />);
    expect(await screen.findByText("Shared reader opened")).toHaveAttribute("role", "status");
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.results[0]?.value).toBe(reader);
    expect(load.mock.results[1]?.value).toBe(reader);
  });

  it("retries a failed lazy reader only after the explicit retry action", async () => {
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    load.mockRejectedValueOnce(new Error("Reader unavailable")).mockResolvedValue({
      default: () => <p role="status">Reader recovered</p>,
    });
    render(<RulesBookHost open onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The book could not load");
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Reader recovered"));
    expect(load).toHaveBeenCalledTimes(2);
    errorOutput.mockRestore();
  });
});
