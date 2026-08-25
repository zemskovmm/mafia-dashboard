import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CompletedGameSessionSummary, RemoteGameSession } from "../../api/client.js";
import { GameTimelineScreen } from "./GameTimelineScreen.js";
import { createSampleGameHistory } from "./sample-game-data.js";

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const completedSummary = (gameId: string, name: string): CompletedGameSessionSummary => ({
  gameId,
  name,
  revision: 1,
  hostName: `${name} host`,
  winner: "red",
  playedAt: "2026-08-24T18:00:00.000Z",
  day: 2,
  eventCount: 1,
  updatedAt: "2026-08-24T18:00:00.000Z",
});

const legacySession = (
  summary: CompletedGameSessionSummary,
  log: readonly Readonly<Record<string, unknown>>[],
  gameId = summary.gameId,
): RemoteGameSession => ({
  gameId,
  name: summary.name,
  revision: summary.revision,
  duplicate: false,
  status: "completed",
  updatedAt: summary.updatedAt,
  state: {
    setup: null,
    game: createSampleGameHistory().game,
    hostPlayerId: null,
    hostName: summary.hostName,
    playlistId: "",
    log,
    undoHistory: [],
  },
  results: null,
});

describe("GameTimelineScreen", () => {
  it("removes the prior club history synchronously when the tenant changes", async () => {
    const user = userEvent.setup();
    const clubA = "00000000-0000-4000-8000-000000000101";
    const clubB = "00000000-0000-4000-8000-000000000202";
    const gameA = completedSummary("00000000-0000-4000-8000-000000000701", "Club A");
    const clubBList = deferred<readonly CompletedGameSessionSummary[]>();
    const loaders = {
      listCompleted: vi.fn((clubId: string) =>
        clubId === clubA ? Promise.resolve([gameA]) : clubBList.promise,
      ),
      getSession: vi.fn(() =>
        Promise.resolve(
          legacySession(gameA, [
            {
              id: "00000000-0000-4000-8000-000000000711",
              sequence: 1,
              type: "don.checked",
              phase: "night-don-result",
              payload: { targetSeat: 1, match: true },
              secret: true,
              createdAt: "2026-08-24T18:01:00.000Z",
            },
          ]),
        ),
      ),
    };
    const { rerender } = render(
      <GameTimelineScreen clubId={clubA} onBack={() => undefined} loaders={loaders} />,
    );

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Completed game" }),
      gameA.gameId,
    );
    expect(
      await screen.findByRole("button", { name: "Don checked Player 1: Sheriff" }),
    ).toBeInTheDocument();

    rerender(<GameTimelineScreen clubId={clubB} onBack={() => undefined} loaders={loaders} />);

    expect(screen.queryByRole("button", { name: "Don checked Player 1: Sheriff" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Completed game" })).toHaveValue("");
    expect(screen.getByText("Loading completed games…")).toBeInTheDocument();
  });

  it("ignores a selected-game response from a club that is no longer active", async () => {
    const user = userEvent.setup();
    const clubA = "00000000-0000-4000-8000-000000000101";
    const clubB = "00000000-0000-4000-8000-000000000202";
    const gameA = completedSummary("00000000-0000-4000-8000-000000000701", "Club A");
    const sessionA = deferred<RemoteGameSession>();
    const clubBList = deferred<readonly CompletedGameSessionSummary[]>();
    const loaders = {
      listCompleted: (clubId: string) =>
        clubId === clubA ? Promise.resolve([gameA]) : clubBList.promise,
      getSession: () => sessionA.promise,
    };
    const { rerender } = render(
      <GameTimelineScreen clubId={clubA} onBack={() => undefined} loaders={loaders} />,
    );

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Completed game" }),
      gameA.gameId,
    );
    rerender(<GameTimelineScreen clubId={clubB} onBack={() => undefined} loaders={loaders} />);
    await act(async () =>
      sessionA.resolve(
        legacySession(gameA, [
          {
            id: "00000000-0000-4000-8000-000000000711",
            sequence: 1,
            type: "don.checked",
            phase: "night-don-result",
            payload: { targetSeat: 1, match: true },
            secret: true,
            createdAt: "2026-08-24T18:01:00.000Z",
          },
        ]),
      ),
    );

    expect(screen.queryByRole("button", { name: "Don checked Player 1: Sheriff" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Loading completed games…")).toBeInTheDocument();
  });

  it("applies completed-list error and loading state only to the latest request", async () => {
    const clubId = "00000000-0000-4000-8000-000000000101";
    const first = deferred<readonly CompletedGameSessionSummary[]>();
    const second = deferred<readonly CompletedGameSessionSummary[]>();
    const completed = completedSummary("00000000-0000-4000-8000-000000000701", "Latest list");
    const firstLoaders = { listCompleted: () => first.promise, getSession: vi.fn() };
    const secondLoaders = { listCompleted: () => second.promise, getSession: vi.fn() };
    const { rerender } = render(
      <GameTimelineScreen clubId={clubId} onBack={() => undefined} loaders={firstLoaders} />,
    );

    expect(screen.getByText("Loading completed games…")).toBeInTheDocument();
    rerender(
      <GameTimelineScreen clubId={clubId} onBack={() => undefined} loaders={secondLoaders} />,
    );
    await act(async () => first.reject(new Error("stale list failure")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Loading completed games…")).toBeInTheDocument();

    await act(async () => second.resolve([completed]));
    expect(screen.queryByText("Loading completed games…")).toBeNull();
    expect(screen.getByRole("option", { name: "Latest list · Citizens" })).toBeInTheDocument();
  });

  it("ignores a selected-game response after the selection is cleared", async () => {
    const user = userEvent.setup();
    const game = completedSummary("00000000-0000-4000-8000-000000000701", "First");
    const response = deferred<RemoteGameSession>();
    render(
      <GameTimelineScreen
        clubId="00000000-0000-4000-8000-000000000101"
        onBack={() => undefined}
        loaders={{
          listCompleted: () => Promise.resolve([game]),
          getSession: () => response.promise,
        }}
      />,
    );

    const selector = await screen.findByRole("combobox", { name: "Completed game" });
    await screen.findByRole("option", { name: /First/ });
    await user.selectOptions(selector, game.gameId);
    expect(screen.getByText("Loading First…")).toBeInTheDocument();
    await user.selectOptions(selector, "");
    await act(async () =>
      response.resolve(
        legacySession(game, [
          {
            id: "00000000-0000-4000-8000-000000000711",
            sequence: 1,
            type: "don.checked",
            phase: "night-don-result",
            payload: { targetSeat: 1, match: true },
            secret: true,
            createdAt: "2026-08-24T18:01:00.000Z",
          },
        ]),
      ),
    );

    expect(selector).toHaveValue("");
    expect(screen.queryByText("Loading First…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Don checked Player 1: Sheriff" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a selected-game error after sample data supersedes the request", async () => {
    const user = userEvent.setup();
    const game = completedSummary("00000000-0000-4000-8000-000000000701", "First");
    const response = deferred<RemoteGameSession>();
    render(
      <GameTimelineScreen
        clubId="00000000-0000-4000-8000-000000000101"
        onBack={() => undefined}
        loaders={{
          listCompleted: () => Promise.resolve([game]),
          getSession: () => response.promise,
        }}
      />,
    );

    const selector = await screen.findByRole("combobox", { name: "Completed game" });
    await screen.findByRole("option", { name: /First/ });
    await user.selectOptions(selector, game.gameId);
    expect(screen.getByText("Loading First…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate sample game data" }));
    expect(screen.queryByText("Loading First…")).toBeNull();
    await act(async () => response.reject(new Error("stale failure")));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Sample game · not saved")).toBeInTheDocument();
  });

  it("keeps the completed-game list request current while sample data is shown", async () => {
    const user = userEvent.setup();
    const list = deferred<readonly CompletedGameSessionSummary[]>();
    const completed = completedSummary(
      "00000000-0000-4000-8000-000000000701",
      "Completed after sample",
    );
    render(
      <GameTimelineScreen
        clubId="00000000-0000-4000-8000-000000000101"
        onBack={() => undefined}
        loaders={{ listCompleted: () => list.promise, getSession: vi.fn() }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Generate sample game data" }));
    expect(screen.getByText("Sample game · not saved")).toBeInTheDocument();
    await act(async () => list.resolve([completed]));

    expect(
      screen.getByRole("option", { name: "Completed after sample · Citizens" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Sample game · not saved")).toBeInTheDocument();
  });

  it("rejects a loaded session whose identity does not match the selected game", async () => {
    const user = userEvent.setup();
    const selected = completedSummary("00000000-0000-4000-8000-000000000701", "Expected game");
    render(
      <GameTimelineScreen
        clubId="00000000-0000-4000-8000-000000000101"
        onBack={() => undefined}
        loaders={{
          listCompleted: () => Promise.resolve([selected]),
          getSession: () =>
            Promise.resolve(
              legacySession(
                selected,
                [
                  {
                    id: "00000000-0000-4000-8000-000000000711",
                    sequence: 1,
                    type: "don.checked",
                    phase: "night-don-result",
                    payload: { targetSeat: 1, match: true },
                    secret: true,
                    createdAt: "2026-08-24T18:01:00.000Z",
                  },
                ],
                "00000000-0000-4000-8000-000000000799",
              ),
            ),
        }}
      />,
    );

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Completed game" }),
      selected.gameId,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load Expected game.");
    expect(screen.queryByRole("button", { name: "Don checked Player 1: Sheriff" })).toBeNull();
  });

  it("rejects canonical events whose game identity does not match the session", async () => {
    const user = userEvent.setup();
    const history = createSampleGameHistory();
    const gameId = history.entries[0]!.gameId;
    const selected = completedSummary(gameId, "Cross-game payload");
    render(
      <GameTimelineScreen
        clubId="00000000-0000-4000-8000-000000000101"
        onBack={() => undefined}
        loaders={{
          listCompleted: () => Promise.resolve([selected]),
          getSession: () =>
            Promise.resolve({
              gameId,
              name: selected.name,
              revision: 1,
              duplicate: false,
              status: "completed",
              updatedAt: selected.updatedAt,
              state: {
                setup: null,
                game: null,
                hostPlayerId: null,
                hostName: selected.hostName,
                playlistId: "",
                log: [],
                undoHistory: [],
                initialGame: history.baseline,
                events: [
                  history.entries[0]!,
                  {
                    ...history.entries[1]!,
                    gameId: "00000000-0000-4000-8000-000000000799",
                  },
                ],
                headEventId: history.entries[1]!.id,
                resetReturnEventId: null,
                legacyLog: [],
              },
              results: null,
            }),
        }}
      />,
    );

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Completed game" }),
      gameId,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load Cross-game payload");
  });

  it("applies selected-game success and loading state only to the latest request", async () => {
    const user = userEvent.setup();
    const first = completedSummary("00000000-0000-4000-8000-000000000701", "First");
    const second = completedSummary("00000000-0000-4000-8000-000000000702", "Second");
    const firstResponse = deferred<RemoteGameSession>();
    const secondResponse = deferred<RemoteGameSession>();
    const getSession = vi
      .fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    render(
      <GameTimelineScreen
        clubId="00000000-0000-4000-8000-000000000101"
        onBack={() => undefined}
        loaders={{ listCompleted: () => Promise.resolve([first, second]), getSession }}
      />,
    );

    const selector = await screen.findByRole("combobox", { name: "Completed game" });
    await user.selectOptions(selector, first.gameId);
    expect(screen.getByText("Loading First…")).toBeInTheDocument();
    await user.selectOptions(selector, second.gameId);
    expect(screen.getByText("Loading Second…")).toBeInTheDocument();

    await act(async () =>
      firstResponse.resolve(
        legacySession(first, [
          {
            id: "00000000-0000-4000-8000-000000000711",
            sequence: 1,
            type: "don.checked",
            phase: "night-don-result",
            payload: { targetSeat: 1, match: true },
            secret: true,
            createdAt: "2026-08-24T18:01:00.000Z",
          },
        ]),
      ),
    );
    expect(screen.getByText("Loading Second…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Don checked Player 1: Sheriff" })).toBeNull();

    await act(async () =>
      secondResponse.resolve(
        legacySession(second, [
          {
            id: "00000000-0000-4000-8000-000000000712",
            sequence: 1,
            type: "player.red-carded",
            phase: "day",
            payload: { seat: 8, source: "host" },
            secret: false,
            createdAt: "2026-08-24T19:01:00.000Z",
          },
        ]),
      ),
    );
    expect(screen.queryByText("Loading Second…")).toBeNull();
    expect(screen.getByRole("button", { name: "Red card: Player 8" })).toBeInTheDocument();
  });

  it("generates the browser-only sample and renders replay-derived regions and markers", async () => {
    const user = userEvent.setup();
    render(
      <GameTimelineScreen
        clubId="00000000-0000-4000-8000-000000000101"
        onBack={() => undefined}
        loaders={{
          listCompleted: () => Promise.resolve([]),
          getSession: vi.fn(),
        }}
      />,
    );

    expect(await screen.findByText("No completed games yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate sample game data" }));

    expect(screen.getByRole("heading", { name: "Past game timeline" })).toBeInTheDocument();
    expect(screen.getByText("Sample game · not saved")).toBeInTheDocument();
    for (const label of [
      "Initial night",
      "Day 1",
      "Voting 1",
      "Night 1",
      "Day 2",
      "Voting 2",
      "Night 2",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: /Nomination: Player 1 set Player 7/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mafia shots:.*Result: miss/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Don checked Player 1: Sheriff/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Red card: Player 8/i })).toBeInTheDocument();
  });

  it("redacts secret markers and inspector details while privacy is hidden", async () => {
    const user = userEvent.setup();
    const onTogglePrivacy = vi.fn();
    render(
      <GameTimelineScreen
        clubId="00000000-0000-4000-8000-000000000101"
        onBack={() => undefined}
        loaders={{ listCompleted: () => Promise.resolve([]), getSession: vi.fn() }}
        privacyHidden
        onTogglePrivacy={onTogglePrivacy}
      />,
    );

    await screen.findByText("No completed games yet.");
    await user.click(screen.getByRole("button", { name: "Generate sample game data" }));
    const privateMarkers = screen.getAllByRole("button", { name: "Private event" });
    expect(privateMarkers.length).toBeGreaterThan(0);
    await user.click(privateMarkers[0]!);
    expect(screen.getByRole("heading", { name: "Private event" })).toBeInTheDocument();
    expect(screen.getByText("Hidden")).toBeInTheDocument();
    expect(screen.getByLabelText("Selected event details")).not.toHaveTextContent(/Mafia hits|→/i);

    await user.click(screen.getByRole("button", { name: "Show private info" }));
    expect(onTogglePrivacy).toHaveBeenCalledOnce();
  });

  it("loads a selected completed game and ignores a superseded response", async () => {
    const user = userEvent.setup();
    const first = deferred<never>();
    const second = deferred<never>();
    const list = [
      {
        gameId: "00000000-0000-4000-8000-000000000701",
        name: "First",
        revision: 1,
        hostName: "Host A",
        winner: "red" as const,
        playedAt: "2026-08-24T18:00:00.000Z",
        day: 2,
        eventCount: 10,
        updatedAt: "2026-08-24T18:00:00.000Z",
      },
      {
        gameId: "00000000-0000-4000-8000-000000000702",
        name: "Second",
        revision: 1,
        hostName: "Host B",
        winner: "black" as const,
        playedAt: "2026-08-24T19:00:00.000Z",
        day: 3,
        eventCount: 12,
        updatedAt: "2026-08-24T19:00:00.000Z",
      },
    ];
    const getSession = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(
      <GameTimelineScreen
        clubId="00000000-0000-4000-8000-000000000101"
        onBack={() => undefined}
        loaders={{ listCompleted: () => Promise.resolve(list), getSession }}
      />,
    );

    const selector = await screen.findByRole("combobox", { name: "Completed game" });
    await user.selectOptions(selector, list[0]!.gameId);
    await user.selectOptions(selector, list[1]!.gameId);
    second.reject(new Error("newest failed"));
    await screen.findByRole("alert");
    first.reject(new Error("stale failed"));
    await Promise.resolve();
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load Second");
  });

  it("renders legacy completed logs while honestly disabling historical state preview", async () => {
    const user = userEvent.setup();
    const gameId = "00000000-0000-4000-8000-000000000703";
    const summary = {
      gameId,
      name: "Legacy",
      revision: 5,
      hostName: "Host",
      winner: "red" as const,
      playedAt: "2026-08-24T20:00:00.000Z",
      day: 2,
      eventCount: 2,
      updatedAt: "2026-08-24T20:00:00.000Z",
    };
    const game = createSampleGameHistory().game;
    render(
      <GameTimelineScreen
        clubId="00000000-0000-4000-8000-000000000101"
        onBack={() => undefined}
        loaders={{
          listCompleted: () => Promise.resolve([summary]),
          getSession: () =>
            Promise.resolve({
              gameId,
              name: "Legacy",
              revision: 5,
              duplicate: false,
              status: "completed",
              updatedAt: summary.updatedAt,
              state: {
                setup: null,
                game,
                hostPlayerId: null,
                hostName: "Host",
                playlistId: "",
                log: [
                  {
                    id: "00000000-0000-4000-8000-000000000710",
                    sequence: 1,
                    type: "vote.assigned",
                    phase: "voting",
                    payload: { voterSeat: 2, candidateSeat: 7 },
                    secret: false,
                    createdAt: "2026-08-24T17:59:00.000Z",
                  },
                  {
                    id: "00000000-0000-4000-8000-000000000711",
                    sequence: 2,
                    type: "player.nominated",
                    phase: "day",
                    payload: { nominatorSeat: 1, candidateSeat: 7, day: 1 },
                    secret: false,
                    createdAt: "2026-08-24T18:00:00.000Z",
                  },
                ],
                undoHistory: [],
              },
              results: null,
            }),
        }}
      />,
    );

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Completed game" }),
      gameId,
    );
    expect(await screen.findByText("Legacy log · state preview unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Nomination: Player 1 set Player 7/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vote assigned" })).toBeNull();
  });
});
