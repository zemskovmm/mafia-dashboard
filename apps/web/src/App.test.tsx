import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState } from "@mafia/game-domain";
import type { PlayerProfile, RemoteGameSession } from "./api/client.js";
import { App } from "./App.js";

const api = vi.hoisted(() => ({
  clearGameSession: vi.fn(),
  createPlayer: vi.fn(),
  deletePlayer: vi.fn(),
  getGameSession: vi.fn(),
  listActiveGameSessions: vi.fn(),
  listPlayers: vi.fn(),
  saveGameSession: vi.fn(),
  updatePlayer: vi.fn(),
}));

const hostPlayerId = "00000000-0000-4000-8000-000000000011";
const assignedGame = {
  phase: "mafia-negotiation",
  day: 0,
  winner: null,
  players: Array.from({ length: 10 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
    role: index === 0 ? "sheriff" : index < 7 ? "citizen" : index === 9 ? "don" : "mafia",
    team: index >= 7 ? "black" : "red",
    status: "active",
    fouls: 0,
    mutePending: false,
  })),
  turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
  currentTurnIndex: 0,
  nominations: [],
  voteAssignments: {},
  shotAssignments: {},
} as unknown as GameState;

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

vi.mock("./api/client.js", () => ({
  ...api,
  ApiError: class ApiError extends Error {
    public constructor(
      message: string,
      public readonly status: number,
      public readonly code: string | null,
    ) {
      super(message);
    }
  },
}));

vi.mock("./features/setup/SetupWizard.js", () => ({
  SetupWizard: ({
    onComplete,
    initialSessionState,
    onSessionStateChange,
    onEvent,
    playlistId,
    onPlaylistIdChange,
    onPopulateDevelopmentPlayers,
  }: {
    onComplete: (game: GameState, hostPlayerId: string, hostName: string) => void;
    initialSessionState?: { step: "players" | "music" | "roles" } | null;
    onSessionStateChange?: (state: {
      step: "players" | "music" | "roles";
      hostPlayerId?: string;
      selectedPlayerIds: readonly string[];
      setup: null;
    }) => void;
    onEvent: (type: string, payload: Record<string, unknown>) => void;
    playlistId: string;
    onPlaylistIdChange: (playlistId: string) => void;
    onPopulateDevelopmentPlayers?: () => Promise<readonly PlayerProfile[]>;
  }) => {
    const [step, setStep] = useState(initialSessionState?.step ?? "players");
    return (
      <main>
        <h1>{step === "music" ? "Restored setup" : "Game setup"}</h1>
        <p>Playlist: {playlistId || "none"}</p>
        <button type="button" onClick={() => onPlaylistIdChange("saved-playlist")}>
          Choose saved playlist
        </button>
        <button
          type="button"
          onClick={() => {
            setStep("music");
            onEvent("setup.players-selected", {
              hostPlayerId,
              players: [{ id: assignedGame.players[0]!.id, name: "Player 1", seat: 1 }],
            });
            onSessionStateChange?.({
              step: "music",
              hostPlayerId,
              selectedPlayerIds: [
                assignedGame.players[0]!.id,
                ...Array.from({ length: 9 }, () => ""),
              ],
              setup: null,
            });
          }}
        >
          Save setup progress
        </button>
        <button type="button" onClick={() => onComplete(assignedGame, hostPlayerId, "Host Player")}>
          Start test game
        </button>
        {onPopulateDevelopmentPlayers === undefined ? null : (
          <button
            type="button"
            onClick={() => void onPopulateDevelopmentPlayers().catch(() => undefined)}
          >
            Generate test players
          </button>
        )}
      </main>
    );
  },
}));

vi.mock("./features/game/GameScreen.js", () => ({
  GameScreen: ({
    game,
    hostName,
    onGameChange,
    onEvent,
    onUndo,
    undoCount,
  }: {
    game: GameState;
    hostName: string;
    onGameChange: (game: GameState) => void;
    onEvent: (type: string, payload: Record<string, unknown>) => void;
    onUndo: () => void;
    undoCount: number;
  }) => (
    <main>
      <h1>Live test game</h1>
      <p>Host: {hostName}</p>
      <p>Game day {game.day}</p>
      <p>Game turn {game.currentTurnIndex}</p>
      <button
        type="button"
        onClick={() => {
          const nextTurn = game.currentTurnIndex + 1;
          onGameChange({ ...game, currentTurnIndex: nextTurn });
          onEvent("turn.completed", { turn: nextTurn });
        }}
      >
        Record game action
      </button>
      <button
        type="button"
        onClick={() => {
          const nextDay = game.day + 1;
          onGameChange({ ...game, day: nextDay });
          onEvent("day.started", { day: nextDay });
        }}
      >
        Start new day
      </button>
      <button type="button" disabled={!undoCount} onClick={onUndo}>
        Undo last action
      </button>
      <button
        type="button"
        onClick={() => onGameChange({ ...game, phase: "finished", winner: "red" })}
      >
        Finish test game
      </button>
    </main>
  ),
}));

vi.mock("./features/music/YouTubePlaylistPlayer.js", () => ({
  YouTubePlaylistPlayer: forwardRef(() => <div data-testid="youtube-player" />),
}));

const player = (nickname: string, id: string): PlayerProfile => ({
  id,
  nickname,
  consent: false,
  firstName: null,
  lastName: null,
  email: null,
  consentAt: null,
  createdAt: "2026-08-17T20:00:00.000Z",
  updatedAt: "2026-08-17T20:00:00.000Z",
  lastPlayedAt: null,
  statistics: {
    hostedGames: 0,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    redGames: 0,
    redWins: 0,
    blackGames: 0,
    blackWins: 0,
    sheriffGames: 0,
    citizenGames: 0,
    mafiaGames: 0,
    donGames: 0,
    totalFouls: 0,
    eliminations: 0,
    redCards: 0,
  },
});

beforeEach(() => {
  api.clearGameSession.mockReset().mockResolvedValue(undefined);
  api.createPlayer.mockReset();
  api.deletePlayer.mockReset().mockResolvedValue(undefined);
  api.getGameSession.mockReset();
  api.listActiveGameSessions.mockReset().mockResolvedValue([]);
  api.listPlayers.mockReset().mockResolvedValue([]);
  api.saveGameSession
    .mockReset()
    .mockImplementation((_gameId: string, mutation: { baseRevision: number }) =>
      Promise.resolve({ revision: mutation.baseRevision + 1, duplicate: false }),
    );
  api.updatePlayer.mockReset();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("authoritative game session lifecycle", () => {
  it("creates no empty remote game and persists setup through one full session mutation", async () => {
    const user = userEvent.setup();
    api.listPlayers.mockResolvedValue([player("Host Player", hostPlayerId)]);
    render(<App />);
    await waitFor(() => expect(api.listPlayers).toHaveBeenCalledOnce());
    expect(api.saveGameSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save setup progress" }));

    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    expect(api.saveGameSession).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      expect.objectContaining({
        mutationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        baseRevision: 0,
        state: expect.objectContaining({
          setup: expect.objectContaining({ step: "music" }),
          hostPlayerId,
          hostName: "Host Player",
          log: [expect.objectContaining({ type: "setup.players-selected" })],
        }),
        results: null,
      }),
    );
  });

  it("persists one full snapshot for a normal game action including log and undo", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Record game action" }));

    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    expect(api.saveGameSession.mock.calls[0]?.[1]).toMatchObject({
      state: {
        game: expect.objectContaining({ currentTurnIndex: 1, day: 0 }),
        log: [expect.objectContaining({ type: "turn.completed" })],
        undoHistory: [expect.objectContaining({ logLength: 0 })],
      },
      results: null,
    });
  });

  it("stores final results and retracts them only through full aggregate snapshots", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalled());
    api.saveGameSession.mockClear();

    await user.click(screen.getByRole("button", { name: "Finish test game" }));
    await waitFor(() =>
      expect(api.saveGameSession).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          state: expect.objectContaining({ game: expect.objectContaining({ phase: "finished" }) }),
          results: expect.objectContaining({ hostPlayerId, winner: "red" }),
        }),
      ),
    );
    await waitFor(() => expect(api.listPlayers).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Undo last action" }));
    await waitFor(() =>
      expect(api.saveGameSession).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          state: expect.objectContaining({
            game: expect.objectContaining({ phase: "mafia-negotiation" }),
          }),
          results: null,
        }),
      ),
    );
    await waitFor(() => expect(api.listPlayers).toHaveBeenCalledTimes(3));
  });

  it("keeps Local only when the newer queued aggregate mutation fails", async () => {
    const user = userEvent.setup();
    const first = deferred<{ revision: number; duplicate: boolean }>();
    api.saveGameSession
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValueOnce(new Error("offline"));
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Record game action" }));
    expect(screen.getByText("Saving")).toBeInTheDocument();

    first.resolve({ revision: 1, duplicate: false });

    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Local only")).toBeInTheDocument());
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v3") ?? "null"),
    ).toMatchObject({ failed: true, outbox: [expect.objectContaining({ baseRevision: 1 })] });
  });

  it("uses latest-request-wins when two active sessions are resumed", async () => {
    const user = userEvent.setup();
    const sessionAId = "00000000-0000-4000-8000-0000000000a1";
    const sessionBId = "00000000-0000-4000-8000-0000000000b2";
    const sessionA = deferred<RemoteGameSession>();
    const sessionB = deferred<RemoteGameSession>();
    api.listActiveGameSessions.mockResolvedValue([
      {
        gameId: sessionAId,
        name: "Table A",
        revision: 4,
        hostName: "Host A",
        phase: "day",
        day: 2,
        updatedAt: "2026-08-18T08:00:00.000Z",
      },
      {
        gameId: sessionBId,
        name: "Table B",
        revision: 7,
        hostName: "Host B",
        phase: "day",
        day: 3,
        updatedAt: "2026-08-18T09:00:00.000Z",
      },
    ]);
    api.getGameSession.mockImplementation((gameId: string) =>
      gameId === sessionAId ? sessionA.promise : sessionB.promise,
    );
    render(<App />);
    await screen.findByRole("button", { name: "Resume Table A" });

    await user.click(screen.getByRole("button", { name: "Resume Table A" }));
    await user.click(screen.getByRole("button", { name: "Resume Table B" }));
    sessionB.resolve(remoteSession(sessionBId, "Table B", "Host B", 7, 3));
    await screen.findByText("Host: Host B");
    sessionA.resolve(remoteSession(sessionAId, "Table A", "Host A", 4, 2));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Host: Host B")).toBeInTheDocument();
    expect(screen.getByText("Game day 3")).toBeInTheDocument();
    expect(api.saveGameSession).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v3") ?? "null"),
    ).toMatchObject({ gameId: sessionBId, revision: 7, outbox: [] });
  });

  it("ignores a resume response after newer local setup is saved", async () => {
    const user = userEvent.setup();
    const remoteGameId = "00000000-0000-4000-8000-0000000000c3";
    const remote = deferred<RemoteGameSession>();
    api.listActiveGameSessions.mockResolvedValue([
      {
        gameId: remoteGameId,
        name: "Remote table",
        revision: 5,
        hostName: "Remote host",
        phase: "day",
        day: 2,
        updatedAt: "2026-08-18T09:00:00.000Z",
      },
    ]);
    api.getGameSession.mockReturnValue(remote.promise);
    render(<App />);
    await screen.findByRole("button", { name: "Resume Remote table" });

    await user.click(screen.getByRole("button", { name: "Resume Remote table" }));
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    const localGameId = api.saveGameSession.mock.calls[0]?.[0] as string;

    remote.resolve(remoteSession(remoteGameId, "Remote table", "Remote host", 5, 2));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(screen.queryByText("Host: Remote host")).not.toBeInTheDocument();
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v3") ?? "null"),
    ).toMatchObject({ gameId: localGameId, revision: 1, outbox: [] });
  });

  it("restores full live state from the durable browser aggregate after reload", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record game action" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    const callsBeforeReload = api.saveGameSession.mock.calls.length;

    firstRender.unmount();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Live test game" })).toBeInTheDocument();
    expect(screen.getByText("Host: Host Player")).toBeInTheDocument();
    expect(screen.getByText("Game turn 1")).toBeInTheDocument();
    expect(screen.getByText("turn.completed")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.saveGameSession).toHaveBeenCalledTimes(callsBeforeReload);
  });

  it("restores setup and playlist progress from the durable browser aggregate", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.click(screen.getByRole("button", { name: "Choose saved playlist" }));
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());

    firstRender.unmount();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(screen.getByText("Playlist: saved-playlist")).toBeInTheDocument();
  });

  it("clears by known UUID while first save is pending and waits for the tombstone", async () => {
    const user = userEvent.setup();
    const firstSave = deferred<{ revision: number; duplicate: boolean }>();
    const clear = deferred<void>();
    api.saveGameSession.mockImplementationOnce(() => firstSave.promise);
    api.clearGameSession.mockImplementationOnce(() => clear.promise);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledOnce());
    const gameId = api.saveGameSession.mock.calls[0]?.[0] as string;

    await user.click(screen.getByRole("button", { name: "Clear game state" }));

    expect(confirm).toHaveBeenCalledWith(
      "Delete this active game from the server? This is irreversible and removes its saved session and game log for every browser.",
    );
    expect(api.clearGameSession).toHaveBeenCalledWith(gameId);
    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    clear.resolve();
    await screen.findByRole("heading", { name: "Game setup" });
    expect(window.sessionStorage.getItem("mafia-dashboard.game-session.v3")).toBeNull();
    firstSave.resolve({ revision: 1, duplicate: false });
  });

  it("does not reset newer local setup after an older clear completes", async () => {
    const user = userEvent.setup();
    const clear = deferred<void>();
    api.clearGameSession.mockImplementationOnce(() => clear.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    const clearedGameId = api.saveGameSession.mock.calls[0]?.[0] as string;

    await user.click(screen.getByRole("button", { name: "Clear game state" }));
    await user.click(screen.getByRole("button", { name: "Choose saved playlist" }));
    await waitFor(() => expect(api.saveGameSession).toHaveBeenCalledTimes(2));
    const newerGameId = api.saveGameSession.mock.calls[1]?.[0] as string;
    expect(newerGameId).not.toBe(clearedGameId);

    clear.resolve();
    await waitFor(() => expect(api.clearGameSession).toHaveBeenCalledWith(clearedGameId));

    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(screen.getByText("Playlist: saved-playlist")).toBeInTheDocument();
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v3") ?? "null"),
    ).toMatchObject({ gameId: newerGameId, current: { state: { playlistId: "saved-playlist" } } });
  });

  it("preserves local setup and outbox when remote clear fails", async () => {
    const user = userEvent.setup();
    api.clearGameSession.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Save setup progress" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Clear game state" }));

    await waitFor(() => expect(screen.getByText("Local only")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Restored setup" })).toBeInTheDocument();
    expect(
      JSON.parse(window.sessionStorage.getItem("mafia-dashboard.game-session.v3") ?? "null"),
    ).toMatchObject({
      current: { state: { setup: { step: "music" } } },
      failed: false,
      clearFailed: true,
    });
  });
});

const remoteSession = (
  gameId: string,
  name: string,
  restoredHostName: string,
  revision: number,
  day: number,
): RemoteGameSession => ({
  gameId,
  name,
  revision,
  duplicate: false,
  status: "active",
  updatedAt: "2026-08-18T09:00:00.000Z",
  state: {
    setup: null,
    game: { ...assignedGame, day },
    hostPlayerId,
    hostName: restoredHostName,
    playlistId: `PL-${name}`,
    log: [],
    undoHistory: [],
  },
  results: null,
});

describe("undo checkpoints", () => {
  it("treats day zero to one and every later day increment as an undo checkpoint", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Record game action" }));
    await user.click(screen.getByRole("button", { name: "Record game action" }));
    expect(screen.getByRole("button", { name: "Undo last action" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Start new day" }));

    expect(screen.getByText("Game day 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo last action" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Record game action" }));
    await user.click(screen.getByRole("button", { name: "Undo last action" }));
    expect(screen.getByText("Game day 1")).toBeInTheDocument();
    expect(screen.getAllByText("turn.completed")).toHaveLength(2);
    expect(screen.getByText("day.started")).toBeInTheDocument();
  });

  it("retains only three ordinary actions and undo removes matching log state", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    for (let index = 0; index < 4; index += 1) {
      await user.click(screen.getByRole("button", { name: "Record game action" }));
    }
    expect(screen.getByText("Game turn 4")).toBeInTheDocument();
    expect(screen.getAllByText("turn.completed")).toHaveLength(4);

    for (let index = 0; index < 3; index += 1) {
      await user.click(screen.getByRole("button", { name: "Undo last action" }));
    }
    expect(screen.getByText("Game turn 1")).toBeInTheDocument();
    expect(screen.getAllByText("turn.completed")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Undo last action" })).toBeDisabled();
  });
});

describe("player workflows", () => {
  it("loads players separately and protects the current roster from deletion", async () => {
    const user = userEvent.setup();
    api.listPlayers.mockResolvedValue([
      ...assignedGame.players.map(({ id, name }) => player(name, id)),
      player("Host Player", hostPlayerId),
    ]);
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Start test game" }));
    await user.click(screen.getByRole("button", { name: "Players & statistics" }));

    expect(screen.getByRole("heading", { name: "Players & statistics" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Player 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Host Player" })).toBeDisabled();
  });

  it("creates one host and ten nickname-only development players", async () => {
    const user = userEvent.setup();
    let created = 0;
    api.createPlayer.mockImplementation(async (input: { nickname: string }) => {
      created += 1;
      return player(input.nickname, `10000000-0000-4000-8000-${String(created).padStart(12, "0")}`);
    });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Generate test players" }));

    await waitFor(() => expect(api.createPlayer).toHaveBeenCalledTimes(11));
    expect(new Set(api.createPlayer.mock.calls.map(([input]) => input.nickname)).size).toBe(11);
  });

  it("rolls back a partially created development roster", async () => {
    const user = userEvent.setup();
    const first = player("Dev First", "00000000-0000-4000-8000-000000000001");
    const second = player("Dev Second", "00000000-0000-4000-8000-000000000002");
    api.createPlayer
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockRejectedValueOnce(new Error("network unavailable"));
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Generate test players" }));

    await waitFor(() => expect(api.deletePlayer).toHaveBeenCalledTimes(2));
    expect(api.deletePlayer).toHaveBeenCalledWith(first.id);
    expect(api.deletePlayer).toHaveBeenCalledWith(second.id);
  });
});
