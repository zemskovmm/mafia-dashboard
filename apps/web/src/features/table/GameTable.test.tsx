import { swipeCard } from "../../test-card-gestures.js";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GameTable, type TableSeatView } from "./GameTable.js";
import { PlayerCardAppearanceContext } from "../theme/PlayerCardAppearanceContext.js";
import { DEFAULT_GLASS_SETTINGS } from "../theme/glass-preferences.js";
import { PlayerCardStyleContext } from "../theme/PlayerCardStyleContext.js";
import type { PlayerCardStyle } from "../theme/player-card-preferences.js";

const seats: TableSeatView[] = Array.from({ length: 10 }, (_, index) => ({
  seat: index + 1,
  name: `Player ${index + 1}`,
}));

describe("GameTable", () => {
  it.each(["glass", "classic", "heritage", "noir"] as const)(
    "keeps one %s name below and outside both faces through privacy, departure and completion",
    (style) => {
      let name = "Alexandra Very-Long-Player-Name";
      const tree = (
        privacyHidden = false,
        departed = false,
        completed = false,
        readOnly = false,
      ) => (
        <PlayerCardStyleContext.Provider value={{ style, rolePlacement: "below" }}>
          <GameTable
            seats={[
              { ...seats[0]!, name, role: "mafia", status: departed ? "eliminated" : "active" },
            ]}
            privacyHidden={privacyHidden}
            completed={completed}
            readOnly={readOnly}
          />
        </PlayerCardStyleContext.Provider>
      );
      const { container, rerender } = render(tree());
      const caption = container.querySelector(".seat-anchor > .player-seat-caption");
      expect(caption).toHaveTextContent(name);
      expect(caption).toHaveAttribute("title", name);
      for (const [privacy, departed, completed, readOnly] of [
        [true, false, false, false],
        [false, true, false, false],
        [true, true, true, false],
        [true, true, true, true],
        [false, false, false, false],
      ]) {
        rerender(tree(privacy, departed, completed, readOnly));
        expect(container.querySelectorAll(".player-seat-caption")).toHaveLength(1);
        expect(container.querySelector(".player-seat-caption")).toBe(caption);
        const card = screen.getByRole(readOnly ? "group" : "button", { name: `Seat 1: ${name}` });
        expect(card.nextElementSibling).toBe(caption);
        expect(card).not.toHaveTextContent(name);
        expect(caption?.closest(".player-seat")).toBeNull();
      }
      const card = screen.getByRole("button", { name: `Seat 1: ${name}` });
      const artwork = card.querySelector("img");
      name = "Renamed player";
      rerender(tree());
      expect(screen.getByRole("button", { name: `Seat 1: ${name}` })).toBe(card);
      expect(card.querySelector("img")).toBe(artwork);
      expect(card.nextElementSibling).toBe(caption);
      expect(caption).toHaveTextContent(name);
    },
  );

  it.each(["classic", "heritage", "noir"] as const)(
    "uses %s artwork without role icons and preserves the action host when changing style",
    (style) => {
      const onSeatClick = vi.fn();
      const tree = (selectedStyle: PlayerCardStyle, privacyHidden = false) => (
        <PlayerCardStyleContext.Provider value={{ style: selectedStyle, rolePlacement: "below" }}>
          <GameTable
            seats={seats.map((seat) => ({ ...seat, role: "citizen" }))}
            privacyHidden={privacyHidden}
            onSeatClick={onSeatClick}
          />
        </PlayerCardStyleContext.Provider>
      );
      const { rerender } = render(tree("glass"));
      const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
      expect(card.querySelector(".player-role-icon")).not.toBeNull();
      rerender(tree(style));
      expect(screen.getByRole("button", { name: "Seat 1: Player 1" })).toBe(card);
      expect(card).toHaveAttribute("data-card-style", style);
      expect(card).toHaveAttribute("data-card-face", "front");
      expect(card).not.toHaveAttribute("data-player-glass");
      expect(card.querySelector(".player-role-icon,.liquid-card-glass")).toBeNull();
      expect(card).toHaveTextContent(/citizen/i);
      const images = screen
        .getAllByRole("button", { name: /^Seat \d+:/ })
        .map((element) => element.querySelector("img")?.getAttribute("src"));
      expect(images.every(Boolean)).toBe(true);
      expect(new Set(images).size).toBe(10);
      fireEvent.click(card);
      expect(onSeatClick).toHaveBeenCalledExactlyOnceWith(1);
      rerender(tree(style, true));
      expect(card).toHaveAttribute("data-card-face", "back");
      expect(card).not.toHaveTextContent(/citizen/i);
      expect(card.querySelector(".player-role-icon,.deceased-cross")).toBeNull();
      const backs = screen
        .getAllByRole("button", { name: /^Seat \d+:/ })
        .map((element) => element.querySelector("img")?.getAttribute("src"));
      expect(backs.every(Boolean)).toBe(true);
      expect(new Set(backs).size).toBe(1);
      expect(backs[0]).not.toBe(images[0]);
      rerender(tree("glass"));
      expect(card).toHaveAttribute("data-player-glass", "table");
      expect(card.querySelector(".player-role-icon")).not.toBeNull();
    },
  );

  it("keeps printed elimination down after privacy clears and a restored player hidden until privacy clears", () => {
    const tree = (deceased: boolean, privacyHidden: boolean) => (
      <PlayerCardStyleContext.Provider value={{ style: "classic", rolePlacement: "below" }}>
        <GameTable
          seats={[
            {
              ...seats[0]!,
              role: "mafia",
              status: deceased ? "eliminated" : "active",
              inactive: deceased,
            },
          ]}
          privacyHidden={privacyHidden}
        />
      </PlayerCardStyleContext.Provider>
    );
    const { rerender } = render(tree(false, false));
    const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(card).toHaveAttribute("data-card-face", "front");
    rerender(tree(true, true));
    rerender(tree(true, false));
    expect(card).toHaveAttribute("data-card-face", "back");
    expect(card).not.toHaveTextContent(/mafia/i);
    expect(card.querySelector(".deceased-cross")).toBeNull();
    rerender(tree(false, true));
    expect(card).toHaveAttribute("data-card-face", "back");
    rerender(tree(false, false));
    expect(card).toHaveAttribute("data-card-face", "front");
    expect(card).toHaveTextContent(/mafia/i);
  });

  it("does not turn a provisional private result down and removes role-specific light on a completed departure", () => {
    const tree = (provisionalDeceased: boolean) => (
      <PlayerCardStyleContext.Provider value={{ style: "noir", rolePlacement: "below" }}>
        <GameTable
          seats={[
            {
              ...seats[0]!,
              role: "sheriff",
              status: "eliminated",
              provisionalDeceased,
              sheriffHighlight: true,
              nightCheckHighlight: true,
            },
          ]}
        />
      </PlayerCardStyleContext.Provider>
    );
    const { rerender } = render(tree(true));
    const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(card).toHaveAttribute("data-card-face", "front");
    expect(card).toHaveTextContent(/sheriff/i);
    rerender(tree(false));
    expect(card).toHaveAttribute("data-card-face", "back");
    expect(card).not.toHaveTextContent(/sheriff/i);
    expect(card).not.toHaveClass("is-sheriff-highlight", "is-night-check-highlight");
    expect(card.querySelector(".vgpu-player-lighting")).toBeNull();
  });

  it.each(["classic", "heritage", "noir"] as const)(
    "preserves printed %s gestures and their click suppression",
    (style) => {
      const click = vi.fn();
      const foul = vi.fn();
      const penalty = vi.fn();
      render(
        <PlayerCardStyleContext.Provider value={{ style, rolePlacement: "below" }}>
          <GameTable
            seats={[{ ...seats[0]!, role: "citizen" }]}
            onSeatClick={click}
            onSeatFoul={foul}
            onSeatPenalty={penalty}
          />
        </PlayerCardStyleContext.Provider>,
      );
      const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
      fireEvent.click(card);
      expect(click).toHaveBeenCalledExactlyOnceWith(1);
      swipeCard(card, 0, 80);
      expect(foul).toHaveBeenCalledExactlyOnceWith(1);
      fireEvent.click(card);
      expect(click).toHaveBeenCalledTimes(1);
      swipeCard(card, 0, -80);
      expect(penalty).toHaveBeenCalledExactlyOnceWith(1);
      expect(card).toHaveStyle({ touchAction: "none" });
    },
  );

  it("uses a neutral printed back for unknown giveaway roles and a face for deliberate preview", () => {
    const tree = (preview: boolean) => (
      <PlayerCardStyleContext.Provider value={{ style: "heritage", rolePlacement: "ribbon" }}>
        <GameTable
          seats={[
            {
              ...seats[0]!,
              role: "don",
              roleDraw: { dealt: false, ...(preview ? { role: "don" as const } : {}) },
            },
          ]}
        />
      </PlayerCardStyleContext.Provider>
    );
    const { rerender } = render(tree(false));
    const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(card).toHaveAttribute("data-card-face", "back");
    expect(card).not.toHaveTextContent(/don/i);
    expect(card.querySelector("[data-role-glyph],.role-draw-glow")).toBeNull();
    rerender(tree(true));
    expect(card).toHaveAttribute("data-card-face", "front");
    expect(card).toHaveTextContent(/don/i);
    expect(card.querySelector(".role-draw-glow")).toBeNull();
  });

  it("keeps printed read-only cards and public cues independent of hidden roles", () => {
    render(
      <PlayerCardStyleContext.Provider value={{ style: "noir", rolePlacement: "top" }}>
        <GameTable
          seats={[
            {
              ...seats[0]!,
              role: "sheriff",
              nominated: true,
              supportCount: 2,
              fouls: 2,
              muted: true,
              nominationSelected: true,
              voted: true,
              voteTargetSeat: 9,
            },
          ]}
          privacyHidden
          readOnly
        />
      </PlayerCardStyleContext.Provider>,
    );
    const card = screen.getByRole("group", { name: "Seat 1: Player 1" });
    expect(card).toHaveAttribute("data-card-style", "noir");
    expect(card).toHaveAttribute("data-card-face", "back");
    expect(card).not.toHaveTextContent(/sheriff/i);
    expect(card.querySelector(".card-nomination-symbol .lucide-hand")).not.toBeNull();
    expect(card.querySelector(".card-support")).toHaveTextContent("+2");
    expect(card.querySelector(".foul-markers")).not.toBeNull();
    expect(card.querySelector(".card-mute")).not.toBeNull();
    expect(card.querySelector(".state-badge")).toHaveTextContent("9");
    expect(card.querySelector("button")).toBeNull();
  });

  it("uses question marks on unknown giveaway faces, including the first-reveal old face, but not ordinary masked play", () => {
    const animate = vi.fn(() => ({ finished: new Promise(() => {}), cancel: vi.fn() }));
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    try {
      const { rerender, unmount } = render(
        <GameTable seats={[{ ...seats[0]!, roleDraw: { dealt: false } }]} />,
      );
      const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
      expect(card.querySelector('[data-role-glyph="unknown"]')).not.toBeNull();
      expect(card.querySelector('[role="img"],img')).toBeNull();
      rerender(
        <GameTable
          seats={[
            {
              ...seats[0]!,
              role: "mafia",
              roleDraw: {
                role: "mafia",
                dealt: true,
                request: { id: 1, startedAt: performance.now() },
              },
            },
          ]}
        />,
      );
      expect(animate).toHaveBeenCalledTimes(6);
      expect(animate.mock.contexts.slice(4)).toEqual([
        card.querySelector(":scope > .liquid-card-glass"),
        card.querySelector(":scope > .role-draw-glow"),
      ]);
      expect(
        card.querySelector('.role-draw-face--front [data-role-glyph="unknown"]'),
      ).not.toBeNull();
      expect(
        card.querySelector(".role-draw-face--front [aria-label],.role-draw-face--front img"),
      ).toBeNull();
      expect(card.querySelector('.role-draw-face--back [data-role-glyph="mafia"]')).not.toBeNull();
      rerender(<GameTable seats={[{ ...seats[0]!, roleDraw: { dealt: false } }]} />);
      expect(card.querySelector('[data-role-glyph="unknown"]')).not.toBeNull();
      rerender(<GameTable seats={[{ ...seats[0]!, role: "mafia" }]} privacyHidden />);
      expect(card.querySelector('[data-role-glyph="unknown"]')).toBeNull();
      expect(card.querySelector('[data-role-glyph="hidden"] circle')).not.toBeNull();
      unmount();
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "animate", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "animate");
    }
  });
  it("renders paired decorative indices, fixed hand/count and a sharp accessible role without pills", () => {
    const { container, rerender } = render(
      <GameTable
        seats={[
          {
            ...seats[0]!,
            role: "sheriff",
            nominated: true,
            supportCount: 9,
            nominationSelected: true,
            fouls: 3,
            muted: true,
          },
        ]}
      />,
    );
    const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(card.querySelectorAll(".card-index")).toHaveLength(2);
    for (const index of card.querySelectorAll(".card-index"))
      expect(index).toHaveAttribute("aria-hidden", "true");
    expect(card.querySelector(".card-index--lower")).toHaveTextContent("1");
    expect(card.querySelector(".card-nomination-symbol .lucide-hand")).not.toBeNull();
    expect(card.querySelector(".card-support svg")).toBeNull();
    expect(screen.getByRole("img", { name: "sheriff" })).toHaveClass("player-role-icon");
    expect(card.querySelector(".role-badge,.card-selection")).toBeNull();
    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(card).toHaveClass("is-nomination-selected");
    rerender(<GameTable seats={[{ ...seats[0]!, role: "sheriff" }]} privacyHidden />);
    expect(screen.queryByRole("img", { name: "sheriff" })).toBeNull();
    expect(container.querySelector('[data-role-glyph="sheriff"]')).toBeNull();
    expect(card.querySelector(".card-nomination-status")).not.toBeNull();
    expect(card.querySelector(".card-discipline-status")).not.toBeNull();
    expect(card.querySelector(".card-support")).toBeNull();
  });
  it.each(["citizen", "sheriff", "mafia", "don"] as const)(
    "keeps %s preview neutral and its dealt cue explicit without gameplay states",
    (role) => {
      const click = vi.fn();
      const seat = { ...seats[0]!, roleDraw: { role, dealt: false } };
      const { rerender } = render(<GameTable seats={[seat]} onSeatClick={click} />);
      const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
      expect(card).toHaveClass("role-draw-preview");
      expect(card).not.toHaveClass("is-role-dealt");
      expect(screen.getByRole("img", { name: role })).toBeInTheDocument();
      expect(card.querySelector(`[data-role-glyph="${role}"]`)).not.toBeNull();
      expect(card.querySelector(".role-draw-glow")).toBeNull();
      rerender(
        <GameTable
          seats={[{ ...seat, role, roleDraw: { role, dealt: true } }]}
          onSeatClick={click}
        />,
      );
      expect(screen.getByRole("button", { name: "Seat 1: Player 1" })).toBe(card);
      expect(card).toHaveClass("is-role-dealt");
      expect(card).not.toHaveClass(
        "role-draw-preview",
        "is-mafia-shooter",
        "is-sheriff-highlight",
        "is-voting-highlight",
        "is-exiting",
      );
      expect(card.querySelector(".role-draw-glow")).not.toBeNull();
      expect(card.querySelector(".deceased-cross")).toBeNull();
      fireEvent.click(card);
      expect(click).toHaveBeenCalledExactlyOnceWith(1);
      rerender(<GameTable seats={[seat]} privacyHidden />);
      expect(card).not.toHaveClass("is-role-dealt", "role-draw-preview", "role-draw-card");
      expect(card).not.toHaveTextContent(role);
      expect(card).not.toHaveAttribute("data-role-draw-role");
      expect(card.querySelector("[data-role-glyph]")).toHaveAttribute("data-role-glyph", "hidden");
    },
  );

  it("uses one capability-based native touch policy", () => {
    const horizontal = vi.fn();
    const penalty = vi.fn();
    const { rerender } = render(<GameTable seats={seats} onSeatSwipe={horizontal} />);
    const card = () => screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(card()).toHaveStyle({ touchAction: "pan-y pinch-zoom" });
    rerender(<GameTable seats={seats} onSeatSwipe={horizontal} onSeatPenalty={penalty} />);
    expect(card()).toHaveStyle({ touchAction: "none" });
    rerender(<GameTable seats={seats} onSeatFoul={penalty} />);
    expect(card()).toHaveStyle({ touchAction: "none" });
    rerender(<GameTable seats={seats} onSeatSwipe={horizontal} seatActionDisabled={() => true} />);
    expect(card().style.touchAction).toBe("");
    rerender(<GameTable seats={[{ ...seats[0]!, inactive: true }]} onSeatSwipe={horizontal} />);
    expect(card().style.touchAction).toBe("");
    rerender(<GameTable seats={seats} onSeatSwipe={horizontal} readOnly />);
    expect(screen.getByRole("group", { name: "Seat 1: Player 1" }).style.touchAction).toBe("");
  });
  it("leaves keys native without foul or context shortcuts and retains native button activation", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const foul = vi.fn();
    const swipe = vi.fn();
    const click = vi.fn();
    render(<GameTable seats={seats} onSeatFoul={foul} onSeatSwipe={swipe} onSeatClick={click} />);
    const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
    card.focus();
    for (const init of [{ key: "f" }, { key: "ContextMenu" }, { key: "F10", shiftKey: true }]) {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      fireEvent(card, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(foul).not.toHaveBeenCalled();
    expect(swipe).not.toHaveBeenCalled();
    expect(card).not.toHaveAttribute("aria-keyshortcuts");
    expect(card).toHaveAttribute("title", "Swipe down to issue a foul");
    await user.keyboard("{Enter} ");
    expect(click).toHaveBeenCalledTimes(2);
  });
  it("separates round support from surface-only current selection independently of tint", () => {
    const seat = { ...seats[0]!, nominated: true, supportCount: 9, nominationSelected: true };
    const { rerender } = render(
      <PlayerCardAppearanceContext.Provider
        value={{ ...DEFAULT_GLASS_SETTINGS, nominationTint: 0, nominationTreatment: "tint" }}
      >
        <GameTable seats={[seat]} />
      </PlayerCardAppearanceContext.Provider>,
    );
    const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(card).toHaveClass("is-nominated", "is-nomination-selected");
    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("img", { name: "Nominated" }).querySelector(".lucide-hand"),
    ).not.toBeNull();
    expect(screen.getByRole("img", { name: "Additional supporters: 9" })).toHaveTextContent("+9");
    expect(card.querySelector(".card-selection,.role-badge")).toBeNull();
    rerender(<GameTable seats={[{ ...seat, nominationSelected: false }]} readOnly />);
    expect(screen.getByRole("group", { name: "Seat 1: Player 1" })).not.toHaveClass(
      "is-nomination-selected",
    );
    expect(screen.getByRole("img", { name: "Additional supporters: 9" })).toHaveTextContent("+9");
  });

  it("issues one downward-swipe foul without a tap and keeps the next intentional tap usable", () => {
    const foul = vi.fn();
    const click = vi.fn();
    const penalty = vi.fn();
    const horizontal = vi.fn();
    render(
      <GameTable
        seats={seats}
        onSeatFoul={foul}
        onSeatClick={click}
        onSeatPenalty={penalty}
        onSeatSwipe={horizontal}
      />,
    );
    const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
    fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 102, clientY: 170 }] });
    fireEvent.click(card);
    expect(foul).toHaveBeenCalledExactlyOnceWith(1);
    expect(click).not.toHaveBeenCalled();
    expect(penalty).not.toHaveBeenCalled();
    expect(horizontal).not.toHaveBeenCalled();
    fireEvent.touchStart(card, { touches: [{ identifier: 2, clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ identifier: 2, clientX: 100, clientY: 100 }] });
    fireEvent.click(card);
    expect(click).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(["active", "red-carded"] as const)(
    "cancels the original swipe when a second finger touches another %s card",
    (status) => {
      const foul = vi.fn();
      const click = vi.fn();
      const penalty = vi.fn();
      const horizontal = vi.fn();
      render(
        <GameTable
          seats={[seats[0]!, { ...seats[1]!, status }]}
          onSeatFoul={foul}
          onSeatClick={click}
          onSeatPenalty={penalty}
          onSeatSwipe={horizontal}
        />,
      );
      const first = screen.getByRole("button", { name: "Seat 1: Player 1" });
      const second = screen.getByRole("button", { name: "Seat 2: Player 2" });
      const primary = { identifier: 1, clientX: 100, clientY: 100 };
      const secondary = { identifier: 2, clientX: 200, clientY: 100 };
      fireEvent.touchStart(first, { touches: [primary] });
      fireEvent.touchStart(second, { touches: [primary, secondary] });
      fireEvent.touchEnd(second, { touches: [primary], changedTouches: [secondary] });
      fireEvent.touchEnd(first, { touches: [], changedTouches: [{ ...primary, clientY: 170 }] });
      fireEvent.click(first);
      for (const action of [foul, click, penalty, horizontal])
        expect(action).not.toHaveBeenCalled();
      fireEvent.touchStart(first, { touches: [primary] });
      fireEvent.touchEnd(first, { touches: [], changedTouches: [primary] });
      fireEvent.click(first);
      expect(click).toHaveBeenCalledExactlyOnceWith(1);
    },
  );

  it.each(["tap", "downward swipe"])(
    "finishes a touch %s after implicit pointer capture is released",
    (gesture) => {
      const foul = vi.fn();
      const click = vi.fn();
      render(<GameTable seats={seats} onSeatFoul={foul} onSeatClick={click} />);
      const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
      const touch = { identifier: 1, clientX: 100, clientY: 100 };
      const pointer = (type: string) =>
        fireEvent(
          card,
          Object.assign(new MouseEvent(type, { bubbles: true }), {
            pointerId: 7,
            pointerType: "touch",
          }),
        );
      pointer("pointerdown");
      fireEvent.touchStart(card, { touches: [touch] });
      pointer("gotpointercapture");
      pointer("pointerup");
      pointer("lostpointercapture");
      fireEvent.touchEnd(card, {
        touches: [],
        changedTouches: [{ ...touch, clientY: gesture === "tap" ? 100 : 170 }],
      });
      fireEvent.click(card);
      if (gesture === "tap") {
        expect(click).toHaveBeenCalledExactlyOnceWith(1);
        expect(foul).not.toHaveBeenCalled();
      } else {
        expect(foul).toHaveBeenCalledExactlyOnceWith(1);
        expect(click).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps mouse and touch fouls independent of disabled taps and rejects cancelled gestures", () => {
    const foul = vi.fn();
    const click = vi.fn();
    const { rerender } = render(
      <GameTable
        seats={seats}
        onSeatFoul={foul}
        onSeatClick={click}
        seatActionDisabled={() => true}
      />,
    );
    const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(card).not.toBeDisabled();
    expect(card).toHaveAttribute("aria-disabled", "true");
    card.focus();
    swipeCard(card, 0, 70);
    expect(foul).toHaveBeenCalledExactlyOnceWith(1);
    fireEvent.keyDown(card, { key: "f", repeat: true });
    fireEvent.keyDown(card, { key: "f", ctrlKey: true });
    fireEvent.click(card);
    expect(click).not.toHaveBeenCalled();
    const pointer = (type: string, y: number) =>
      fireEvent(
        card,
        Object.assign(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: 100,
            clientY: y,
            button: 0,
          }),
          { pointerId: 3, pointerType: "mouse" },
        ),
      );
    const capture = vi.fn();
    Object.defineProperty(card, "setPointerCapture", { value: capture });
    pointer("pointerdown", 100);
    expect(capture).toHaveBeenCalledExactlyOnceWith(3);
    pointer("pointerup", 170);
    expect(foul).toHaveBeenCalledTimes(2);
    for (const cancellation of ["pointercancel", "lostpointercapture"]) {
      pointer("pointerdown", 100);
      pointer(cancellation, 170);
      pointer("pointerup", 180);
    }
    expect(foul).toHaveBeenCalledTimes(2);
    for (const kind of ["cancel", "multi", "short", "diagonal"] as const) {
      fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
      if (kind === "cancel") fireEvent.touchCancel(card);
      if (kind === "multi")
        fireEvent.touchMove(card, {
          touches: [
            { identifier: 1, clientX: 100, clientY: 110 },
            { identifier: 2, clientX: 110, clientY: 110 },
          ],
        });
      fireEvent.touchEnd(card, {
        changedTouches: [
          {
            identifier: 1,
            clientX: kind === "diagonal" ? 160 : 100,
            clientY: kind === "short" ? 125 : 170,
          },
        ],
      });
    }
    expect(foul).toHaveBeenCalledTimes(2);
    rerender(<GameTable seats={[{ ...seats[0]!, status: "red-carded" }]} onSeatFoul={foul} />);
    fireEvent.keyDown(card, { key: "f" });
    fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 100, clientY: 170 }] });
    expect(foul).toHaveBeenCalledTimes(2);
  });

  it("opens an upward penalty gesture independently of a disabled card action and suppresses its click", () => {
    const penalty = vi.fn();
    const click = vi.fn();
    const horizontal = vi.fn();
    const { rerender } = render(
      <GameTable
        seats={seats}
        onSeatPenalty={penalty}
        onSeatClick={click}
        onSeatSwipe={horizontal}
        seatActionDisabled={() => true}
      />,
    );
    const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(card).toBeDisabled();
    fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 180 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 104, clientY: 100 }] });
    expect(penalty).toHaveBeenCalledExactlyOnceWith(1);
    expect(horizontal).not.toHaveBeenCalled();
    rerender(<GameTable seats={seats} onSeatPenalty={penalty} onSeatClick={click} />);
    fireEvent.click(card);
    expect(click).not.toHaveBeenCalled();
  });

  it("ignores short, downward, diagonal, cancelled, multitouch and read-only penalty gestures", () => {
    const penalty = vi.fn();
    const { rerender } = render(<GameTable seats={seats} onSeatPenalty={penalty} />);
    const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
    for (const [x, y] of [
      [100, 150],
      [100, 260],
      [170, 110],
    ]) {
      fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 180 }] });
      fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: x, clientY: y }] });
    }
    fireEvent.touchStart(card, { touches: [{ identifier: 1, clientX: 100, clientY: 180 }] });
    fireEvent.touchCancel(card);
    fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
    fireEvent.touchStart(card, {
      touches: [
        { identifier: 1, clientX: 100, clientY: 180 },
        { identifier: 2, clientX: 120, clientY: 180 },
      ],
    });
    fireEvent.touchEnd(card, { changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
    rerender(<GameTable seats={seats} onSeatPenalty={penalty} readOnly />);
    const preview = screen.getByRole("group", { name: "Seat 1: Player 1" });
    fireEvent.touchStart(preview, { touches: [{ identifier: 1, clientX: 100, clientY: 180 }] });
    fireEvent.touchEnd(preview, {
      changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }],
    });
    expect(penalty).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "registers only player surface hosts with one first decorative glass child (readOnly: %s)",
    (readOnly) => {
      const onSeatClick = vi.fn();
      const { container } = render(
        <GameTable seats={seats} readOnly={readOnly} onSeatClick={onSeatClick} hostName="Host" />,
      );
      const cards = screen.getAllByRole(readOnly ? "group" : "button", { name: /^Seat \d+:/ });
      expect(cards).toHaveLength(10);
      expect(container.querySelectorAll("[data-player-glass]")).toHaveLength(cards.length);
      for (const card of cards) {
        expect(card).toHaveAttribute("data-player-glass", "table");
        expect(card.firstElementChild).toHaveClass("liquid-card-glass");
        expect(card.firstElementChild).toHaveAttribute("aria-hidden", "true");
        expect(card.querySelectorAll(".liquid-card-glass")).toHaveLength(1);
        expect(card.nextElementSibling).toHaveClass("player-seat-caption");
        expect(card.nextElementSibling).not.toHaveAttribute("data-player-glass");
      }
      if (!readOnly) {
        fireEvent.click(cards[6]!);
        expect(onSeatClick).toHaveBeenCalledExactlyOnceWith(7);
      }
    },
  );

  it("fades outgoing active light, reverses interrupted exits and releases the canvas", () => {
    vi.useFakeTimers();
    try {
      const tree = (currentVoter: boolean) => (
        <GameTable animateActive seats={[{ ...seats[0]!, currentVoter, voted: true }]} />
      );
      const { rerender, unmount } = render(tree(true));
      const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
      const canvas = card.querySelector(".vgpu-player-lighting");
      expect(canvas).not.toBeNull();
      expect(card).not.toHaveAttribute("aria-current");
      rerender(tree(false));
      expect(card).not.toHaveClass("is-current");
      expect(card.querySelector(".vgpu-player-lighting")).toBe(canvas);
      act(() => vi.advanceTimersByTime(100));
      rerender(tree(true));
      act(() => vi.advanceTimersByTime(300));
      expect(card.querySelector(".vgpu-player-lighting")).toBe(canvas);
      rerender(tree(false));
      act(() => vi.advanceTimersByTime(300));
      expect(card.querySelector(".vgpu-player-lighting")).toBeNull();
      rerender(tree(true));
      rerender(tree(false));
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears active lighting immediately with reduced motion and never retains private cues", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    try {
      const { container, rerender } = render(
        <GameTable animateActive seats={[{ ...seats[0]!, current: true, role: "sheriff" }]} />,
      );
      expect(container.querySelector("[aria-current=step]")).not.toBeNull();
      rerender(<GameTable animateActive seats={[seats[0]!]} privacyHidden />);
      expect(container.querySelector(".vgpu-player-lighting")).toBeNull();
      expect(container.querySelector(".role-badge")).toBeNull();
      rerender(<GameTable animateActive seats={[{ ...seats[0]!, sheriffHighlight: true }]} />);
      expect(container.querySelector(".vgpu-player-lighting")).not.toBeNull();
      rerender(
        <GameTable
          animateActive
          seats={[{ ...seats[0]!, sheriffHighlight: true }]}
          privacyHidden
        />,
      );
      expect(container.querySelector(".vgpu-player-lighting")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps other current-card uses outside the speaker/voter animation", () => {
    const { container, rerender } = render(<GameTable seats={[{ ...seats[0]!, current: true }]} />);
    expect(container.querySelector(".has-active-emphasis")).toBeNull();
    expect(container.querySelector(".active-player-lighting")).toBeNull();
    rerender(<GameTable seats={[seats[0]!]} />);
    expect(container.querySelector(".vgpu-player-lighting")).toBeNull();
  });

  it("shows reversible voted progress independently of role masking and keeps correction usable", () => {
    const onSeatClick = vi.fn();
    const { rerender } = render(
      <GameTable
        seats={[{ ...seats[0]!, role: "sheriff", voted: true, voteTargetSeat: 9 }]}
        privacyHidden
        onSeatClick={onSeatClick}
      />,
    );
    const card = screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(card).toHaveClass("is-voted");
    expect(card).not.toHaveClass("is-inactive", "is-dimmed");
    expect(card.querySelector(".role-badge")).toBeNull();
    expect(card.querySelector(".state-badge")).toHaveTextContent("9");
    fireEvent.click(card);
    expect(onSeatClick).toHaveBeenCalledWith(1);
    rerender(<GameTable seats={[seats[0]!]} privacyHidden onSeatClick={onSeatClick} />);
    expect(card).not.toHaveClass("is-voted");
    expect(card.querySelector(".state-badge")).toBeNull();
  });

  it("starts the ten-seat orbit at 198 degrees so seats 1 and 10 split the lower edge", () => {
    render(<GameTable seats={seats} hostName="Host Player" />);

    const playerCards = seats.map((seat, index) => {
      const card = screen.getByRole("button", { name: `Seat ${seat.seat}: ${seat.name}` });
      expect(card).toHaveTextContent(String(seat.seat));
      expect(card.parentElement).toHaveStyle({ "--seat-angle": `${198 + index * 36}deg` });
      return card;
    });

    expect(playerCards[0]!.parentElement).toHaveStyle({ "--seat-angle": "198deg" });
    expect(playerCards[9]!.parentElement).toHaveStyle({ "--seat-angle": "522deg" });
    expect(document.querySelectorAll(".seat-anchor")).toHaveLength(10);
    expect(playerCards).toHaveLength(10);
  });

  it("keeps player-seat click actions available on the ten-seat layout", () => {
    const onSeatClick = vi.fn();
    const onSeatSwipe = vi.fn();
    render(<GameTable seats={seats} onSeatClick={onSeatClick} onSeatSwipe={onSeatSwipe} />);

    fireEvent.click(screen.getByRole("button", { name: "Seat 7: Player 7" }));
    swipeCard(screen.getByRole("button", { name: "Seat 9: Player 9" }));

    expect(onSeatClick).toHaveBeenCalledOnce();
    expect(onSeatClick).toHaveBeenCalledWith(7);
    expect(onSeatSwipe).toHaveBeenCalledOnce();
    expect(onSeatSwipe).toHaveBeenCalledWith(9);
  });

  it("prepares a V-GPU table surface for the default renderer request", () => {
    const { container } = render(<GameTable seats={seats} />);

    expect(container.querySelector(".round-table > .vgpu-table-lighting-host")).not.toBeNull();
  });

  it("keeps identity separate from red foul dots and the pending-mute speech bubble", () => {
    const { rerender } = render(
      <GameTable
        seats={seats.map((seat) =>
          seat.seat === 1 ? { ...seat, role: "citizen", fouls: 1, nominated: true } : seat,
        )}
      />,
    );

    const player = screen.getByRole("button", { name: "Seat 1: Player 1" });
    expect(player.nextElementSibling).toHaveClass("player-seat-caption");
    expect(player.nextElementSibling).toHaveTextContent("Player 1");
    const badges = player.querySelector(".seat-badges");
    expect(screen.getByRole("img", { name: "citizen" })).toBeInTheDocument();
    expect(badges).not.toHaveTextContent("Foul");
    expect(screen.getByRole("img", { name: "Foul ×1" }).querySelectorAll(".foul-dot")).toHaveLength(
      1,
    );
    expect(player.querySelector('.card-nomination-status [aria-label="Nominated"]')).not.toBeNull();
    rerender(<GameTable seats={[{ ...seats[0]!, fouls: 3, muted: true }]} />);
    expect(screen.getByRole("img", { name: "Foul ×3" }).querySelectorAll(".foul-dot")).toHaveLength(
      3,
    );
    expect(
      screen.getByRole("img", { name: "Muted turn" }).querySelector(".lucide-message-circle-off"),
    ).not.toBeNull();
    rerender(<GameTable seats={[{ ...seats[0]!, fouls: 4, muted: false }]} />);
    expect(screen.getByRole("img", { name: "Foul ×4" }).querySelectorAll(".foul-dot")).toHaveLength(
      3,
    );
    expect(screen.queryByRole("img", { name: "Muted turn" })).toBeNull();
  });

  it("maps game-state highlights into V-GPU player lighting surfaces", () => {
    render(
      <GameTable
        seats={seats.map((seat) =>
          seat.seat === 1
            ? { ...seat, current: true }
            : seat.seat === 2
              ? { ...seat, mafiaShooter: true }
              : seat.seat === 3
                ? { ...seat, sheriffHighlight: true }
                : seat.seat === 4
                  ? { ...seat, goodbyeHighlight: true }
                  : seat.seat === 5
                    ? { ...seat, votingHighlight: true }
                    : seat,
        )}
      />,
    );

    for (const seat of [1, 2, 3, 4, 5]) {
      expect(
        screen
          .getByRole("button", { name: `Seat ${seat}: Player ${seat}` })
          .querySelector(".vgpu-player-lighting"),
      ).not.toBeNull();
    }
  });

  it("suppresses role-only CSS and GPU lighting inputs when masked without hiding attention cues", () => {
    const roleSeats = seats.map((seat) =>
      seat.seat === 2
        ? { ...seat, role: "mafia" as const, mafiaShooter: true }
        : seat.seat === 3
          ? { ...seat, role: "sheriff" as const, sheriffHighlight: true }
          : seat.seat === 4
            ? { ...seat, votingHighlight: true, nominated: true }
            : seat,
    );
    const { rerender } = render(<GameTable seats={roleSeats} privacyHidden />);
    for (const seat of [2, 3]) {
      const card = screen.getByRole("button", { name: `Seat ${seat}: Player ${seat}` });
      expect(card).not.toHaveClass(seat === 2 ? "is-mafia-shooter" : "is-sheriff-highlight");
      expect(card.querySelector(".vgpu-player-lighting")).toBeNull();
      expect(card.querySelector(".role-badge")).toBeNull();
    }
    const attention = screen.getByRole("button", { name: "Seat 4: Player 4" });
    expect(attention).toHaveClass("is-voting-highlight");
    expect(attention.querySelector(".vgpu-player-lighting")).not.toBeNull();
    expect(
      attention.querySelector('.card-nomination-status [aria-label="Nominated"]'),
    ).not.toBeNull();
    rerender(<GameTable seats={roleSeats} />);
    expect(screen.getByRole("button", { name: "Seat 2: Player 2" })).toHaveClass(
      "is-mafia-shooter",
    );
    expect(screen.getByRole("button", { name: "Seat 3: Player 3" })).toHaveClass(
      "is-sheriff-highlight",
    );
  });

  it("adds a visual cross to an eliminated player", () => {
    const { container } = render(
      <GameTable
        seats={seats.map((seat) => (seat.seat === 1 ? { ...seat, status: "eliminated" } : seat))}
      />,
    );

    expect(screen.getByRole("button", { name: "Seat 1: Player 1" })).toHaveClass(
      "status-eliminated",
    );
    expect(container.querySelector(".deceased-cross")).not.toBeNull();
  });

  it("keeps information in the center and a persistent advance control below it", () => {
    const { container, rerender } = render(
      <GameTable
        seats={seats}
        center={<strong>Phase information</strong>}
        advance={<button disabled>Resolve phase</button>}
      />,
    );

    expect(container.querySelector(".table-center")).toHaveTextContent("Phase information");
    expect(container.querySelector(".table-center button")).toBeNull();
    expect(container.querySelector(".table-advance")).toContainElement(
      screen.getByRole("button", { name: "Resolve phase" }),
    );
    expect(screen.getByRole("button", { name: "Resolve phase" })).toBeDisabled();

    rerender(<GameTable seats={seats} center={<strong>Waiting</strong>} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it.each([-60, 60])(
    "retains the generic setup role gesture for %ipx without a click",
    (deltaX) => {
      const onSeatClick = vi.fn(),
        onSeatSwipe = vi.fn();
      render(<GameTable seats={seats} onSeatSwipe={onSeatSwipe} onSeatClick={onSeatClick} />);
      const player = screen.getByRole("button", { name: "Seat 1: Player 1" });
      player.focus();
      swipeCard(player, deltaX);
      fireEvent.click(player);
      expect(onSeatSwipe).toHaveBeenCalledExactlyOnceWith(1);
      expect(onSeatClick).not.toHaveBeenCalled();
      expect(player).toHaveFocus();
      expect(document.querySelector(".table-swipe-menu, .table-swipe-backdrop")).toBeNull();
    },
  );

  it("does not open an action menu for vertical, short or cancelled gestures", () => {
    const onSeatSwipe = vi.fn();
    render(<GameTable seats={seats} onSeatSwipe={onSeatSwipe} />);
    const player = screen.getByRole("button", { name: "Seat 1: Player 1" });
    for (const [x, y] of [
      [110, 140],
      [130, 42],
    ]) {
      fireEvent.touchStart(player, { touches: [{ clientX: 100, clientY: 40 }] });
      fireEvent.touchEnd(player, { changedTouches: [{ clientX: x, clientY: y }] });
    }
    fireEvent.touchStart(player, { touches: [{ clientX: 100, clientY: 40 }] });
    fireEvent.touchCancel(player);
    fireEvent.touchEnd(player, { changedTouches: [{ clientX: 170, clientY: 42 }] });
    expect(onSeatSwipe).not.toHaveBeenCalled();
  });

  it.each([
    ["eliminated", { status: "eliminated" as const }],
    ["otherwise inactive", { inactive: true }],
  ])("does not advertise or open context actions for %s seats", (_, state) => {
    const onSeatSwipe = vi.fn();
    render(
      <GameTable
        seats={seats.map((seat) => (seat.seat === 1 ? { ...seat, ...state } : seat))}
        onSeatSwipe={onSeatSwipe}
      />,
    );
    const player = screen.getByRole("button", { name: "Seat 1: Player 1" });

    expect(player).not.toHaveAttribute("aria-haspopup");
    fireEvent.keyDown(player, { key: "F10", shiftKey: true });
    expect(onSeatSwipe).not.toHaveBeenCalled();
  });
});
