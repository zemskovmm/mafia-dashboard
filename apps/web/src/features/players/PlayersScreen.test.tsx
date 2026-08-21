import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.js";
import type { PlayerProfile } from "../../api/client.js";
import { PlayersScreen } from "./PlayersScreen.js";

afterEach(cleanup);

const profile = (overrides: Partial<PlayerProfile> = {}): PlayerProfile => ({
  id: "00000000-0000-4000-8000-000000000001",
  nickname: "Alpha",
  consent: true,
  firstName: "Ada",
  lastName: "Player",
  email: "ada@example.test",
  consentAt: "2026-08-17T20:00:00.000Z",
  createdAt: "2026-08-17T20:00:00.000Z",
  updatedAt: "2026-08-17T20:00:00.000Z",
  lastPlayedAt: "2026-08-17T22:00:00.000Z",
  statistics: {
    hostedGames: 2,
    gamesPlayed: 5,
    wins: 3,
    losses: 2,
    redGames: 3,
    redWins: 2,
    blackGames: 2,
    blackWins: 1,
    sheriffGames: 1,
    citizenGames: 2,
    mafiaGames: 1,
    donGames: 1,
    totalFouls: 4,
    eliminations: 1,
    redCards: 0,
    bestMoves: 0,
    bestMoveMafiaHits: 0,
  },
  ...overrides,
});

describe("PlayersScreen", () => {
  it("submits a changed player name", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<PlayersScreen players={[profile()]} onCreate={vi.fn()} onUpdate={onUpdate} />);
    const card = screen.getByRole("article", { name: /player alpha/i });

    await user.clear(within(card).getByLabelText(/alpha nickname/i));
    await user.type(within(card).getByLabelText(/alpha nickname/i), "Bravo");
    await user.click(within(card).getByRole("button", { name: /save alpha/i }));

    expect(onUpdate).toHaveBeenCalledWith(
      profile().id,
      expect.objectContaining({ nickname: "Bravo" }),
    );
  });

  it("requires confirmation before deleting a player", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <PlayersScreen
        players={[profile()]}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        {...({ onDelete } as Record<string, unknown>)}
      />,
    );

    await user.click(screen.getByRole("button", { name: /delete alpha/i }));
    expect(confirm).toHaveBeenCalledWith(
      'Delete player "Alpha" and 7 associated games? Those games will also be removed from every affected player\'s statistics. This cannot be undone.',
    );
    expect(onDelete).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: /delete alpha/i }));
    expect(onDelete).toHaveBeenCalledWith(profile().id);
  });

  it("creates a nickname-only profile when consent is not granted", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<PlayersScreen players={[]} onCreate={onCreate} onUpdate={vi.fn()} />);

    expect(screen.getByLabelText(/new player first name/i)).toBeDisabled();
    await user.type(screen.getByLabelText(/new player nickname/i), "Night Owl");
    await user.click(screen.getByRole("button", { name: /add player/i }));

    expect(onCreate).toHaveBeenCalledWith({
      nickname: "Night Owl",
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
  });

  it("requires all personal fields after data-processing consent", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<PlayersScreen players={[]} onCreate={onCreate} onUpdate={vi.fn()} />);

    await user.type(screen.getByLabelText(/new player nickname/i), "Consented");
    await user.click(screen.getByLabelText(/new player agree for data processing/i));
    const firstName = screen.getByLabelText(/new player first name/i);
    const lastName = screen.getByLabelText(/new player last name/i);
    const email = screen.getByLabelText(/new player email/i);
    expect(firstName).toBeRequired();
    expect(lastName).toBeRequired();
    expect(email).toBeRequired();

    await user.type(firstName, "Grace");
    await user.type(lastName, "Host");
    await user.type(email, "grace@example.test");
    await user.click(screen.getByRole("button", { name: /add player/i }));

    expect(onCreate).toHaveBeenCalledWith({
      nickname: "Consented",
      consent: true,
      firstName: "Grace",
      lastName: "Host",
      email: "grace@example.test",
    });
  });

  it("keeps the create form open and explains nickname conflicts", async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockRejectedValue(new ApiError("Unable to create player", 409, "nickname_conflict"));
    render(<PlayersScreen players={[]} onCreate={onCreate} onUpdate={vi.fn()} />);

    const nickname = screen.getByLabelText(/new player nickname/i);
    await user.type(nickname, "Duplicate");
    await user.click(screen.getByRole("button", { name: /add player/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/nickname already exists/i);
    expect(nickname).toHaveValue("Duplicate");
  });

  it("renders statistics and clears personal fields when consent is withdrawn", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<PlayersScreen players={[profile()]} onCreate={vi.fn()} onUpdate={onUpdate} />);

    const card = screen.getByRole("article", { name: /player alpha/i });
    const hostedLabel = within(card).getByText("Hosted");
    expect(hostedLabel.previousElementSibling).toHaveTextContent("2");
    expect(within(card).getByText("5")).toBeInTheDocument();
    expect(within(card).getByText(/60% win rate/i)).toBeInTheDocument();
    expect(within(card).getByText(/sheriff 1/i)).toBeInTheDocument();

    await user.click(within(card).getByLabelText(/alpha agree for data processing/i));
    expect(within(card).getByLabelText(/alpha first name/i)).toBeDisabled();
    expect(within(card).getByLabelText(/alpha first name/i)).toHaveValue("");
    await user.click(within(card).getByRole("button", { name: /save alpha/i }));

    expect(onUpdate).toHaveBeenCalledWith(profile().id, {
      nickname: "Alpha",
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
  });
});
