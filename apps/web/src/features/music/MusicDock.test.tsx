import { useState, type ComponentType } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MusicDock } from "./MusicDock.js";

const callbacks = () => ({
  isPlaying: false,
  canFadeIn: false,
  onFadeIn: vi.fn(),
  onQuickFadeOut: vi.fn(),
  onSlowFadeOut: vi.fn(),
});

const SwipeHarness = () => {
  const [expanded, setExpanded] = useState(false);
  const TestMusicDock = MusicDock as unknown as ComponentType<Record<string, unknown>>;
  return (
    <TestMusicDock {...callbacks()} expanded={expanded} onExpandedChange={setExpanded}>
      <output data-testid="expanded-state">{String(expanded)}</output>
    </TestMusicDock>
  );
};

const ExpandedSwipeHarness = () => {
  const [expanded, setExpanded] = useState(true);
  const TestMusicDock = MusicDock as unknown as ComponentType<Record<string, unknown>>;
  return (
    <TestMusicDock {...callbacks()} expanded={expanded} onExpandedChange={setExpanded}>
      <output data-testid="expanded-state">{String(expanded)}</output>
    </TestMusicDock>
  );
};

describe("MusicDock", () => {
  it("expands on an upward swipe over its dedicated handle", () => {
    render(<SwipeHarness />);
    const handle = screen.getByRole("button", { name: "Music player panel handle" });

    fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 100 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 12, clientY: 40 }] });

    expect(screen.getByTestId("expanded-state")).toHaveTextContent("true");
  });

  it("collapses on a downward swipe over its dedicated handle", () => {
    render(<ExpandedSwipeHarness />);
    const handle = screen.getByRole("button", { name: "Music player panel handle" });

    fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 40 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 12, clientY: 100 }] });

    expect(screen.getByTestId("expanded-state")).toHaveTextContent("false");
  });

  it("ignores the compatibility click after a wrong-axis swipe reaches the threshold", () => {
    render(<SwipeHarness />);
    const handle = screen.getByRole("button", { name: "Music player panel handle" });

    fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 20 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 54, clientY: 20 }] });
    fireEvent.click(handle);

    expect(screen.getByTestId("expanded-state")).toHaveTextContent("false");

    fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 20 }] });
    fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 14, clientY: 24 }] });
    fireEvent.click(handle);

    expect(screen.getByTestId("expanded-state")).toHaveTextContent("true");
  });
});
