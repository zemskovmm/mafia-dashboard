import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FederationJudgeDialog } from "./FederationJudgeDialog.js";
import { cancelDialog } from "../../test-card-gestures.js";

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
  it("does not author autofocus, key dismissal or a Tab trap", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const invoke = screen.getByRole("button", { name: "Open judge form" });
    await user.click(invoke);
    const dialog = screen.getByRole("dialog", { name: "Judge form" });
    // jsdom's fallback must not imitate native focus containment.
    expect(invoke).toHaveFocus();
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    for (const init of [{ key: "Tab" }, { key: "Tab", shiftKey: true }, { key: "Escape" }]) {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      fireEvent(dialog, event);
      expect(event.defaultPrevented).toBe(false);
      expect(close).toHaveFocus();
    }
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("synchronizes native cancel with React state without scripted restoration", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open judge form" }));
    screen.getByRole("textbox", { name: "Reason" }).focus();
    cancelDialog(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Open judge form" })).not.toHaveFocus();
  });

  it("keeps native showModal, suspension, cancel synchronization and lifecycle cleanup", () => {
    const dismiss = vi.fn();
    const showModal = vi
      .spyOn(HTMLDialogElement.prototype, "showModal")
      .mockImplementation(function (this: HTMLDialogElement) {
        this.open = true;
      });
    const close = vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.open = false;
    });
    const props = {
      title: "Judge form",
      closeLabel: "Close",
      onDismiss: dismiss,
      children: <input aria-label="Draft" />,
    };
    const { rerender, unmount } = render(<FederationJudgeDialog {...props} />);
    const dialog = screen.getByRole("dialog");
    expect(showModal).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep draft" } });
    rerender(<FederationJudgeDialog {...props} suspended />);
    expect(dialog).toHaveAttribute("inert");
    expect(dialog).toHaveAttribute("aria-hidden", "true");
    cancelDialog(dialog);
    expect(dismiss).not.toHaveBeenCalled();
    expect(dialog).toHaveAttribute("open");
    rerender(<FederationJudgeDialog {...props} />);
    expect(dialog).not.toHaveAttribute("inert");
    expect(screen.getByRole("textbox")).toHaveValue("Keep draft");
    cancelDialog(dialog);
    expect(dismiss).toHaveBeenCalledOnce();
    unmount();
    expect(close).toHaveBeenCalledOnce();
    showModal.mockRestore();
    close.mockRestore();
  });
});
