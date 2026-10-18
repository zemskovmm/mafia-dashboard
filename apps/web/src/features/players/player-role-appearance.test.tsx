import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CASPER_PLAYER_ID } from "@mafia/game-domain";
import {
  PlayerDirectoryProvider,
  usePlayerRoleAppearance,
  type DisplayProfile,
} from "./player-display.js";

const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const profile = (version = "one"): DisplayProfile => ({
  id: "player-one",
  nickname: "Alpha",
  roleIconsVersion: version,
  roleIcons: {
    citizen: { kind: "builtin", id: "cat" },
    sheriff: { kind: "upload", id: "picture" },
  },
});
const Appearance = ({ id = "player-one" }: { id?: string }) => {
  const appearance = usePlayerRoleAppearance(id);
  return <output data-testid="appearance">{JSON.stringify(appearance)}</output>;
};
const response = (version: string, image: string) =>
  new Response(JSON.stringify({ version, images: { picture: image } }));
afterEach(() => vi.unstubAllGlobals());

describe("profile appearance lifetime", () => {
  it("loads lazily, sharing one complete bundle across consumers without a role request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("one", "normalized-thumbnail"));
    vi.stubGlobal("fetch", fetchMock);
    const profiles = [profile()];
    const { rerender } = render(
      <PlayerDirectoryProvider profiles={profiles} clubId="club-one">
        <span>No displayed profile</span>
      </PlayerDirectoryProvider>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(
      <PlayerDirectoryProvider profiles={profiles} clubId="club-one">
        <Appearance />
        <Appearance />
      </PlayerDirectoryProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("appearance")[0]).toHaveTextContent("normalized-thumbnail"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/players/player-one/role-icons");
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ "x-club-id": "club-one" });
  });

  it("immediately drops old media on club change and ignores a late previous-club response", async () => {
    const old = deferred();
    const current = deferred();
    const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    vi.stubGlobal("fetch", fetchMock);
    const profiles = [profile()];
    const { rerender } = render(
      <PlayerDirectoryProvider profiles={profiles} clubId="club-one">
        <Appearance />
      </PlayerDirectoryProvider>,
    );
    rerender(
      <PlayerDirectoryProvider profiles={profiles} clubId="club-two">
        <Appearance />
      </PlayerDirectoryProvider>,
    );
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
    await act(async () => current.resolve(response("one", "new-club-image")));
    expect(screen.getByTestId("appearance")).toHaveTextContent("new-club-image");
    await act(async () => old.resolve(response("one", "old-club-image")));
    expect(screen.getByTestId("appearance")).not.toHaveTextContent("old-club-image");
  });

  it("rejects an old-version response and never revives media after retirement", async () => {
    const old = deferred();
    const current = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise),
    );
    const { rerender } = render(
      <PlayerDirectoryProvider profiles={[profile()]} clubId="club-one">
        <Appearance />
      </PlayerDirectoryProvider>,
    );
    rerender(
      <PlayerDirectoryProvider profiles={[profile("two")]} clubId="club-one">
        <Appearance />
      </PlayerDirectoryProvider>,
    );
    await act(async () => old.resolve(response("one", "old-version")));
    await act(async () => current.resolve(response("one", "mismatched-version")));
    expect(screen.getByTestId("appearance")).not.toHaveTextContent("version");
    rerender(
      <PlayerDirectoryProvider profiles={[]} clubId="club-one">
        <Appearance />
      </PlayerDirectoryProvider>,
    );
    expect(JSON.parse(screen.getByTestId("appearance").textContent!)).toEqual({
      roleIcons: {},
      images: {},
    });
  });

  it("does not request uploads for built-ins, missing identities, or virtual Casper", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PlayerDirectoryProvider
        profiles={[
          {
            id: "player-one",
            nickname: "Alpha",
            roleIcons: { citizen: { kind: "builtin", id: "cat" } },
          },
          { ...profile(), id: CASPER_PLAYER_ID },
        ]}
        clubId="club-one"
      >
        <Appearance />
        <Appearance id="missing" />
        <Appearance id={CASPER_PLAYER_ID} />
      </PlayerDirectoryProvider>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("appearance")[0]).toHaveTextContent("cat");
    expect(screen.getAllByTestId("appearance")[2]).not.toHaveTextContent("picture");
  });

  it("falls back on unavailable media and remains usable through StrictMode cleanup", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      if (init.signal.aborted) throw new DOMException("Aborted", "AbortError");
      return response("one", "strict-mode-image");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(
      <StrictMode>
        <PlayerDirectoryProvider profiles={[profile()]} clubId="club-one">
          <Appearance />
        </PlayerDirectoryProvider>
      </StrictMode>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("appearance")).toHaveTextContent("strict-mode-image"),
    );
    unmount();
    fetchMock.mockRejectedValue(new Error("Unavailable"));
    render(
      <PlayerDirectoryProvider profiles={[profile()]} clubId="club-one">
        <Appearance />
      </PlayerDirectoryProvider>,
    );
    await act(async () => {});
    expect(JSON.parse(screen.getByTestId("appearance").textContent!).images).toEqual({});
  });
});
