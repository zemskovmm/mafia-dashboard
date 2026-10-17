import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");
const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
const runtime = files(sourceRoot).filter(
  (path) => /\.(?:ts|tsx|css)$/.test(path) && !/\.test\./.test(path) && !/\/test[^/]*\./.test(path),
);
const read = (path: string) => readFileSync(path, "utf8");

describe("native interaction policy", () => {
  it("does not reintroduce authored keys, focus transfer, tab stops or shortcut metadata", () => {
    for (const path of runtime) {
      expect(read(path), path).not.toMatch(
        /onKey(?:Down|Up|Press)\s*=|addEventListener\(["'](?:keydown|keyup|keypress|focusin)["']|\.(?:focus|blur)\s*\(|\bautoFocus\b|\btabIndex\s*=|aria-keyshortcuts|aria-activedescendant|currentTarget\.select\s*\(/,
      );
    }
  });

  it("uses one low-specificity outline reset and only functional popup focus stacking", () => {
    const styles = runtime
      .filter((path) => path.endsWith(".css"))
      .map(read)
      .join("\n");
    const selectors = [...styles.matchAll(/^[^\n]*:focus[^\n]*$/gm)].map(([line]) => line.trim());
    expect(selectors.sort()).toEqual(
      [
        ".player-combobox:focus-within {",
        ".setup-seat-card:focus-within {",
        ":where(:focus) {",
      ].sort(),
    );
    expect(styles).toMatch(/:where\(:focus\)\s*\{\s*outline:\s*none;\s*\}/);
    expect(styles).toMatch(/\.player-combobox:focus-within\s*\{\s*z-index:\s*35;\s*\}/);
    expect(styles).toMatch(/\.setup-seat-card:focus-within\s*\{\s*z-index:\s*36;\s*\}/);
    expect(styles).toMatch(
      /\.player-seat\.has-nomination-selection-outline\s*\{\s*outline:\s*1px solid/,
    );
  });

  it("centralizes ordinary text suppression and native editable-field selection", () => {
    const app = read(join(sourceRoot, "styles/app.css"));
    expect(app).toMatch(
      /body,\s*dialog\s*\{\s*-webkit-user-select:\s*none;\s*user-select:\s*none;/,
    );
    expect(app).toMatch(
      /input:read-write,\s*textarea:read-write\s*\{\s*-webkit-user-select:\s*text;\s*user-select:\s*text;\s*\}/,
    );
    for (const path of runtime) {
      const source = read(path);
      if (path.endsWith(".css")) {
        expect([...source.matchAll(/(?:-webkit-)?user-select\s*:/g)], path).toHaveLength(
          path === join(sourceRoot, "styles/app.css") ? 4 : 0,
        );
      } else {
        expect(source, path).not.toMatch(
          /onSelectStart|onCopy\s*=|addEventListener\(["'](?:selectstart|copy)["']|removeAllRanges\s*\(|userSelect\s*[:=]/,
        );
      }
    }
  });

  it("retains native modal activation and state synchronization without a replacement trap", () => {
    for (const file of [
      "features/game/FederationJudgeDialog.tsx",
      "features/rules/RulesSketchbook.tsx",
    ]) {
      const source = read(join(sourceRoot, file));
      expect(source).toContain(".showModal()");
      expect(source).toContain("onCancel=");
      expect(source).toContain(".close()");
      expect(source).not.toMatch(/activeElement|returnFocus|onKeyDown/);
    }
    expect(read(join(sourceRoot, "features/game/FederationJudgeDialog.tsx"))).toContain(
      "inert={suspended}",
    );
  });
});
