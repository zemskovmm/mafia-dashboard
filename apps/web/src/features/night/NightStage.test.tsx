import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  advanceSetupPhase,
  beginNight,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "@mafia/game-domain";
import type { GameState, PlayerInput } from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { NightStage } from "./NightStage.js";

const createNightGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `p-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(17));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  const day = advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
  return beginNight(day);
};

const Harness = ({
  initial,
  onEvent = () => undefined,
}: {
  initial: GameState;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
}) => {
  const [game, setGame] = useState(initial);
  return <NightStage game={game} onGameChange={setGame} onEvent={onEvent} />;
};

describe("NightStage", () => {
  it("renders a Russian Don result while preserving the checked player's name", () => {
    const base = createNightGame();
    const target = base.players.find(({ team }) => team === "red")!;
    render(
      <I18nProvider locale="ru">
        <NightStage
          game={{
            ...base,
            phase: "night-don-result",
            checkResult: { kind: "don-check", targetSeat: target.seat, match: false, secret: true },
          }}
          onGameChange={() => undefined}
          onEvent={() => undefined}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("status", { name: "Результат проверки Дона" })).toHaveTextContent(
      `Дон проверил игрока ${target.name}`,
    );
    expect(screen.getByText("Не является Шерифом")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Перейти к проверке Шерифа" })).toBeInTheDocument();
  });

  it("does not show inline Red controls during Don and Sheriff checks", () => {
    const base = createNightGame();
    const target = base.players.find(({ team }) => team === "red")!;
    const fixtures: readonly GameState[] = [
      { ...base, phase: "night-don" },
      {
        ...base,
        phase: "night-don-result",
        checkResult: { kind: "don-check", targetSeat: target.seat, match: false, secret: true },
      },
      { ...base, phase: "night-sheriff" },
      {
        ...base,
        phase: "night-sheriff-result",
        checkResult: {
          kind: "sheriff-check",
          targetSeat: target.seat,
          match: false,
          secret: true,
        },
      },
    ];

    for (const game of fixtures) {
      const { unmount } = render(
        <NightStage game={game} onGameChange={() => undefined} onEvent={() => undefined} />,
      );
      expect(screen.queryByRole("button", { name: /^Red card / })).toBeNull();
      unmount();
    }
  });

  it("uses the table with one sorted shooter button per target", async () => {
    const user = userEvent.setup();
    const initial = createNightGame();
    const shooters = initial.players
      .filter(({ team }) => team === "black")
      .sort((left, right) => left.seat - right.seat);
    const target = initial.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!;
    const otherTarget = initial.players.find(
      ({ status, seat }) => status === "active" && seat !== target.seat,
    )!;
    render(<Harness initial={initial} />);

    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    for (const shooter of shooters) {
      expect(
        screen.getByRole("button", {
          name: `Assign all Mafia shots to ${shooter.name}`,
        }),
      ).toHaveClass("is-mafia-shooter");
    }
    const targetButtons = shooters.map((shooter) =>
      screen.getByRole("button", {
        name: `Assign shooter ${shooter.seat} to target ${target.name}`,
      }),
    );
    expect(targetButtons.map((button) => button.textContent)).toEqual(
      shooters.map(({ seat }) => `#${seat}`),
    );

    await user.click(targetButtons[0]!);
    const selectedShot = screen.getByRole("button", {
      name: `Remove shooter ${shooters[0]!.seat} from target ${target.name}`,
    });
    expect(selectedShot).toBeEnabled();
    expect(selectedShot).toHaveAttribute("aria-pressed", "true");

    await user.click(
      screen.getByRole("button", {
        name: `Assign shooter ${shooters[0]!.seat} to target ${otherTarget.name}`,
      }),
    );
    expect(
      screen.getByRole("button", {
        name: `Remove shooter ${shooters[0]!.seat} from target ${otherTarget.name}`,
      }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(
      screen.getByRole("button", {
        name: `Remove shooter ${shooters[0]!.seat} from target ${otherTarget.name}`,
      }),
    );
    expect(
      screen.getByRole("button", {
        name: `Assign shooter ${shooters[0]!.seat} to target ${otherTarget.name}`,
      }),
    ).toHaveAttribute("aria-pressed", "false");

    await user.click(
      screen.getByRole("button", { name: `Assign all Mafia shots to ${target.name}` }),
    );
    expect(
      screen.getAllByRole("button", { name: new RegExp(`from target ${target.name}$`) }),
    ).toHaveLength(shooters.length);

    await user.click(
      screen.getByRole("button", { name: `Remove all Mafia shots from ${target.name}` }),
    );
    expect(
      screen.getAllByRole("button", { name: new RegExp(`to target ${target.name}$`) }),
    ).toHaveLength(shooters.length);
  });

  it("allows the host to evaluate missing Mafia shots as a miss", async () => {
    const user = userEvent.setup();
    render(<Harness initial={createNightGame()} />);

    const evaluate = screen.getByRole("button", { name: /evaluate mafia shots/i });
    expect(evaluate).toBeEnabled();
    await user.click(evaluate);

    expect(screen.getByRole("group", { name: "Mafia missed" })).toHaveTextContent("No player died");
  });

  it("allows every remaining shot to target a deceased player and reports no effect", async () => {
    const user = userEvent.setup();
    const base = createNightGame();
    const deceased = base.players.find(({ team }) => team === "red")!;
    const initial: GameState = {
      ...base,
      players: base.players.map((player) =>
        player.seat === deceased.seat ? { ...player, status: "eliminated" } : player,
      ),
    };
    render(<Harness initial={initial} />);

    await user.click(
      screen.getByRole("button", {
        name: new RegExp(`^Assign all Mafia shots to ${deceased.name}$`),
      }),
    );
    expect(
      screen.getAllByRole("button", { name: new RegExp(`from target ${deceased.name}$`) }),
    ).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    expect(screen.getByRole("status", { name: "Mafia shots had no effect" })).toHaveTextContent(
      `${deceased.name} was already out`,
    );
    expect(
      screen.getByRole("button", { name: `Seat ${deceased.seat}: ${deceased.name}` }),
    ).toHaveClass("status-eliminated");
  });

  it("shows the Mafia shot result again on the final Night screen", () => {
    const base = createNightGame();
    const target = base.players.find(({ team }) => team === "red")!;
    const { rerender } = render(
      <Harness initial={{ ...base, phase: "night-resolution", nightResult: { kind: "miss" } }} />,
    );

    expect(screen.getByRole("group", { name: "Mafia missed" })).toHaveTextContent("No player died");
    expect(screen.getByRole("button", { name: /begin day 2/i })).toBeInTheDocument();

    rerender(
      <Harness
        key="kill"
        initial={{
          ...base,
          phase: "night-resolution",
          players: base.players.map((player) =>
            player.seat === target.seat ? { ...player, status: "eliminated" } : player,
          ),
          nightResult: { kind: "kill", targetSeat: target.seat },
        }}
      />,
    );
    expect(screen.getByRole("group", { name: "Deceased player" })).toHaveTextContent(target.name);
  });

  it("keeps check targets undimmed and permits checks on deceased players", async () => {
    const user = userEvent.setup();
    const base = createNightGame();
    const deceased = base.players.find(({ role }) => role === "citizen")!;
    const initial: GameState = {
      ...base,
      phase: "night-don",
      players: base.players.map((player) =>
        player.seat === deceased.seat ? { ...player, status: "eliminated" } : player,
      ),
    };
    const { container } = render(<Harness initial={initial} />);

    expect(container.querySelectorAll(".player-seat.is-dimmed")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: `Don check ${deceased.name}` }));
    expect(screen.getByText("Not the Sheriff")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Sheriff check ${deceased.name}` })).toBeNull();
    await user.click(screen.getByRole("button", { name: /proceed to sheriff check/i }));
    expect(container.querySelectorAll(".player-seat.is-dimmed")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: `Sheriff check ${deceased.name}` }));
    expect(screen.getByText("Not Mafia")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue night" }));
    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    expect(screen.getByText("Night complete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /begin day 2/i })).toBeInTheDocument();
  });

  it("keeps both same-night deceased owners' checks interactive", async () => {
    const user = userEvent.setup();
    const base = createNightGame();
    const onEvent = vi.fn();
    const target = base.players.find(({ role }) => role === "citizen")!;
    const don = base.players.find(({ role }) => role === "don")!;
    const sheriff = base.players.find(({ role }) => role === "sheriff")!;
    const initial: GameState = {
      ...base,
      phase: "night-don",
      players: base.players.map((player) =>
        player.role === "don" || player.role === "sheriff"
          ? { ...player, status: "eliminated" }
          : player,
      ),
    };
    render(<Harness initial={initial} onEvent={onEvent} />);

    expect(screen.getByRole("button", { name: `Don check ${target.name}` })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Skip Don check" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /red card|foul/i })).toBeNull();
    expect(screen.getByRole("button", { name: `Don check ${don.name}` })).toHaveClass(
      "status-eliminated",
    );
    await user.click(screen.getByRole("button", { name: `Don check ${target.name}` }));
    expect(screen.getByText("Not the Sheriff")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /proceed to sheriff check/i }));

    expect(screen.getByRole("button", { name: `Sheriff check ${target.name}` })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Skip Sheriff check" })).toBeEnabled();
    expect(screen.getByRole("button", { name: `Sheriff check ${sheriff.name}` })).toHaveClass(
      "status-eliminated",
    );
    await user.click(screen.getByRole("button", { name: `Sheriff check ${target.name}` }));
    expect(screen.getByText("Not Mafia")).toBeInTheDocument();
  });

  it("logs Mafia moves only when shots are evaluated", async () => {
    const user = userEvent.setup();
    const initial = createNightGame();
    const shooters = initial.players
      .filter(({ team }) => team === "black")
      .sort((left, right) => left.seat - right.seat);
    const target = initial.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!;
    const onEvent = vi.fn();
    render(<Harness initial={initial} onEvent={onEvent} />);

    const assignAll = async () => {
      for (const shooter of shooters) {
        await user.click(
          screen.getByRole("button", {
            name: `Assign shooter ${shooter.seat} to target ${target.name}`,
          }),
        );
      }
    };

    await assignAll();
    expect(onEvent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    expect(screen.getByRole("group", { name: "Deceased player" })).toHaveTextContent(target.name);
    expect(screen.getByRole("button", { name: `Seat ${target.seat}: ${target.name}` })).toHaveClass(
      "is-provisional-deceased",
    );
    expect(onEvent.mock.calls.filter(([type]) => type === "mafia.shot-recorded")).toHaveLength(0);
    expect(onEvent.mock.calls.filter(([type]) => type === "mafia.shots-resolved")).toHaveLength(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      "mafia.shots-resolved",
      expect.objectContaining({
        shots: expect.arrayContaining(
          shooters.map(({ seat }) =>
            expect.objectContaining({ shooterSeat: seat, targetSeat: target.seat }),
          ),
        ),
      }),
    );

    expect(screen.queryByRole("button", { name: /re-evaluate mafia shots/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: /continue night/i }));

    expect(onEvent.mock.calls.filter(([type]) => type === "mafia.shot-recorded")).toHaveLength(0);
    expect(onEvent.mock.calls.filter(([type]) => type === "mafia.shots-resolved")).toHaveLength(1);
    expect(screen.getByText("Don check")).toBeInTheDocument();
  });

  it("continues Don, Sheriff, and next-day stages after confirmed shots", async () => {
    const user = userEvent.setup();
    const initial = createNightGame();
    const shooters = initial.players.filter(({ team }) => team === "black");
    const target = initial.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!;
    const sheriff = initial.players.find(({ role }) => role === "sheriff")!;
    const mafia = initial.players.find(({ role }) => role === "mafia")!;
    render(<Harness initial={initial} />);

    for (const shooter of shooters) {
      await user.click(
        screen.getByRole("button", {
          name: `Assign shooter ${shooter.seat} to target ${target.name}`,
        }),
      );
    }

    await user.click(screen.getByRole("button", { name: /evaluate mafia shots/i }));
    await user.click(screen.getByRole("button", { name: /continue night/i }));
    expect(screen.getByText("Don check")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: new RegExp(`don check ${sheriff.name}`, "i") }),
    );
    expect(screen.getByText(/sheriff found/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /proceed to sheriff check/i }));

    expect(screen.getByText("Sheriff check")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: new RegExp(`sheriff check ${mafia.name}`, "i") }),
    );
    expect(screen.getByText(/mafia found/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue night" }));
    expect(screen.getByRole("region", { name: "Mafia table" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /red card/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /begin day 2/i }));
    expect(screen.getByRole("heading", { name: /night complete/i })).toBeInTheDocument();
  });
});
