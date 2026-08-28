import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { LiveMusicControls } from "./LiveMusicControls.js";

describe("LiveMusicControls", () => {
  it("exposes all three table-safe fade actions", async () => {
    const user = userEvent.setup();
    const onFadeIn = vi.fn();
    const onQuickFadeOut = vi.fn();
    const onSlowFadeOut = vi.fn();
    render(
      <LiveMusicControls
        isPlaying
        canFadeIn
        onFadeIn={onFadeIn}
        onQuickFadeOut={onQuickFadeOut}
        onSlowFadeOut={onSlowFadeOut}
      />,
    );

    await user.click(screen.getByRole("button", { name: /music fade in/i }));
    await user.click(screen.getByRole("button", { name: /quick music fade out/i }));
    await user.click(screen.getByRole("button", { name: /slow music fade out/i }));

    expect(onFadeIn).toHaveBeenCalledOnce();
    expect(onQuickFadeOut).toHaveBeenCalledOnce();
    expect(onSlowFadeOut).toHaveBeenCalledOnce();
  });

  it("uses Russian labels for every fade control", () => {
    render(
      <I18nProvider locale="ru">
        <LiveMusicControls
          isPlaying
          canFadeIn
          onFadeIn={vi.fn()}
          onQuickFadeOut={vi.fn()}
          onSlowFadeOut={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("region", { name: "Управление музыкой" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Плавное появление музыки" })).toHaveTextContent(
      "Плавное появление",
    );
    expect(screen.getByRole("button", { name: "Быстрое затухание музыки" })).toHaveTextContent(
      "Быстрое затухание",
    );
    expect(screen.getByRole("button", { name: "Медленное затухание музыки" })).toHaveTextContent(
      "Медленное затухание",
    );
  });
});
