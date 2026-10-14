import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FederationJudgeDialog } from "./FederationJudgeDialog.js";

const Harness = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open judge form
      </button>
      {open ? (
        <FederationJudgeDialog
          title="Judge form"
          closeLabel="Close"
          onDismiss={() => setOpen(false)}
        >
          <label>
            Reason
            <input />
          </label>
          <button type="button" disabled>
            Confirm
          </button>
        </FederationJudgeDialog>
      ) : null}
    </>
  );
};

describe("FederationJudgeDialog", () => {
  it("contains forward and reverse keyboard focus without disabled controls becoming tab stops", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open judge form" }));
    expect(screen.getByRole("dialog", { name: "Judge form" })).toBeInTheDocument();
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it("restores the invoking control after an Escape/cancel dismissal", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const invoke = screen.getByRole("button", { name: "Open judge form" });
    await user.click(invoke);
    screen.getByRole("textbox", { name: "Reason" }).focus();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invoke).toHaveFocus();
  });
});
