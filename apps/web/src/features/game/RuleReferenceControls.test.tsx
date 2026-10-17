import { useState } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  advanceSetupPhase,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  type GameState,
} from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { removalRules } from "../../i18n/messages/federation-discipline.js";
import { namedProfiles, renderWithProfiles } from "../../test-player-directory.js";
import { FederationDisciplineControls } from "./FederationDisciplineControls.js";

const day = (): GameState => {
  let setup = beginRoleDraw(
    createSetup(
      Array.from({ length: 10 }, (_, index) => ({
        id: `player-${index + 1}`,
        seat: index + 1,
      })),
    ),
    createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat++) setup = drawRoleForSeat(setup, seat);
  let game = createGame(completeRoleDraw(setup));
  while (game.phase !== "day") game = advanceSetupPhase(game);
  return game;
};
const render = (ui: Parameters<typeof renderWithProfiles>[0]) =>
  renderWithProfiles(ui, namedProfiles("player-"));
const adjudicationRules = ["6.3.1", "6.3.2", "6.3.3", "6.3.4", "6.3.5", "6.6.4"];

// Exercise real selectors and native-dialog ownership. Reader rendering is covered
// separately; this callback stands in only for the parent's transient open request.
describe("disciplinary rule references", () => {
  it.each(["en", "ru"] as const)(
    "routes every selectable rule without submitting in %s",
    async (locale) => {
      const user = userEvent.setup();
      const game = day();
      const onOpenRule = vi.fn();
      const accepted = vi.fn();
      render(
        <I18nProvider locale={locale}>
          <FederationDisciplineControls
            game={game}
            request={{ game, seat: 2, action: "removal", shortcut: true, id: 1 }}
            privacyHidden
            onOpenRule={onOpenRule}
            onAcceptedEvent={accepted}
            onGameChange={vi.fn()}
            onEvent={vi.fn()}
          />
        </I18nProvider>,
      );
      const selector = screen.getByLabelText(locale === "en" ? "Removal rule" : "Пункт удаления");
      const help = within(selector.closest(".discipline-rule-picker")!).getByRole("button");
      expect(help).toBeDisabled();
      for (const rule of removalRules) {
        await user.selectOptions(selector, rule);
        expect(help).toBeEnabled();
        expect(help).toHaveAttribute("type", "button");
        expect(help).toHaveAccessibleName(new RegExp(rule.replaceAll(".", "\\.")));
        await user.click(help);
        expect(onOpenRule).toHaveBeenLastCalledWith(rule);
        expect(selector).toHaveValue(rule);
      }
      await user.selectOptions(
        screen.getByLabelText(locale === "en" ? "Discipline action" : "Дисциплинарное действие"),
        "opponent-victory",
      );
      const opposing = screen.getByLabelText(locale === "en" ? "Applicable rule" : "Пункт правил");
      const opposingHelp = within(opposing.closest(".discipline-rule-picker")!).getByRole("button");
      for (const rule of adjudicationRules) {
        await user.selectOptions(opposing, rule);
        await user.click(opposingHelp);
        expect(onOpenRule).toHaveBeenLastCalledWith(rule);
      }
      expect(onOpenRule).toHaveBeenCalledTimes(removalRules.length + adjudicationRules.length);
      expect(accepted).not.toHaveBeenCalled();
    },
  );

  it("opens the implicit fourth-foul rule despite the disabled selector", async () => {
    const initial = day();
    const game = {
      ...initial,
      players: initial.players.map((p) => (p.seat === 2 ? { ...p, fouls: 3 } : p)),
    };
    const onOpenRule = vi.fn();
    const accepted = vi.fn();
    render(
      <FederationDisciplineControls
        game={game}
        request={{ game, seat: 2, action: "foul", id: 1 }}
        onOpenRule={onOpenRule}
        onAcceptedEvent={accepted}
        onGameChange={vi.fn()}
        onEvent={vi.fn()}
      />,
    );
    const selector = screen.getByLabelText("Removal rule");
    expect(selector).toBeDisabled();
    expect(selector).toHaveValue("6.2.1");
    const help = within(selector.closest(".discipline-rule-picker")!).getByRole("button");
    await userEvent.click(help);
    expect(onOpenRule).toHaveBeenCalledExactlyOnceWith("6.2.1");
    expect(accepted).not.toHaveBeenCalled();
  });

  it("retains an unfinished opposing-victory draft while its dialog is suspended", async () => {
    const game = day();
    const accepted = vi.fn();
    const dismiss = vi.fn();
    const Harness = () => {
      const [suspended, setSuspended] = useState(false);
      return (
        <>
          <button onClick={() => setSuspended(false)}>Return from reader</button>
          <FederationDisciplineControls
            game={game}
            request={{ game, seat: 2, action: "removal", shortcut: true, id: 1 }}
            readerOpen={suspended}
            onOpenRule={() => setSuspended(true)}
            onComplete={dismiss}
            onAcceptedEvent={accepted}
            onGameChange={vi.fn()}
            onEvent={vi.fn()}
          />
        </>
      );
    };
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText("Discipline action"), "opponent-victory");
    await user.selectOptions(screen.getByLabelText("Applicable rule"), "6.3.5");
    await user.type(screen.getByLabelText("Judge's reason"), "Unfinished reviewed explanation");
    await user.click(screen.getByLabelText("Required committee agreement obtained"));
    const judge = screen.getByRole("dialog");
    await user.click(
      within(
        screen.getByLabelText("Applicable rule").closest(".discipline-rule-picker")!,
      ).getByRole("button"),
    );
    expect(judge).toHaveAttribute("inert");
    fireEvent.keyDown(judge, { key: "Escape" });
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Return from reader"));
    expect(judge).not.toHaveAttribute("inert");
    expect(screen.getByLabelText("Applicable rule")).toHaveValue("6.3.5");
    expect(screen.getByLabelText("Judge's reason")).toHaveValue("Unfinished reviewed explanation");
    expect(screen.getByLabelText("Required committee agreement obtained")).toBeChecked();
    expect(accepted).not.toHaveBeenCalled();
  });
});
