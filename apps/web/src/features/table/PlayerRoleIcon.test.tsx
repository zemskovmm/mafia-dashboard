import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GameTable } from "./GameTable.js";
import { CardGameIdentityContext } from "./CardGameIdentityContext.js";

const appearance = vi.hoisted(() =>
  vi.fn(() => ({
    roleIcons: {
      citizen: { kind: "builtin", id: "cat" },
      mafia: { kind: "upload", id: "mafia-private" },
      don: { kind: "builtin", id: "crown" },
      sheriff: { kind: "builtin", id: "shield" },
    },
    images: { "mafia-private": "data:image/png;base64,private" },
  })),
);
vi.mock("../players/player-display.js", () => ({ usePlayerRoleAppearance: appearance }));
vi.mock("../players/RoleIconArtwork.js", () => ({
  RoleIconArtwork: ({
    choice,
    fallback,
    images,
  }: {
    choice?: { kind: string; id: string };
    fallback: unknown;
    images: Record<string, string>;
  }) =>
    choice ? (
      <span data-custom-role-choice={choice.id} data-has-image={Boolean(images[choice.id])} />
    ) : (
      fallback
    ),
}));

describe("card role artwork privacy boundary", () => {
  beforeEach(() => appearance.mockClear());
  it.each(["citizen", "mafia", "don", "sheriff"] as const)(
    "uses current %s appearance only on a visible face, retaining role semantics",
    (role) => {
      const { container, rerender } = render(
        <GameTable seats={[{ seat: 1, playerId: "opaque-player", name: "Nickname", role }]} />,
      );
      expect(screen.getByRole("img", { name: role })).toHaveClass("player-role-icon");
      expect(container.querySelector("[data-custom-role-choice]")).not.toBeNull();
      expect(appearance).toHaveBeenCalledWith("opaque-player");
      appearance.mockClear();
      rerender(
        <GameTable
          seats={[{ seat: 1, playerId: "opaque-player", name: "Nickname", role }]}
          privacyHidden
        />,
      );
      expect(appearance).toHaveBeenCalledWith("opaque-player");
      expect(
        container.querySelector("[data-custom-role-choice],img,[data-role-glyph='mafia']"),
      ).toBeNull();
      expect(screen.queryByRole("img", { name: role })).toBeNull();
      expect(container.querySelector("[data-role-glyph='hidden']")).not.toBeNull();
    },
  );
  it("never mounts a custom choice on an unrevealed giveaway; neutral hook timing is identical", () => {
    const { container } = render(
      <GameTable
        seats={[
          { seat: 1, playerId: "opaque-player", name: "Nickname", roleDraw: { dealt: false } },
        ]}
      />,
    );
    expect(appearance).toHaveBeenCalledWith("opaque-player");
    expect(container.querySelector("[data-custom-role-choice]")).toBeNull();
  });
  it("maps suits by game and player, not current seat/name/role/order, through read-only rendering", () => {
    const players = [
      { seat: 1, playerId: "alice", name: "English", role: "citizen" as const },
      { seat: 2, playerId: "bob", name: "Имя", role: "mafia" as const },
    ];
    const view = (id: string, readOnly = false) => (
      <CardGameIdentityContext.Provider value={id}>
        <GameTable seats={players} readOnly={readOnly} />
      </CardGameIdentityContext.Provider>
    );
    const { container, rerender } = render(view("game-a"));
    const suits = () =>
      [...container.querySelectorAll(".seat-anchor")].map(
        (el) => el.querySelector(".card-suit")?.textContent,
      );
    expect(suits()).toEqual(["♠", "♦"]);
    players[0] = { seat: 10, playerId: "alice", name: "Новое имя", role: "citizen" };
    players[1] = { seat: 1, playerId: "bob", name: "Renamed", role: "mafia" };
    rerender(view("game-a", true));
    expect(suits()).toEqual(["♠", "♦"]);
    rerender(view("game-b", true));
    expect(suits()).toEqual(["♠", "♣"]);
  });
});
