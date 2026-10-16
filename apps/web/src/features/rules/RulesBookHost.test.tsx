import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RulesBookHost } from "./RulesBookHost.js";

const load = vi.hoisted(() => ({ calls: 0, reject: null as null | ((error: Error) => void) }));
vi.mock("./RulesBookContent.js", () => {
  load.calls++;
  return new Promise((_resolve, reject) => {
    load.reject = reject;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("lazy rules-book boundary", () => {
  it("does not load while closed and preserves the invoking form through a dismissible load failure", async () => {
    const Harness = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <label>
            Unfinished reason
            <input defaultValue="Keep this note" />
          </label>
          <button onClick={() => setOpen(true)}>Read rules</button>
          <RulesBookHost open={open} onClose={() => setOpen(false)} />
        </>
      );
    };
    const user = userEvent.setup();
    render(<Harness />);
    expect(load.calls).toBe(0);
    const invoke = screen.getByRole("button", { name: "Read rules" });
    await user.click(invoke);
    expect(screen.getByRole("status")).toHaveTextContent("Opening the book");
    await waitFor(() => expect(load.reject).not.toBeNull());
    const errorOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    load.reject!(new Error("Simulated unavailable reader chunk"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The book could not load");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invoke).toHaveFocus();
    expect(screen.getByLabelText("Unfinished reason")).toHaveValue("Keep this note");
    errorOutput.mockRestore();
  });
});
