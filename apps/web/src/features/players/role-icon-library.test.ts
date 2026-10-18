import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { BUILTIN_ROLE_ICON_IDS } from "../../api/player-role-icon-contracts.js";
import { ROLE_ICON_LIBRARY, searchRoleIcons } from "./role-icon-library.js";

it("represents every contract ID once with an installed renderable Lucide export", () => {
  expect(ROLE_ICON_LIBRARY.map(({ id }) => id).sort()).toEqual([...BUILTIN_ROLE_ICON_IDS].sort());
  expect(new Set(ROLE_ICON_LIBRARY.map(({ id }) => id)).size).toBe(ROLE_ICON_LIBRARY.length);
  for (const entry of ROLE_ICON_LIBRARY) {
    expect(renderToStaticMarkup(createElement(entry.Icon))).toContain("<svg");
    expect(entry.names.en).not.toBe("");
    expect(entry.names.ru).not.toBe("");
  }
});
it("searches IDs, both languages and categories without requiring a locale switch", () => {
  expect(searchRoleIcons("КОШКА").map(({ id }) => id)).toEqual(["cat"]);
  expect(searchRoleIcons("  cat  ").map(({ id }) => id)).toEqual(["cat"]);
  expect(searchRoleIcons("животные")).toHaveLength(6);
  expect(searchRoleIcons("mask", "animals")).toHaveLength(0);
  expect(searchRoleIcons("", "people")).toHaveLength(4);
  expect(searchRoleIcons("no such icon")).toHaveLength(0);
});
