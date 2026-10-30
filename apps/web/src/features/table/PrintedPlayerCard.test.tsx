import { StrictMode, type ComponentProps } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";
import { playerExitMotion } from "../effects/player-exit-motion.js";
import { playerDepartureTimeline } from "../effects/player-departure-timeline.js";
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
  const timelineDescriptor = Object.getOwnPropertyDescriptor(document, "timeline");
  let animations: Array<{
    target: HTMLElement;
    frames: Keyframe[];
    options: KeyframeAnimationOptions;
    cancel: ReturnType<typeof vi.fn>;
    resolve: () => void;
    startTime: number | null;
    currentTime: number | null;
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
        startTime: null as number | null,
        currentTime: null as number | null,
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
    if (timelineDescriptor) Object.defineProperty(document, "timeline", timelineDescriptor);
    else Reflect.deleteProperty(document, "timeline");
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
      expect(container.querySelector(".printed-player-card__name,.seat-name")).toBeNull();
      rerender(fixture({ style, role: "mafia" }));
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
      expect(Boolean(label.closest(".printed-player-card__role-band"))).toBe(
        rolePlacement === "ribbon",
      );
      expect(container.innerHTML).not.toMatch(/data-role="citizen"|role-citizen/);
    },
  );

  it.each([undefined, "unknown", "mafia", "vote", "discipline"] as const)(
    "keeps the %s reverse free of player names while retaining nonsecret status",
    (departureCause) => {
      const { container } = render(
        fixture({ faceDown: true, privacyHidden: true, role: undefined, departureCause }),
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
      expect(container.querySelector(".printed-player-card__name,.seat-name")).toBeNull();
      expect(screen.getByLabelText("Nominated")).toBeInTheDocument();
      expect(screen.getByLabelText("Three fouls")).toBeInTheDocument();
      expect(screen.getByText("Vote → 4")).toBeInTheDocument();
      expect(container.querySelector(".printed-player-card__role,.deceased-cross")).toBeNull();
      expect(animate).not.toHaveBeenCalled();
    },
  );

  it("turns privacy on and off without a gameplay request, keeping one public status rail and no hidden role text", async () => {
    const { container, rerender } = render(fixture());
    rerender(fixture({ faceDown: true, privacyHidden: true, role: undefined }));
    expect(animate).toHaveBeenCalledTimes(5);
    expect(container.innerHTML).not.toMatch(/sheriff|data-role-glyph/);
    expect(screen.getAllByLabelText("Nominated")).toHaveLength(1);
    await act(async () => animations.forEach(({ resolve }) => resolve()));
    expect(container.querySelector(".printed-player-card__outgoing")).toBeNull();
    rerender(fixture());
    expect(animate).toHaveBeenCalledTimes(10);
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
    expect(animate).toHaveBeenCalledTimes(5);
    expect(animations[0]!.target).toHaveClass("player-seat");
    expect(animations[1]!.target).toBe(animations[0]!.target);
    const motion = playerExitMotion(DEFAULT_PLAYER_EXIT_SETTINGS);
    expect(animations[0]!.frames).toEqual(motion.lift);
    expect(animations[1]!.frames).toEqual(motion.turn);
    expect(animations[2]!.frames).toEqual(motion.front);
    expect(animations[3]!.frames).toEqual(motion.back);
    expect(animations[4]!.target).toHaveClass("printed-player-card__public");
    expect(animations[4]!.frames).toEqual(
      motion.turn.map((frame) => ({
        ...frame,
        rotate: `y ${-Number.parseFloat(String(frame.rotate).split(/\s+/).at(-1)!)}deg`,
      })),
    );
    expect(container.querySelector(".printed-player-card__outgoing")).toHaveTextContent("sheriff");
    expect(screen.getAllByLabelText("Nominated")).toHaveLength(1);
    expect(screen.getByLabelText("Nominated").closest(".printed-player-card__motion")).toBeNull();
    rerender(fixture({ roleDrawRequest: { ...request }, onRoleDrawComplete: complete }));
    expect(animate).toHaveBeenCalledTimes(5);
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
    expect(animate).toHaveBeenCalledTimes(5);
    rerender(fixture({ roleDrawRequest: draw(2, "sheriff"), onRoleDrawComplete: complete }));
    expect(animate).toHaveBeenCalledTimes(10);
  });

  it("rotates the semantic host with its glow and counter-turns one public overlay", () => {
    const { container, rerender } = render(fixture());
    const host = container.querySelector(".player-seat")!;
    rerender(fixture({ roleDrawRequest: draw(71, "sheriff") }));
    expect(container.querySelector(".player-seat")).toBe(host);
    const publicOverlay = container.querySelector(".printed-player-card__public")!;
    const turns = animations.filter(({ frames }) => frames.some((frame) => "rotate" in frame));
    expect(turns.find(({ target }) => target === host)?.frames).toEqual(
      playerExitMotion(DEFAULT_PLAYER_EXIT_SETTINGS).turn,
    );
    expect(publicOverlay).not.toBeNull();
    expect(turns.find(({ target }) => target === publicOverlay)?.frames.at(-1)?.rotate).toBe(
      "y -180deg",
    );
    expect(container.querySelectorAll(".printed-player-card__status")).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(
      animations.some(({ target }) => target.classList.contains("printed-player-card__motion")),
    ).toBe(false);
    expect(container.querySelector(".printed-player-card")).toHaveAttribute("data-turning", "true");
  });

  it.each(["unknown", "mafia", "vote", "discipline"] as const)(
    "anchors %s pose, public inverse and departure effects to one native clock",
    (cause) => {
      vi.spyOn(performance, "now").mockReturnValue(100);
      Object.defineProperty(document, "timeline", {
        configurable: true,
        value: { currentTime: 100 },
      });
      const { rerender } = render(fixture());
      rerender(
        fixture({
          faceDown: true,
          departureCause: cause,
          exitRequest: { ...exit(72), startedAt: 80, cause },
        }),
      );
      const count = cause === "unknown" ? 6 : cause === "mafia" ? 8 : 7;
      expect(animations).toHaveLength(count);
      expect(animations.map(({ startTime }) => startTime)).toEqual(Array(count).fill(80));
      expect(
        animations.filter(({ frames }) => frames.some((frame) => "--player-exit-fade" in frame)),
      ).toHaveLength(1);
      expect(animations.flatMap(({ frames }) => frames).some((frame) => "opacity" in frame)).toBe(
        false,
      );
      expect(
        animations.some(({ target }) => target.classList.contains("printed-player-card__motion")),
      ).toBe(false);
    },
  );

  it("keeps filled tracks until the settled React commit", async () => {
    const snapshots: boolean[] = [];
    let retainedAtCompletion = false;
    const complete = vi.fn(() => {
      retainedAtCompletion = animations.every(({ cancel }) => cancel.mock.calls.length === 0);
    });
    const { container, rerender } = render(fixture());
    rerender(fixture({ roleDrawRequest: draw(91), onRoleDrawComplete: complete }));
    for (const animation of animations) {
      const cancel = animation.cancel.getMockImplementation() as () => void;
      animation.cancel.mockImplementation(() => {
        snapshots.push(
          container.querySelector(
            ".printed-player-card__incoming,.printed-player-card__outgoing,[data-turning]",
          ) === null,
        );
        cancel();
      });
    }
    await act(async () => animations.forEach(({ resolve }) => resolve()));
    expect(complete).toHaveBeenCalledExactlyOnceWith(91);
    expect(retainedAtCompletion).toBe(true);
    expect(snapshots).toEqual(Array(5).fill(true));
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("commits the static face before cancelling partial startup and never replays its retained request", async () => {
    const snapshots: boolean[] = [];
    let retainedAtCompletion = false;
    const complete = vi.fn(() => {
      retainedAtCompletion = animations.every(({ cancel }) => cancel.mock.calls.length === 0);
    });
    const { container, rerender } = render(fixture());
    const start = animate.getMockImplementation() as (
      this: HTMLElement,
      ...args: unknown[]
    ) => (typeof animations)[number];
    animate.mockImplementationOnce(function (this: HTMLElement, ...args: unknown[]) {
      const animation = start.apply(this, args);
      const cancel = animation.cancel.getMockImplementation() as () => void;
      animation.cancel.mockImplementation(() => {
        snapshots.push(
          container.querySelector(
            ".printed-player-card__incoming,.printed-player-card__outgoing,[data-turning]",
          ) === null,
        );
        cancel();
      });
      return animation;
    });
    animate.mockImplementationOnce(() => {
      throw new Error("Unsupported rotation");
    });
    const props = { roleDrawRequest: draw(92), onRoleDrawComplete: complete };
    rerender(fixture(props));
    expect(complete).toHaveBeenCalledExactlyOnceWith(92);
    expect(retainedAtCompletion).toBe(true);
    expect(snapshots).toEqual([true]);
    expect(animations[0]!.cancel).toHaveBeenCalledTimes(1);
    const starts = animate.mock.calls.length;
    rerender(fixture(props));
    expect(animate).toHaveBeenCalledTimes(starts);
    expect(vi.getTimerCount()).toBe(0);
    expect(change.size).toBe(0);
    await act(async () => {});
  });

  it("retains partial cause effects until the departure's static commit", async () => {
    const snapshots: boolean[] = [];
    let retainedAtCompletion = false;
    const complete = vi.fn(() => {
      retainedAtCompletion = animations.every(({ cancel }) => cancel.mock.calls.length === 0);
    });
    const { container, rerender } = render(fixture());
    const start = animate.getMockImplementation() as (
      this: HTMLElement,
      ...args: unknown[]
    ) => (typeof animations)[number];
    animate.mockImplementation(function (this: HTMLElement, ...args: unknown[]) {
      if (animate.mock.calls.length === 7) throw new Error("Unsupported recoil");
      const animation = start.apply(this, args);
      const cancel = animation.cancel.getMockImplementation() as () => void;
      animation.cancel.mockImplementation(() => {
        snapshots.push(
          container.querySelector(
            ".printed-player-card__incoming,.printed-player-card__outgoing,[data-turning]",
          ) === null,
        );
        cancel();
      });
      return animation;
    });
    const props: Partial<Props> = {
      faceDown: true,
      role: undefined,
      departureCause: "mafia",
      exitRequest: { ...exit(93), cause: "mafia" },
      onExitComplete: complete,
    };
    rerender(fixture(props));
    expect(complete).toHaveBeenCalledExactlyOnceWith(93);
    expect(retainedAtCompletion).toBe(true);
    expect(snapshots).toEqual(Array(6).fill(true));
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true);
    expect(container.querySelectorAll(".player-bullet-hole")).toHaveLength(3);
    rerender(fixture(props));
    expect(animate).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {});
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
    expect(animate).toHaveBeenCalledTimes(6);
    const timeline = playerDepartureTimeline(request.settings, "unknown");
    expect(animations[1]!.frames).toEqual(timeline.turn);
    expect(animations[0]!.options.duration).toBe(timeline.duration);
    expect(timeline.duration).toBe(1050 + request.settings.fadeMs);
    expect(container.innerHTML).not.toMatch(/sheriff|deceased-cross/);
    await act(async () => animations.forEach(({ resolve }) => resolve()));
    expect(complete).toHaveBeenCalledExactlyOnceWith(8);
    rerender(fixture({ faceDown: true, privacyHidden: true, role: undefined }));
    rerender(fixture({ faceDown: true, role: undefined }));
    expect(animate).toHaveBeenCalledTimes(6);
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
    expect(animate).toHaveBeenCalledTimes(5);
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
