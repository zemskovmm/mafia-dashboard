import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeveloperSettingToggle } from "./DeveloperSettingToggle.js";

describe("developer setting toggle", () => {
  it.each([
    {
      title: "Local effect",
      description: "This device only",
      on: "On",
      off: "Off",
      action: "Toggle local effect",
    },
    {
      title: "Локальный эффект",
      description: "Только на этом устройстве",
      on: "Вкл.",
      off: "Выкл.",
      action: "Переключить локальный эффект",
    },
  ])(
    "preserves native activation, disabled state and caller-provided semantics ($title)",
    async (labels) => {
      const changed = vi.fn();
      const user = userEvent.setup();
      const Harness = ({ disabled = false }: { disabled?: boolean }) => {
        const [pressed, setPressed] = useState(false);
        return (
          <>
            <p id="toggle-help">{labels.description}</p>
            <DeveloperSettingToggle
              title={labels.title}
              description={labels.description}
              ariaLabel={labels.action}
              ariaDescribedBy="toggle-help"
              pressed={pressed}
              stateLabel={pressed ? labels.on : labels.off}
              disabled={disabled}
              onClick={() => {
                changed();
                setPressed(!pressed);
              }}
            />
          </>
        );
      };
      const view = render(<Harness />);
      const button = screen.getByRole("button", { name: labels.action });
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveClass("dev-setting-toggle");
      expect(button).toHaveAttribute("aria-describedby", "toggle-help");
      expect(button).toHaveAttribute("aria-pressed", "false");
      expect(button.querySelector("span > strong")).toHaveTextContent(labels.title);
      expect(button.querySelector("span > small")).toHaveTextContent(labels.description);
      expect(button.querySelector(".dev-setting-state")).toHaveTextContent(labels.off);
      button.focus();
      await user.keyboard("{Enter}");
      expect(button).toHaveAttribute("aria-pressed", "true");
      await user.keyboard(" ");
      expect(button).toHaveAttribute("aria-pressed", "false");
      await user.click(button);
      expect(button).toHaveAttribute("aria-pressed", "true");
      expect(changed).toHaveBeenCalledTimes(3);
      view.rerender(<Harness disabled />);
      expect(button).toBeDisabled();
      await user.click(button);
      await user.keyboard("{Enter} ");
      expect(changed).toHaveBeenCalledTimes(3);
    },
  );
});
