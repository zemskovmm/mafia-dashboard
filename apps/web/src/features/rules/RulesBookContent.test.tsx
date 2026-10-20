import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import RulesBookContent from "./RulesBookContent.js";
import { FancyFeaturesContext } from "../effects/FancyFeaturesContext.js";

const preparation = vi.hoisted(() => ({ prepare: vi.fn(), ready: false }));
vi.mock("./rules-book-loading.js", () => ({
  prepareRulesBook: preparation.prepare,
  isRulesBookReady: () => preparation.ready,
}));
afterEach(() => {
  vi.restoreAllMocks();
  preparation.prepare.mockReset();
  preparation.ready = false;
});

describe("shared reader presentation readiness", () => {
  it("opens both entrances flat without optional work and preserves the dialog/reference/form through a late readiness change", async () => {
    let resolve!: () => void;
    preparation.prepare.mockReturnValue(
      new Promise<void>((yes) => {
        resolve = yes;
      }),
    );
    const Harness = ({ fancy }: { fancy: boolean }) => {
      const [rule, setRule] = useState<"6.3.5" | undefined>();
      return (
        <FancyFeaturesContext.Provider value={fancy}>
          <input aria-label="Unfinished penalty reason" defaultValue="Keep this draft" />
          <button onClick={() => setRule("6.3.5")}>Exact penalty reference</button>
          <RulesBookContent open locale="ru" rule={rule} onClose={vi.fn()} />
        </FancyFeaturesContext.Provider>
      );
    };
    const { rerender } = render(<Harness fancy={false} />);
    expect(preparation.prepare).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-presentation", "flat");
    expect(document.querySelector(".rs-plate-art, .rs-binding, .rs-curl")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Exact penalty reference" }));
    const modal = screen.getByRole("dialog");
    const body = document.querySelector<HTMLElement>('[data-reading-key="rule-6.3.5"]')!;
    body.scrollTop = 137;
    fireEvent.scroll(body);
    rerender(<Harness fancy />);
    expect(preparation.prepare).toHaveBeenCalledTimes(1);
    expect(modal).toHaveAttribute("data-presentation", "flat");
    rerender(<Harness fancy={false} />);
    await act(async () => {
      preparation.ready = true;
      resolve();
    });
    expect(modal).toHaveAttribute("data-presentation", "flat");
    expect(document.querySelector(".rs-book")).toHaveAttribute("data-chapter", "rule-6.3.5");
    expect(screen.getByLabelText("Unfinished penalty reason")).toHaveValue("Keep this draft");
    rerender(<Harness fancy />);
    await waitFor(() => expect(modal).toHaveAttribute("data-presentation", "enhanced"));
    expect(screen.getByRole("dialog")).toBe(modal);
    expect(document.querySelector(".rs-book")).toHaveAttribute("data-chapter", "rule-6.3.5");
    expect(document.querySelector('[data-reading-key="rule-6.3.5"]')).toHaveProperty(
      "scrollTop",
      137,
    );
    expect(screen.getByLabelText("Unfinished penalty reason")).toHaveValue("Keep this draft");
  });
});
