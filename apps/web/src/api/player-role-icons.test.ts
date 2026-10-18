import { afterEach, describe, expect, it, vi } from "vitest";
import { getPlayerRoleIcons, updatePlayer } from "./client.js";
import { BUILTIN_ROLE_ICON_IDS, PLAYER_ICON_ROLES } from "./player-role-icon-contracts.js";
import {
  BUILTIN_ROLE_ICON_IDS as serverIds,
  PLAYER_ICON_ROLES as serverRoles,
} from "../../../server/src/player-role-icon-contracts.js";

afterEach(() => vi.unstubAllGlobals());

describe("private player role-icon transport", () => {
  it("keeps the bounded server/client catalog and role keys in agreement", () => {
    expect(BUILTIN_ROLE_ICON_IDS).toEqual(serverIds);
    expect(PLAYER_ICON_ROLES).toEqual(serverRoles);
  });

  it("loads the whole player bundle with club credentials, no role selector and no HTTP cache", async () => {
    const bundle = { version: "revision-1", images: { thumbnail: "data:image/png;base64,YQ==" } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(bundle)));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await expect(getPlayerRoleIcons("player/one", "club-one", controller.signal)).resolves.toEqual(
      bundle,
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/players/player%2Fone/role-icons", {
      headers: { "x-club-id": "club-one" },
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
  });

  it("preserves read errors rather than accepting an empty response as saved media", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
    );
    await expect(getPlayerRoleIcons("player-one", "club-two")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("keeps omission distinct from an explicit per-role reset", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ player: {} })));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      nickname: "Alpha",
      consent: false as const,
      clubAccess: "none" as const,
      firstName: null,
      lastName: null,
      email: null,
    };
    await updatePlayer("player-one", input, "club-one");
    await updatePlayer(
      "player-one",
      { ...input, roleIcons: { citizen: null, sheriff: { kind: "builtin", id: "star" } } },
      "club-one",
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).not.toHaveProperty("roleIcons");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).roleIcons).toEqual({
      citizen: null,
      sheriff: { kind: "builtin", id: "star" },
    });
  });
});
