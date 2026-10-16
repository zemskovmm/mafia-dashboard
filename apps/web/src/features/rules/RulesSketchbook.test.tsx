import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RulesSketchbook from "./RulesSketchbook.js";
import type { RulesChapter } from "./rules-types.js";

const chapter = (id: string, reference?: string): RulesChapter => ({
  id,
  reference,
  art: "club",
  source: "MAFGAME · 2026-04-28",
  en: {
    title: ["A city of", "secrets."],
    name: id,
    tag: "THE CLUB EDITION",
    plate: "An evening at the club",
    note: "Trust carefully.",
    lede: "A readable club guide.",
    paragraphs: [`Exact English text for ${id}.`],
    margin: "An authored guide, not an official translation.",
  },
  ru: {
    title: ["Город", "секретов."],
    name: `Глава ${id}`,
    tag: "КЛУБНОЕ ИЗДАНИЕ",
    plate: "Вечер в клубе",
    note: "Доверяйте осторожно.",
    lede: "Клубное руководство.",
    paragraphs: [`Точный русский текст ${id}.`],
    margin: "Авторское руководство, не официальный перевод.",
  },
});
const chapters = [chapter("table"), chapter("rule-6.2.1", "6.2.1"), chapter("rule-6.2.2", "6.2.2")];

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RulesSketchbook", () => {
  it("opens the exact semantic reference outside the application underlay", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    const { unmount } = render(
      <RulesSketchbook
        open
        targetId="rule-6.2.1"
        locale="en"
        chapters={chapters}
        onClose={vi.fn()}
      />,
      { container: root },
    );
    const dialog = screen.getByRole("dialog", { name: "Illustrated Mafia rulebook" });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByText("Exact English text for rule-6.2.1.")).toBeVisible();
    expect(screen.getByText("6.2.1", { selector: ".rs-reference" })).toBeVisible();
    expect(document.body).toHaveClass("rules-sketchbook-open");
    expect(dialog.querySelector("iframe")).toBeNull();
    unmount();
    root.remove();
    expect(document.body).not.toHaveClass("rules-sketchbook-open");
  });

  it("navigates through real contents and preserves position across close, locale and resize", () => {
    const onClose = vi.fn();
    const props = { open: true, locale: "en" as const, chapters, onClose };
    const { rerender } = render(<RulesSketchbook {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    expect(screen.getByRole("navigation", { name: "Contents" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /6.2.2 rule-6.2.2/ }));
    expect(screen.getByText("Exact English text for rule-6.2.2.")).toBeVisible();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    // On narrow screens previous is the illustration of this same chapter.
    expect(screen.getByLabelText("An evening at the club")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    rerender(<RulesSketchbook {...props} open={false} />);
    rerender(<RulesSketchbook {...props} locale="ru" />);
    expect(screen.getByText("Точный русский текст rule-6.2.2.")).toBeVisible();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1366 });
    act(() => window.dispatchEvent(new Event("resize")));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.getByText("Точный русский текст rule-6.2.2.")).toBeVisible();
  });

  it("keeps an unsupported request explicit and dismissible without silently opening another rule", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <RulesSketchbook
        open
        targetId="rule-missing"
        locale="en"
        chapters={chapters}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("rule-missing");
    expect(screen.queryByText("Exact English text for table.")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <RulesSketchbook
        open
        targetId="rule-6.2.2"
        locale="en"
        chapters={chapters}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Exact English text for rule-6.2.2.")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not reopen or move focus when callback identity changes and restores the exact invoker", () => {
    const invoker = document.createElement("button");
    document.body.append(invoker);
    invoker.focus();
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const { rerender } = render(
      <RulesSketchbook open locale="en" chapters={chapters} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    const entry = screen.getByRole("button", { name: /6.2.1 rule-6.2.1/ });
    entry.focus();
    rerender(<RulesSketchbook open locale="en" chapters={chapters} onClose={vi.fn()} />);
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(entry).toHaveFocus();
    rerender(<RulesSketchbook open={false} locale="en" chapters={chapters} onClose={vi.fn()} />);
    expect(invoker).toHaveFocus();
    invoker.remove();
  });

  it("keeps all 28 contents destinations available as readable native controls", () => {
    const many = Array.from({ length: 28 }, (_, i) =>
      chapter(`entry-${i}`, i >= 9 ? `6.2.${i - 8}` : undefined),
    );
    render(<RulesSketchbook open locale="en" chapters={many} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    expect(within(screen.getByRole("navigation")).getAllByRole("button")).toHaveLength(28);
    fireEvent.click(screen.getByRole("button", { name: /6.2.19 entry-27/ }));
    expect(screen.getByText("Exact English text for entry-27.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("turns from paper text and art while leaving embedded controls independent", () => {
    const { container } = render(
      <RulesSketchbook open locale="en" chapters={chapters} onClose={vi.fn()} />,
    );
    expect(container.querySelector("dialog")).toBeNull();
    fireEvent.click(screen.getByText("Exact English text for table."));
    expect(screen.getByLabelText("An evening at the club")).toBeVisible();
    fireEvent.click(screen.getByLabelText("An evening at the club").querySelector("img")!);
    expect(screen.getByText("Exact English text for rule-6.2.1.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    expect(screen.getByRole("navigation")).toBeVisible();
  });

  it("traverses intervening chapters within a bounded journey and cancels obsolete animation", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const request = vi.spyOn(window, "requestAnimationFrame");
    const props = { open: true, locale: "en" as const, chapters, onClose: vi.fn() };
    const { rerender, unmount } = render(<RulesSketchbook {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    expect(document.querySelector(".rs-curl[aria-hidden=true][inert]")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(800));
    expect(document.querySelector(".rs-curl")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /6.2.2 rule-6.2.2/ }));
    expect(document.querySelector(".rs-book")).toHaveAttribute("aria-busy", "true");
    act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector(".rs-book")).toHaveAttribute("data-chapter", "table");
    expect(document.querySelector(".rs-curl")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector(".rs-book")).toHaveAttribute("data-chapter", "rule-6.2.1");
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByText("Exact English text for rule-6.2.2.")).toBeVisible();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    rerender(<RulesSketchbook {...props} open={false} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(document.querySelector(".rs-curl")).toBeNull();
    expect(document.querySelector(".rs-book")).toHaveAttribute("data-side", "text");
    expect(cancel).toHaveBeenCalled();
    rerender(<RulesSketchbook {...props} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(document.querySelector(".rs-curl")).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    unmount();
    expect(cancel).toHaveBeenLastCalledWith(request.mock.results.at(-1)?.value);
  });

  it("wraps Tab and Shift+Tab within the foreground controls", () => {
    render(<RulesSketchbook open locale="en" chapters={chapters} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: "Close book" });
    const next = screen.getByRole("button", { name: "Next page" });
    close.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(next).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(close).toHaveFocus();
    for (let i = 0; i < 12; i++) {
      fireEvent.keyDown(dialog, { key: "Tab" });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("retains an ordinary reading scroll, but direct requests reopen at the number and text", () => {
    const props = { open: true, locale: "en" as const, chapters, onClose: vi.fn() };
    const { rerender } = render(<RulesSketchbook {...props} targetId="rule-6.2.1" />);
    let body = document.querySelector<HTMLElement>(".rs-spread .rs-body")!;
    body.scrollTop = 320;
    fireEvent.scroll(body);
    rerender(<RulesSketchbook {...props} open={false} />);
    rerender(<RulesSketchbook {...props} />);
    expect(body.scrollTop).toBe(320);
    rerender(<RulesSketchbook {...props} open={false} />);
    rerender(<RulesSketchbook {...props} targetId="rule-6.2.1" />);
    body = document.querySelector<HTMLElement>(".rs-spread .rs-body")!;
    expect(body.scrollTop).toBe(0);
    expect(screen.getByText("6.2.1", { selector: ".rs-reference" })).toBeVisible();
  });

  it("renders no reader or artwork before the first open and cleans modal state on unmount", () => {
    const props = { locale: "en" as const, chapters, onClose: vi.fn() };
    const { rerender, unmount } = render(<RulesSketchbook {...props} open={false} />);
    expect(document.querySelector(".rules-sketchbook")).toBeNull();
    expect(document.querySelector('img[src*="club.webp"]')).toBeNull();
    rerender(<RulesSketchbook {...props} open />);
    expect(screen.getByRole("dialog")).toHaveAttribute("open");
    unmount();
    expect(document.body).not.toHaveClass("rules-sketchbook-open");
    expect(document.querySelector(".rules-sketchbook")).toBeNull();
  });

  it("ignores the trailing physical click after an interrupted gesture", () => {
    render(<RulesSketchbook open locale="en" chapters={chapters} onClose={vi.fn()} />);
    act(() => window.dispatchEvent(new Event("resize")));
    fireEvent.click(screen.getByText("Exact English text for table."), { detail: 1, clientX: 300 });
    expect(document.querySelector(".rs-book")).toHaveAttribute("data-chapter", "table");
    expect(document.querySelector(".rs-book")).toHaveAttribute("data-side", "text");
  });

  it("does not normalize an unsupported empty target into an ordinary book open", () => {
    render(<RulesSketchbook open targetId="" locale="en" chapters={chapters} onClose={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This reference is not available");
    expect(document.querySelector(".rs-book")).toHaveAttribute("data-chapter", "unavailable");
    expect(screen.queryByText("Exact English text for table.")).not.toBeInTheDocument();
  });
});
