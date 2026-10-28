import { StrictMode, type ComponentProps } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { playerExitMotion } from "../effects/player-exit-motion.js";
import { DEFAULT_PLAYER_EXIT_SETTINGS } from "../effects/player-exit-preferences.js";
import { getCardArtwork } from "./card-decks.js";
import { PrintedPlayerCard } from "./PrintedPlayerCard.js";

type Props = ComponentProps<typeof PrintedPlayerCard>;
const draw = (id: number, previousRole: Props["role"] = "citizen") => ({
  id,
  startedAt: performance.now(),
  previousRole,
});
const exit = (id: number) => ({
  id,
  startedAt: performance.now(),
  settings: DEFAULT_PLAYER_EXIT_SETTINGS,
  hideRole: false,
});
const fixture = (props: Partial<Props> = {}, fancy = true) => (
  <FancyFeaturesContext.Provider value={fancy}>
    <button
      type="button"
      className="table-card player-seat"
      data-card-style={props.style ?? "classic"}
    >
      <PrintedPlayerCard
        style="classic"
        seat={7}
        name="Alexander"
        suit="♥"
        role="sheriff"
        rolePlacement="below"
        faceDown={false}
        privacyHidden={false}
        {...props}
      >
        <span className="card-nomination-status" aria-label="Nominated">
          +9
        </span>
        <span className="card-discipline-status" aria-label="Three fouls">
          •••
        </span>
        <span className="seat-badges">Vote → 4</span>
      </PrintedPlayerCard>
    </button>
  </FancyFeaturesContext.Provider>
);

describe("PrintedPlayerCard", () => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  let animations: Array<{
    target: HTMLElement;
    frames: Keyframe[];
    options: KeyframeAnimationOptions;
    cancel: ReturnType<typeof vi.fn>;
    resolve: () => void;
  }>;
  let animate: ReturnType<typeof vi.fn>;
  let reduced: boolean;
  let change: Set<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    animations = [];
    reduced = false;
    change = new Set();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return reduced;
        },
        addEventListener: (_event: string, listener: () => void) => change.add(listener),
        removeEventListener: (_event: string, listener: () => void) => change.delete(listener),
      })),
    );
    animate = vi.fn(function (
      this: HTMLElement,
      frames: Keyframe[],
      options: KeyframeAnimationOptions,
    ) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const finished = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const animation = {
        target: this,
        frames,
        options,
        finished,
        resolve,
        cancel: vi.fn(() => reject(new Error("Animation cancelled"))),
      };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  });

  afterEach(() => {
    cleanup();
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "animate", descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(["classic", "heritage", "noir"] as const)(
    "renders %s artwork with agreeing opposite indices and no role avatar or nested control",
    (style) => {
      const { container, rerender } = render(fixture({ style }));
      const artwork = container.querySelector<HTMLImageElement>(".printed-player-card__art");
      expect(artwork).toHaveAttribute("src", getCardArtwork(style, 7).front);
      expect(artwork).toHaveAttribute("alt", "");
      const indices = container.querySelectorAll(".printed-player-card__index");
      expect(indices).toHaveLength(2);
      expect(indices[0]).toHaveTextContent("7♥");
      expect(indices[1]).toHaveTextContent("7♥");
      expect(indices[1]).toHaveClass("printed-player-card__index--lower");
      expect(screen.getByText("sheriff")).toBeInTheDocument();
      expect(container.querySelector(".person-icon,.player-role-icon,.deceased-cross")).toBeNull();
      expect(container.querySelectorAll("button")).toHaveLength(1);
      rerender(fixture({ style, name: "A very long replacement name", role: "mafia" }));
      expect(artwork).toHaveAttribute("src", getCardArtwork(style, 7).front);
      expect(animate).not.toHaveBeenCalled();
    },
  );

  it.each(["below", "ribbon", "top"] as const)(
    "uses localized role text and the %s placement without role classes or attributes",
    (rolePlacement) => {
      const { container } = render(
        <I18nProvider locale="ru">{fixture({ role: "citizen", rolePlacement })}</I18nProvider>,
      );
      const label = screen.getByText("Мирный житель");
      expect(container.querySelector(".printed-player-card")).toHaveAttribute(
        "data-role-placement",
        rolePlacement,
      );
      expect(Boolean(label.closest(".printed-player-card__name-band"))).toBe(
        rolePlacement === "ribbon",
      );
      expect(container.innerHTML).not.toMatch(/data-role="citizen"|role-citizen/);
    },
  );

  it.each(["privacy", "departure", "unrevealed"])(
    "mounts only a role-neutral back for %s while keeping identity and all nonsecret status",
    (mode) => {
      const { container } = render(
        fixture({ faceDown: true, privacyHidden: mode === "privacy", role: undefined }),
      );
      expect(
        container.querySelector(
          ".printed-player-card__art,.printed-player-card__role,.printed-player-card__outgoing",
        ),
      ).toBeNull();
      expect(container.querySelector(".printed-player-card__back-art")).toHaveAttribute(
        "src",
        getCardArtwork("classic", 7).back,
      );
      expect(screen.getByText("7 · Alexander")).toBeInTheDocument();
      expect(screen.getByLabelText("Nominated")).toBeInTheDocument();
      expect(screen.getByLabelText("Three fouls")).toBeInTheDocument();
      expect(screen.getByText("Vote → 4")).toBeInTheDocument();
      expect(container.innerHTML).not.toMatch(/sheriff|mafia|don|citizen|deceased-cross/);
      expect(animate).not.toHaveBeenCalled();
    },
  );

  it("turns privacy on and off without a gameplay request, keeping one public status rail and no hidden role text", async () => {
    const { container, rerender } = render(fixture());
    rerender(fixture({ faceDown: true, privacyHidden: true, role: undefined }));
    expect(animate).toHaveBeenCalledTimes(4);
    expect(container.innerHTML).not.toMatch(/sheriff|data-role-glyph/);
    expect(screen.getAllByLabelText("Nominated")).toHaveLength(1);
    await act(async () => animations.forEach(({ resolve }) => resolve()));
    expect(container.querySelector(".printed-player-card__outgoing")).toBeNull();
    rerender(fixture());
    expect(animate).toHaveBeenCalledTimes(8);
    expect(
      container.querySelector(".printed-player-card__outgoing .printed-player-card__back-art"),
    ).not.toBeNull();
    expect(container.querySelector(".printed-player-card__current")).toHaveTextContent("sheriff");
    await act(async () => animations.forEach(({ resolve }) => resolve()));
    expect(container.querySelector(".printed-player-card__outgoing")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles an exit already present at mount without inventing an old public departure", () => {
    const complete = vi.fn();
    const request = exit(7);
    const props = {
      faceDown: true,
      role: undefined,
      exitRequest: request,
      onExitComplete: complete,
    };
    const { container, rerender } = render(fixture(props));
    rerender(fixture({ ...props, exitRequest: { ...request } }));
    expect(complete).toHaveBeenCalledExactlyOnceWith(7);
    expect(animate).not.toHaveBeenCalled();
    expect(container.querySelector(".printed-player-card__back-art")).toBeInTheDocument();
  });

  it("settles requests already present at mount, including StrictMode and style remounts, without replay", () => {
    const complete = vi.fn();
    const request = draw(1);
    const { rerender } = render(
      <StrictMode>
        {fixture({ roleDrawRequest: request, onRoleDrawComplete: complete })}
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        {fixture({ roleDrawRequest: { ...request }, onRoleDrawComplete: complete }, false)}
      </StrictMode>,
    );
    expect(complete).toHaveBeenCalledExactlyOnceWith(1);
    expect(animate).not.toHaveBeenCalled();
  });

  it("turns the whole printed surface once for each accepted same-role reroll, removes the outgoing face and stays upright even if the caller retains its request", async () => {
    const complete = vi.fn();
    const { container, rerender } = render(fixture());
    const request = draw(1, "sheriff");
    rerender(fixture({ roleDrawRequest: request, onRoleDrawComplete: complete }));
    expect(animate).toHaveBeenCalledTimes(4);
    expect(animations[0]!.target).toHaveClass("printed-player-card__motion");
    expect(animations[1]!.target).toBe(animations[0]!.target);
    const motion = playerExitMotion(DEFAULT_PLAYER_EXIT_SETTINGS);
    expect(animations[0]!.frames).toEqual(motion.lift);
    expect(animations[1]!.frames).toEqual(motion.turn);
    expect(animations[2]!.frames).toEqual(motion.front);
    expect(animations[3]!.frames).toEqual(motion.back);
    expect(container.querySelector(".printed-player-card__outgoing")).toHaveTextContent("sheriff");
    expect(screen.getAllByLabelText("Nominated")).toHaveLength(1);
    expect(screen.getByLabelText("Nominated").closest(".printed-player-card__motion")).toBeNull();
    rerender(fixture({ roleDrawRequest: { ...request }, onRoleDrawComplete: complete }));
    expect(animate).toHaveBeenCalledTimes(4);
    await act(async () => animations.forEach(({ resolve }) => resolve()));
    expect(complete).toHaveBeenCalledExactlyOnceWith(1);
    expect(container.querySelector(".printed-player-card__outgoing")).toBeNull();
    expect(container.querySelector(".printed-player-card__current")).not.toHaveClass(
      "printed-player-card__incoming",
    );
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    rerender(fixture({ roleDrawRequest: request, onRoleDrawComplete: complete }, false));
    rerender(fixture({ roleDrawRequest: request, onRoleDrawComplete: complete }, true));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(4);
    rerender(fixture({ roleDrawRequest: draw(2, "sheriff"), onRoleDrawComplete: complete }));
    expect(animate).toHaveBeenCalledTimes(8);
  });

  it("reveals a previously down card from its neutral reverse without exposing the previousRole", () => {
    const { container, rerender } = render(fixture({ faceDown: true, role: undefined }));
    rerender(fixture({ roleDrawRequest: draw(1, "don") }));
    const outgoing = container.querySelector(".printed-player-card__outgoing");
    expect(outgoing?.querySelector(".printed-player-card__back-art")).not.toBeNull();
    expect(outgoing).not.toHaveTextContent("don");
    expect(container.querySelector(".printed-player-card__current")).toHaveTextContent("sheriff");
  });

  it("scrubs both faces immediately on privacy during a reveal, flips to the uniform back and preserves status", () => {
    const complete = vi.fn();
    const { container, rerender } = render(fixture());
    const request = draw(1, "don");
    rerender(fixture({ roleDrawRequest: request, onRoleDrawComplete: complete }));
    expect(container.querySelector(".printed-player-card__outgoing")).toHaveTextContent("don");
    rerender(
      fixture({
        faceDown: true,
        privacyHidden: true,
        role: undefined,
        roleDrawRequest: request,
        onRoleDrawComplete: complete,
      }),
    );
    expect(container.innerHTML).not.toMatch(/sheriff|\bdon\b|data-role-glyph|deceased-cross/);
    expect(complete).toHaveBeenCalledExactlyOnceWith(1);
    expect(
      container.querySelector(".printed-player-card__current .printed-player-card__back-art"),
    ).toHaveAttribute("src", getCardArtwork("classic", 7).back);
    expect(screen.getByLabelText("Three fouls")).toBeInTheDocument();
  });

  it("honors departure settings while removing the outgoing role before the turn and retaining a neutral reverse", async () => {
    const complete = vi.fn();
    const { container, rerender } = render(fixture());
    const request = {
      ...exit(8),
      settings: { ...DEFAULT_PLAYER_EXIT_SETTINGS, liftMs: 250, landingMs: 800, overlap: 35 },
    };
    rerender(
      fixture({ faceDown: true, role: undefined, exitRequest: request, onExitComplete: complete }),
    );
    expect(animate).toHaveBeenCalledTimes(4);
    expect(animations[1]!.frames).toEqual(playerExitMotion(request.settings).turn);
    expect(animations[0]!.options.duration).toBe(1050);
    expect(container.innerHTML).not.toMatch(/sheriff|deceased-cross/);
    await act(async () => animations.forEach(({ resolve }) => resolve()));
    expect(complete).toHaveBeenCalledExactlyOnceWith(8);
    rerender(fixture({ faceDown: true, privacyHidden: true, role: undefined }));
    rerender(fixture({ faceDown: true, role: undefined }));
    expect(animate).toHaveBeenCalledTimes(4);
    expect(container.querySelector(".printed-player-card__back-art")).toBeInTheDocument();
  });

  it("does not animate Undo/correction or a style change, nor replay a retained request", () => {
    const complete = vi.fn();
    const { container, rerender } = render(fixture({ faceDown: true, role: undefined }));
    rerender(fixture());
    expect(animate).not.toHaveBeenCalled();
    const request = draw(1);
    rerender(fixture({ roleDrawRequest: request, onRoleDrawComplete: complete }));
    rerender(fixture({ style: "noir", roleDrawRequest: request, onRoleDrawComplete: complete }));
    expect(complete).toHaveBeenCalledExactlyOnceWith(1);
    expect(container.querySelector(".printed-player-card__outgoing")).toBeNull();
    expect(container.querySelector(".printed-player-card__art")).toHaveAttribute(
      "src",
      getCardArtwork("noir", 7).front,
    );
    expect(animate).toHaveBeenCalledTimes(4);
  });

  it.each(["fancy", "reduced", "hidden", "unsupported", "expired", "disabled-exit"])(
    "settles %s requests exactly once without timers or replay",
    (mode) => {
      const complete = vi.fn();
      const { container, rerender } = render(fixture());
      if (mode === "reduced") reduced = true;
      if (mode === "hidden") vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      if (mode === "unsupported") Reflect.deleteProperty(HTMLElement.prototype, "animate");
      const request = {
        ...draw(1),
        ...(mode === "expired" ? { startedAt: performance.now() - 1000 } : {}),
      };
      const props =
        mode === "disabled-exit"
          ? {
              faceDown: true,
              role: undefined,
              exitRequest: {
                ...exit(1),
                settings: { ...DEFAULT_PLAYER_EXIT_SETTINGS, enabled: false },
              },
              onExitComplete: complete,
            }
          : { roleDrawRequest: request, onRoleDrawComplete: complete };
      rerender(fixture(props, mode !== "fancy"));
      rerender(fixture(props));
      expect(complete).toHaveBeenCalledExactlyOnceWith(1);
      expect(animate).not.toHaveBeenCalled();
      expect(container.querySelector(".printed-player-card__outgoing")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["fancy", "hidden", "reduced"])(
    "immediately cancels all live animation and settles when %s interrupts",
    async (mode) => {
      const complete = vi.fn();
      const { container, rerender } = render(fixture());
      const request = draw(1);
      const props = { roleDrawRequest: request, onRoleDrawComplete: complete };
      rerender(fixture(props));
      act(() => {
        if (mode === "fancy") rerender(fixture(props, false));
        else if (mode === "hidden") {
          vi.spyOn(document, "hidden", "get").mockReturnValue(true);
          document.dispatchEvent(new Event("visibilitychange"));
        } else {
          reduced = true;
          change.forEach((listener) => listener());
        }
      });
      expect(complete).toHaveBeenCalledExactlyOnceWith(1);
      expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
      expect(container.querySelector(".printed-player-card__outgoing")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => animations.forEach(({ resolve }) => resolve()));
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );

  it("supersedes newer requests and unmounts without obsolete callbacks, animation or timers", async () => {
    const complete = vi.fn();
    const { rerender, unmount } = render(fixture());
    rerender(fixture({ roleDrawRequest: draw(1), onRoleDrawComplete: complete }));
    const old = [...animations];
    rerender(fixture({ roleDrawRequest: draw(2), onRoleDrawComplete: complete }));
    await act(async () => old.forEach(({ resolve }) => resolve()));
    expect(complete).not.toHaveBeenCalled();
    unmount();
    await act(async () => animations.forEach(({ resolve }) => resolve()));
    expect(complete).not.toHaveBeenCalled();
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(change.size).toBe(0);
  });

  it("handles partial WAAPI failure and a never-resolving finished promise with bounded cleanup", async () => {
    const complete = vi.fn();
    const { container, rerender } = render(fixture());
    animate.mockImplementationOnce(animate.getMockImplementation()!);
    animate.mockImplementationOnce(() => {
      throw new Error("Unsupported rotation");
    });
    rerender(fixture({ roleDrawRequest: draw(1), onRoleDrawComplete: complete }));
    expect(complete).toHaveBeenCalledExactlyOnceWith(1);
    expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".printed-player-card__outgoing")).toBeNull();
    rerender(fixture({ roleDrawRequest: draw(2), onRoleDrawComplete: complete }));
    act(() => vi.runAllTimers());
    expect(complete).toHaveBeenLastCalledWith(2);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {});
  });
});
