import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  applyGameEvent,
  assignRoleForSeat,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSetup,
  createSeededRandom,
  FEDERATION_RULES_EDITION,
  type CanonicalGameEventDraft,
} from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { AdjudicationControls } from "./AdjudicationControls.js";

const game = () => {
  let setup = beginRoleDraw(
    createSetup(
      Array.from({ length: 10 }, (_, index) => ({ id: `p${index + 1}`, seat: index + 1 })),
      { rulesEdition: FEDERATION_RULES_EDITION },
    ),
    createSeededRandom(13),
  );
  for (let seat = 1; seat <= 10; seat += 1)
    setup = assignRoleForSeat(
      setup,
      seat,
      seat === 1 ? "sheriff" : seat === 10 ? "don" : seat >= 8 ? "mafia" : "citizen",
    );
  return createGame(completeRoleDraw(setup));
};

describe("opponent victory controls", () => {
  it("requires a reason and committee approval, then awards the opposite team without deaths", () => {
    const before = game();
    const accept = vi.fn<(event: CanonicalGameEventDraft) => void>();
    render(<AdjudicationControls game={before} onAcceptedEvent={accept} />);
    fireEvent.click(screen.getByText("Referee-awarded victory"));
    fireEvent.change(screen.getByLabelText("Losing team"), { target: { value: "red" } });
    fireEvent.change(screen.getByLabelText("Applicable rule"), { target: { value: "6.3.5" } });
    fireEvent.change(screen.getByLabelText("Offender seat (optional)"), { target: { value: "1" } });
    const award = screen.getByRole("button", { name: "Award victory to opposing team" });
    expect(award).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Judge's reason"), {
      target: { value: "  Confirmed rule violation  " },
    });
    expect(award).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Required committee agreement obtained"));
    fireEvent.click(award);
    expect(accept).toHaveBeenCalledOnce();
    const event = accept.mock.calls[0]![0];
    expect(event).toEqual({
      type: "game.adjudicated",
      payload: {
        losingTeam: "red",
        offenderSeat: 1,
        rule: "6.3.5",
        reason: "Confirmed rule violation",
        committeeApproved: true,
      },
    });
    const after = applyGameEvent(before, event);
    expect(after).toMatchObject({ phase: "finished", winner: "black" });
    expect(after.players).toEqual(before.players);
  });

  it("localizes the ruling form and clears an offender when the losing side changes", () => {
    const accept = vi.fn();
    render(
      <I18nProvider locale="ru">
        <AdjudicationControls game={game()} onAcceptedEvent={accept} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByText("Победа по решению судьи (ППК)"));
    fireEvent.change(screen.getByLabelText("Игрок-нарушитель (необязательно)"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Проигравшая команда"), { target: { value: "black" } });
    expect(screen.getByLabelText("Игрок-нарушитель (необязательно)")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Обоснование судьи"), {
      target: { value: "Нарушение подтверждено" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Присудить победу противоположной команде" }),
    );
    expect(accept).toHaveBeenCalledWith({
      type: "game.adjudicated",
      payload: {
        losingTeam: "black",
        rule: "6.3.1",
        reason: "Нарушение подтверждено",
        committeeApproved: false,
      },
    });
  });
});
