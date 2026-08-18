import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDJPlayer } from "./LocalDJPlayer.js";
import type { YouTubePlayerHandle } from "./YouTubePlaylistPlayer.js";

const tracks = [
  {
    id: "one",
    title: "Opening",
    originalFilename: "opening.mp3",
    mimeType: "audio/mpeg",
    durationSeconds: 100,
    waveform: [0.1, 0.7, 1],
    audioUrl: "/api/music/tracks/one/audio",
    createdAt: "2026-08-17T20:00:00.000Z",
  },
  {
    id: "two",
    title: "Night",
    originalFilename: "night.mp3",
    mimeType: "audio/mpeg",
    durationSeconds: 140,
    waveform: [1, 0.4, 0.2],
    audioUrl: "/api/music/tracks/two/audio",
    createdAt: "2026-08-17T20:01:00.000Z",
  },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tracks }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LocalDJPlayer", () => {
  it("shows current and next oscillograms and lets the host choose both start points", async () => {
    render(<LocalDJPlayer onStateChange={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Current · Opening" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Next · Night" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Current track start position waveform" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Next track start position waveform" }),
    ).toBeInTheDocument();

    const nextStart = screen.getByRole("slider", { name: "Next track start position" });
    fireEvent.change(nextStart, { target: { value: "12.5" } });
    expect(nextStart).toHaveValue("12.5");
    expect(screen.getByRole("button", { name: "Crossfade to Night" })).toBeEnabled();
  });

  it("stops both physical decks when the player unmounts", async () => {
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    const { unmount } = render(<LocalDJPlayer onStateChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "Current · Opening" });
    pause.mockClear();

    unmount();

    expect(pause).toHaveBeenCalledTimes(2);
  });

  it("locks queue and cue mutations during a crossfade", async () => {
    render(<LocalDJPlayer onStateChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "Current · Opening" });

    fireEvent.click(screen.getByRole("button", { name: "Crossfade to Night" }));

    expect(screen.getByLabelText("Current track")).toBeDisabled();
    expect(screen.getByLabelText("Next track")).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Current track start position" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Next track start position" })).toBeDisabled();
  });

  it("does not start an automatic crossfade when a paused track seeks near its end", async () => {
    const onStateChange = vi.fn();
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    const { container } = render(<LocalDJPlayer onStateChange={onStateChange} />);
    await screen.findByRole("heading", { name: "Current · Opening" });
    const [currentDeck] = [...container.querySelectorAll("audio")];
    expect(currentDeck).toBeDefined();
    Object.defineProperties(currentDeck!, {
      currentTime: { configurable: true, value: 98 },
      duration: { configurable: true, value: 100 },
      paused: { configurable: true, value: true },
    });
    play.mockClear();
    onStateChange.mockClear();

    fireEvent.timeUpdate(currentDeck!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(play).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Current · Opening" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Next · Night" })).toBeInTheDocument();
  });

  it("shows each successful sequential upload even when a later file fails", async () => {
    const uploadedTrack = { ...tracks[0], id: "uploaded-one", title: "Uploaded opening" };
    let rejectSecond!: (error: unknown) => void;
    const secondUpload = new Promise<Response>((_resolve, reject) => {
      rejectSecond = reject;
    });
    let uploadCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method !== "POST") {
          return new Response(JSON.stringify({ tracks: [] }), { status: 200 });
        }
        uploadCount += 1;
        if (uploadCount === 1) {
          return new Response(JSON.stringify({ track: uploadedTrack }), { status: 201 });
        }
        return secondUpload;
      }),
    );
    render(<LocalDJPlayer onStateChange={vi.fn()} />);
    await screen.findByText("Upload two or more audio files to create the first crossfade queue.");
    const input = screen.getByLabelText("Upload audio");
    fireEvent.change(input, {
      target: {
        files: [
          new File(["opening"], "opening.mp3", { type: "audio/mpeg" }),
          new File(["night"], "night.mp3", { type: "audio/mpeg" }),
        ],
      },
    });

    await waitFor(() => expect(uploadCount).toBe(2));
    let firstWasVisible = true;
    try {
      await waitFor(
        () =>
          expect(
            screen.getByRole("heading", { name: "Current · Uploaded opening" }),
          ).toBeInTheDocument(),
        { timeout: 200 },
      );
    } catch {
      firstWasVisible = false;
    } finally {
      rejectSecond(new Error("later upload failed"));
    }

    expect(firstWasVisible).toBe(true);
    expect(await screen.findByText("Upload or waveform analysis failed.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current · Uploaded opening" })).toBeInTheDocument();
  });

  it("does not let a stale initial list overwrite a completed upload", async () => {
    const uploadedTrack = { ...tracks[0], id: "uploaded-one", title: "Uploaded opening" };
    let resolveList!: (response: Response) => void;
    const initialList = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(JSON.stringify({ track: uploadedTrack }), { status: 201 })
          : initialList,
      ),
    );
    render(<LocalDJPlayer onStateChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Upload audio"), {
      target: { files: [new File(["opening"], "opening.mp3", { type: "audio/mpeg" })] },
    });
    expect(
      await screen.findByRole("heading", { name: "Current · Uploaded opening" }),
    ).toBeInTheDocument();

    resolveList(new Response(JSON.stringify({ tracks: [] }), { status: 200 }));
    await act(async () => {
      await initialList;
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Current · Uploaded opening" })).toBeInTheDocument();
  });

  it("ignores an older initial-list rejection after an upload succeeds", async () => {
    const uploadedTrack = { ...tracks[0], id: "uploaded-one", title: "Uploaded opening" };
    let rejectList!: (error: unknown) => void;
    const initialList = new Promise<Response>((_resolve, reject) => {
      rejectList = reject;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(JSON.stringify({ track: uploadedTrack }), { status: 201 })
          : initialList,
      ),
    );
    const onStateChange = vi.fn();
    render(<LocalDJPlayer onStateChange={onStateChange} />);
    fireEvent.change(screen.getByLabelText("Upload audio"), {
      target: { files: [new File(["opening"], "opening.mp3", { type: "audio/mpeg" })] },
    });
    expect(
      await screen.findByRole("heading", { name: "Current · Uploaded opening" }),
    ).toBeInTheDocument();
    expect(onStateChange).toHaveBeenLastCalledWith("paused");

    rejectList(new Error("older list failed"));
    await act(async () => {
      await initialList.catch(() => undefined);
      await Promise.resolve();
    });

    expect(screen.queryByText("Unable to load the local music library.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current · Uploaded opening" })).toBeInTheDocument();
    expect(onStateChange).toHaveBeenLastCalledWith("paused");
  });

  it("suppresses a pending upload after a source switch unmounts the player", async () => {
    let resolveUpload!: (response: Response) => void;
    const pendingUpload = new Promise<Response>((resolve) => {
      resolveUpload = resolve;
    });
    const uploadedTrack = { ...tracks[0], id: "stale-upload", title: "Stale upload" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? pendingUpload
          : new Response(JSON.stringify({ tracks: [] }), { status: 200 }),
      ),
    );
    const onStateChange = vi.fn();
    const view = render(<LocalDJPlayer onStateChange={onStateChange} />);
    await screen.findByText("Upload two or more audio files to create the first crossfade queue.");
    fireEvent.change(screen.getByLabelText("Upload audio"), {
      target: { files: [new File(["opening"], "opening.mp3", { type: "audio/mpeg" })] },
    });
    await waitFor(() => expect(screen.getByText("Analyzing…")).toBeInTheDocument());

    view.rerender(<p>YouTube source active</p>);
    const parentStatesAtSwitch = onStateChange.mock.calls.length;
    resolveUpload(new Response(JSON.stringify({ track: uploadedTrack }), { status: 201 }));
    await act(async () => {
      await pendingUpload;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("YouTube source active")).toBeInTheDocument();
    expect(onStateChange).toHaveBeenCalledTimes(parentStatesAtSwitch);
  });

  it("invalidates a pending play before unmount cleanup can be undone", async () => {
    let resolvePlay!: () => void;
    const pendingPlay = new Promise<void>((resolve) => {
      resolvePlay = resolve;
    });
    vi.mocked(HTMLMediaElement.prototype.play)
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(pendingPlay);
    const ref = createRef<YouTubePlayerHandle>();
    const onStateChange = vi.fn();
    const { unmount } = render(<LocalDJPlayer ref={ref} onStateChange={onStateChange} />);
    await screen.findByRole("heading", { name: "Current · Opening" });
    let fadeResult: boolean | undefined;
    void ref.current?.fadeIn().then((result) => {
      fadeResult = result;
    });

    unmount();
    await waitFor(() => expect(fadeResult).toBe(false));
    resolvePlay();
    await Promise.resolve();
    expect(onStateChange).not.toHaveBeenLastCalledWith("playing");
  });

  it("cancels a pending fade when the active source changes", async () => {
    let resolvePlay!: () => void;
    const pendingPlay = new Promise<void>((resolve) => {
      resolvePlay = resolve;
    });
    vi.mocked(HTMLMediaElement.prototype.play)
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(pendingPlay);
    const ref = createRef<YouTubePlayerHandle>();
    const onStateChange = vi.fn();
    render(<LocalDJPlayer ref={ref} onStateChange={onStateChange} />);
    await screen.findByRole("heading", { name: "Current · Opening" });
    let fadeResult: boolean | undefined;
    void ref.current?.fadeIn().then((result) => {
      fadeResult = result;
    });

    fireEvent.change(screen.getByLabelText("Current track"), { target: { value: "two" } });
    await waitFor(() => expect(fadeResult).toBe(false));
    resolvePlay();
    await Promise.resolve();
    expect(onStateChange).not.toHaveBeenLastCalledWith("playing");
  });

  it("keeps one operation lineage when a physical deck is reused for a newer fade", async () => {
    let resolveOldPlay!: () => void;
    const oldPlay = new Promise<void>((resolve) => {
      resolveOldPlay = resolve;
    });
    vi.mocked(HTMLMediaElement.prototype.play)
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(oldPlay)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    const ref = createRef<YouTubePlayerHandle>();
    const { container } = render(<LocalDJPlayer ref={ref} onStateChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "Current · Opening" });
    const physicalDeck = container.querySelector("audio");
    expect(physicalDeck).not.toBeNull();

    const abandonedFade = ref.current!.fadeIn();
    fireEvent.change(screen.getByLabelText("Current track"), { target: { value: "two" } });
    await expect(abandonedFade).resolves.toBe(false);

    vi.useFakeTimers();
    const replacementFade = ref.current!.fadeIn();
    await Promise.resolve();
    await Promise.resolve();
    const pausesBeforeOldPlay = pause.mock.contexts.filter(
      (context) => context === physicalDeck,
    ).length;
    const volumeBeforeOldPlay = physicalDeck!.volume;

    resolveOldPlay();
    await Promise.resolve();
    await Promise.resolve();

    expect(pause.mock.contexts.filter((context) => context === physicalDeck)).toHaveLength(
      pausesBeforeOldPlay,
    );
    expect(physicalDeck!.volume).toBe(volumeBeforeOldPlay);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(replacementFade).resolves.toBe(true);
    expect(physicalDeck!.volume).toBe(0.65);
  });

  it("cancels a pending independent fade before crossfade takes ownership", async () => {
    let resolveCurrentPlay!: () => void;
    const pendingCurrentPlay = new Promise<void>((resolve) => {
      resolveCurrentPlay = resolve;
    });
    vi.mocked(HTMLMediaElement.prototype.play)
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(pendingCurrentPlay);
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    const ref = createRef<YouTubePlayerHandle>();
    render(<LocalDJPlayer ref={ref} onStateChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "Current · Opening" });
    let fadeResult: boolean | undefined;
    void ref.current?.fadeIn().then((result) => {
      fadeResult = result;
    });

    fireEvent.click(screen.getByRole("button", { name: "Crossfade to Night" }));
    await waitFor(() => expect(fadeResult).toBe(false));
    await Promise.resolve();
    const pausesBeforeStalePlay = pause.mock.calls.length;
    resolveCurrentPlay();
    await Promise.resolve();
    await Promise.resolve();

    expect(pause).toHaveBeenCalledTimes(pausesBeforeStalePlay);
    expect(screen.getByLabelText("Current track")).toBeDisabled();
  });

  it("cancels an active crossfade before a quick stop writes gain or changes decks", async () => {
    const ref = createRef<YouTubePlayerHandle>();
    const onStateChange = vi.fn();
    const { container } = render(<LocalDJPlayer ref={ref} onStateChange={onStateChange} />);
    await screen.findByRole("heading", { name: "Current · Opening" });
    fireEvent.change(screen.getByLabelText("Crossfade duration"), { target: { value: "3" } });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Crossfade to Night" }));
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
    });

    const stop = ref.current!.quickFadeOut();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await stop;
    const decks = [...container.querySelectorAll("audio")];
    const volumesAfterStop = decks.map(({ volume }) => volume);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(decks.map(({ volume }) => volume)).toEqual(volumesAfterStop);
    expect(screen.getByRole("heading", { name: "Current · Opening" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Next · Night" })).toBeInTheDocument();
    expect(onStateChange).toHaveBeenLastCalledWith("paused");
    vi.useRealTimers();
  });
});
