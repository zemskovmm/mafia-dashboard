import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Club } from "../../api/client.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { StrictMode } from "react";
import { DeveloperMenu, ManageMenu, type ManageMenuProps } from "./WorkspaceMenus.js";

afterEach(cleanup);

const club: Club = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "La Verdad",
  city: "Málaga",
  headerLogo: "header.svg",
  cardLogo: "card.svg",
  language: "en",
  bestMoveEnabled: true,
  role: "manager",
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
};

const menuProps = (overrides: Partial<ManageMenuProps> = {}): ManageMenuProps => ({
  club,
  onClose: vi.fn(),
  onNewGame: vi.fn(),
  onPlayers: vi.fn(),
  onTimeline: vi.fn(),
  onStatistics: vi.fn(),
  onEditClub: vi.fn(),
  onDeleteClub: vi.fn(),
  onExit: vi.fn(),
  onOpenRules: vi.fn(),
  onMusicOpen: vi.fn(),
  onBestMoveChange: vi.fn().mockResolvedValue(undefined),
  clubSaving: false,
  activeGames: <button>Resume saved game</button>,
  tournament: <button>Change tournament</button>,
  appearance: <button>Choose card style</button>,
  help: <button>Show tutorial help buttons</button>,
  language: (
    <label>
      Language
      <select defaultValue="en">
        <option value="en">English</option>
        <option value="ru">Русский</option>
      </select>
    </label>
  ),
  music: <button>Reload music player</button>,
  ...overrides,
});

const mount = (props: ManageMenuProps = menuProps(), locale: "en" | "ru" = "en") =>
  render(
    <I18nProvider locale={locale}>
      <ManageMenu {...props} />
    </I18nProvider>,
  );

describe("ManageMenu", () => {
  it("keeps members' game/statistics/preferences access without manager destinations", async () => {
    const user = userEvent.setup();
    const props = menuProps({ club: { ...club, role: "user" } });
    mount(props);
    expect(screen.queryByRole("button", { name: "Players screen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Club settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Game & records" }));
    expect(screen.getByRole("button", { name: "Resume saved game" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change tournament" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Past game timeline" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Statistics" }));
    expect(props.onStatistics).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Preferences" }));
    expect(screen.queryByRole("button", { name: "Music player setup" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Appearance" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.queryByRole("button", { name: "Rules" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rules guide" }));
    expect(props.onOpenRules).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Show tutorial help buttons" })).toBeInTheDocument();
  });

  it("shows only the selected preference slot and returns to its logical parent", async () => {
    const user = userEvent.setup();
    const props = menuProps();
    mount(props);
    await user.click(screen.getByRole("button", { name: "Players screen" }));
    expect(props.onPlayers).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Preferences" }));
    expect(screen.queryByRole("button", { name: "Choose card style" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload music player" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("button", { name: "Choose card style" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show tutorial help buttons" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Music player setup" }));
    expect(props.onMusicOpen).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Reload music player" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose card style" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Hide music player setup" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("disables conflicting club mutations while a parent save is pending", async () => {
    const user = userEvent.setup();
    const props = menuProps({ clubSaving: true });
    const view = mount(props);
    await user.click(screen.getByRole("button", { name: "Club settings" }));
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Another club change is being saved");
    fireEvent.submit(screen.getByRole("form"));
    expect(props.onBestMoveChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Club details" }));
    expect(screen.getByRole("button", { name: "Edit club" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Language" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete club" })).toBeDisabled();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    view.rerender(
      <I18nProvider locale="en">
        <ManageMenu {...props} clubSaving={false} />
      </I18nProvider>,
    );
    expect(screen.getByRole("combobox", { name: "Language" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Edit club" }));
    await user.click(screen.getByRole("button", { name: "Delete club" }));
    expect(props.onEditClub).toHaveBeenCalledOnce();
    expect(props.onDeleteClub).toHaveBeenCalledOnce();
    expect(
      within(screen.getByRole("region", { name: "Danger zone" })).getByRole("button", {
        name: "Delete club",
      }),
    ).toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a late %s after a pending form closes and remounts",
    async (outcome) => {
      const user = userEvent.setup();
      let resolve!: () => void;
      let reject!: (reason: Error) => void;
      const save = vi.fn(
        () =>
          new Promise<void>((done, fail) => {
            resolve = done;
            reject = fail;
          }),
      );
      const props = menuProps({ onBestMoveChange: save });
      const view = mount(props);
      await user.click(screen.getByRole("button", { name: "Club settings" }));
      await user.click(screen.getByRole("switch"));
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await user.click(screen.getByRole("button", { name: "Close menu" }));
      expect(props.onClose).toHaveBeenCalledOnce();
      await user.click(screen.getByRole("button", { name: "Club settings" }));
      expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
      await act(async () => {
        if (outcome === "resolve") resolve();
        else reject(new Error("late failure"));
      });
      expect(screen.getByRole("status")).toHaveTextContent("No changes to save");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      view.unmount();
      mount(menuProps({ club: { ...club, bestMoveEnabled: false } }));
      await user.click(screen.getByRole("button", { name: "Club settings" }));
      expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    },
  );

  it("resets club-local navigation/drafts on club changes and hides revoked manager controls", async () => {
    const user = userEvent.setup();
    const props = menuProps();
    const view = mount(props);
    const renderMenu = (nextClub: Club) => (
      <I18nProvider locale="en">
        <ManageMenu {...props} club={nextClub} />
      </I18nProvider>
    );
    await user.click(screen.getByRole("button", { name: "Club settings" }));
    await user.click(screen.getByRole("switch"));
    view.rerender(
      renderMenu({ ...club, id: "00000000-0000-4000-8000-000000000102", bestMoveEnabled: false }),
    );
    expect(screen.getByRole("heading", { name: "Menu" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Club settings" }));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    view.rerender(
      renderMenu({ ...club, id: "00000000-0000-4000-8000-000000000102", role: "user" }),
    );
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Club settings" })).not.toBeInTheDocument();
    expect(props.onBestMoveChange).not.toHaveBeenCalled();
  });

  it("retains native Tab and Enter navigation without focusing a replacement page", async () => {
    const user = userEvent.setup();
    mount();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Start new game" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Game & records" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Game & records" })).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
    expect(screen.getByRole("dialog").querySelector("[tabindex], [autofocus]")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Menu" })).toBeInTheDocument();
  });

  it("localizes navigation and form feedback in Russian while retaining shell control names", async () => {
    const user = userEvent.setup();
    mount(menuProps(), "ru");
    expect(screen.getByRole("dialog", { name: "Управление" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Меню" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Игра и записи" }));
    expect(screen.getByRole("button", { name: "Хронология прошлых игр" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Назад" }));
    await user.click(screen.getByRole("button", { name: "Предпочтения" }));
    expect(screen.getByRole("button", { name: "Внешний вид" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Помощь" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Назад" }));
    await user.click(screen.getByRole("button", { name: "Настройки клуба" }));
    expect(screen.getByRole("button", { name: "Параметры игры" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Данные клуба" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Включить «Лучший ход»" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText("Вкл.")).toBeInTheDocument();
    await user.click(screen.getByRole("switch"));
    expect(screen.getByText("Выкл.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Сохранить изменения" }));
    expect(screen.getByRole("status")).toHaveTextContent("Изменения сохранены");
  });

  it("supports development-lifecycle setup/cleanup without suppressing valid completion", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <ManageMenu {...menuProps()} />
      </StrictMode>,
    );
    await user.click(screen.getByRole("button", { name: "Club settings" }));
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("status")).toHaveTextContent("Changes saved");
  });

  it.each([true, false])(
    "saves the explicit inverse of saved Best Move %s only after submission",
    async (saved) => {
      const user = userEvent.setup();
      let resolve!: () => void;
      const save = vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
      const props = menuProps({
        club: { ...club, bestMoveEnabled: saved },
        onBestMoveChange: save,
      });
      const view = mount(props);
      await user.click(screen.getByRole("button", { name: "Club settings" }));
      expect(screen.getByRole("button", { name: "Game options" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const toggle = screen.getByRole("switch", { name: "Enable Best move" });
      const submit = screen.getByRole("button", { name: "Save changes" });
      expect(toggle).toHaveAttribute("aria-checked", String(saved));
      expect(submit).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent("No changes to save");
      await user.click(submit);
      expect(save).not.toHaveBeenCalled();
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-checked", String(!saved));
      expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
      expect(save).not.toHaveBeenCalled();
      const form = submit.closest("form")!;
      act(() => {
        fireEvent.submit(form);
        fireEvent.submit(form);
      });
      expect(save).toHaveBeenCalledExactlyOnceWith(!saved);
      expect(screen.getByRole("status")).toHaveTextContent("Saving changes");
      expect(toggle).toBeDisabled();
      expect(screen.getByRole("button", { name: /Saving changes/ })).toBeDisabled();
      await act(async () => {
        resolve();
      });
      expect(screen.getByRole("status")).toHaveTextContent(
        "Changes saved. Existing games are unchanged.",
      );
      expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
      expect(club.bestMoveEnabled).toBe(true);
      // The parent owns the authoritative club and supplies the acknowledged server value.
      view.rerender(
        <I18nProvider locale="en">
          <ManageMenu {...props} club={{ ...props.club, bestMoveEnabled: !saved }} />
        </I18nProvider>,
      );
      await user.click(screen.getByRole("button", { name: "Back" }));
      await user.click(screen.getByRole("button", { name: "Club settings" }));
      expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", String(!saved));
    },
  );

  it("discards unsaved drafts on Cancel, Back, details navigation and Close", async () => {
    const user = userEvent.setup();
    const props = menuProps();
    mount(props);
    for (const action of ["Cancel", "Back", "Club details", "Close menu"]) {
      await user.click(screen.getByRole("button", { name: "Club settings" }));
      await user.click(screen.getByRole("switch", { name: "Enable Best move" }));
      await user.click(screen.getByRole("button", { name: action }));
      if (action === "Club details") {
        expect(screen.queryByRole("switch")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Game options" }));
        expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
        await user.click(screen.getByRole("button", { name: "Back" }));
      }
      expect(screen.getByRole("heading", { name: "Menu" })).toBeInTheDocument();
    }
    expect(props.onBestMoveChange).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Club settings" }));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/A club default for new games/)).toHaveTextContent(
      /already being set up or played keep their existing setting/,
    );
  });

  it("keeps a failed draft available for an explicit retry", async () => {
    const user = userEvent.setup();
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(undefined);
    mount(menuProps({ onBestMoveChange: save }));
    await user.click(screen.getByRole("button", { name: "Club settings" }));
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Best Move could not be saved");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(
      screen.queryByText("Changes saved. Existing games are unchanged."),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map(([value]) => value)).toEqual([false, false]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Changes saved");
  });

  it("starts with the direct new-game action and navigates one native drawer", async () => {
    const user = userEvent.setup();
    const props = menuProps();
    mount(props);
    const dialog = screen.getByRole("dialog", { name: "Manage" });
    expect(dialog).toHaveAttribute("id", "manage-menu-drawer");
    expect(screen.getByRole("heading", { name: "Menu" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    const body = dialog.querySelector(".workspace-menu-body")! as HTMLElement;
    expect(within(body).getAllByRole("button")[0]).toHaveTextContent("Start new game");
    await user.click(screen.getByRole("button", { name: "Start new game" }));
    expect(props.onNewGame).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Game & records" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      within(body)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Resume saved game", "Change tournament", "Past game timeline", "Statistics"]);
    await user.click(screen.getByRole("button", { name: "Past game timeline" }));
    expect(props.onTimeline).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Statistics" }));
    expect(props.onStatistics).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Menu" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume saved game" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Choose another club/ }));
    expect(props.onExit).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Close menu" }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

describe("DeveloperMenu", () => {
  it("exposes only three groups and the direct Hide action at root", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onHide = vi.fn();
    render(
      <DeveloperMenu
        onClose={onClose}
        onHide={onHide}
        visualEffects={<button>Fancy Features</button>}
        gameTesting={<button>Preview undealt roles</button>}
        diagnostics={
          <>
            <p>Version test</p>
            <button>Clear browser data</button>
          </>
        }
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Developer menu" });
    expect(dialog).toHaveAttribute("id", "dev-menu-drawer");
    expect(dialog).toHaveClass("app-drawer", "dev-menu-drawer");
    expect(screen.getByRole("heading", { name: "Dev menu" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fancy Features" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview undealt roles" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear browser data" })).not.toBeInTheDocument();
    for (const [group, slot] of [
      ["Visual effects", "Fancy Features"],
      ["Game testing", "Preview undealt roles"],
      ["Diagnostics & local data", "Clear browser data"],
    ]) {
      await user.click(screen.getByRole("button", { name: group }));
      expect(screen.getByRole("heading", { name: group })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: slot })).toBeInTheDocument();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Hide developer mode" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(screen.queryByRole("button", { name: slot })).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "Hide developer mode" }));
    expect(onHide).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Game testing" }));
    await user.click(screen.getByRole("button", { name: "Close menu" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Preview undealt roles" })).not.toBeInTheDocument();
  });

  it("localizes developer group labels in Russian without mounting hidden tools", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="ru">
        <DeveloperMenu
          onClose={vi.fn()}
          onHide={vi.fn()}
          visualEffects={<button>effects slot</button>}
          gameTesting={<button>testing slot</button>}
          diagnostics={<button>diagnostic slot</button>}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Визуальные эффекты" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Тестирование игры" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Диагностика и локальные данные" }));
    expect(screen.getByRole("button", { name: "diagnostic slot" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "effects slot" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "testing slot" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Закрыть меню" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.queryByRole("button", { name: "diagnostic slot" })).not.toBeInTheDocument();
  });
});
