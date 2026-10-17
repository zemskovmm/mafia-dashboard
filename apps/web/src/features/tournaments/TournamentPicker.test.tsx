import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import type * as ApiClient from "../../api/client.js";
import { createTournament, listTournaments } from "../../api/client.js";
import { TournamentPicker } from "./TournamentPicker.js";

vi.mock("../../api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listTournaments: vi.fn(),
  createTournament: vi.fn(),
}));
const tournament = { id: "event-a", name: "Autumn cup" };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listTournaments).mockResolvedValue([tournament]);
  vi.mocked(createTournament).mockResolvedValue(tournament);
});

describe("TournamentPicker", () => {
  it("preserves a just-created choice when the initial list resolves later", async () => {
    const user = userEvent.setup();
    const pendingList = deferred<readonly (typeof tournament)[]>();
    vi.mocked(listTournaments).mockReturnValueOnce(pendingList.promise);
    const onChange = vi.fn();
    render(<TournamentPicker clubId="club-a" value={null} onChange={onChange} />);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "New tournament…" }));
    await user.type(screen.getByRole("textbox"), "Autumn cup");
    await user.click(screen.getByRole("button", { name: "Create tournament" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(tournament.id));
    await act(async () => pendingList.resolve([]));
    expect(screen.getByRole("option", { name: "Autumn cup" })).toBeInTheDocument();
  });

  it("leaves typing and Escape native and cancels using the visible control without submitting a containing form", async () => {
    const user = userEvent.setup();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const onChange = vi.fn();
    render(
      <form onSubmit={submit}>
        <TournamentPicker clubId="club-a" value={null} onChange={onChange} />
      </form>,
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "New tournament…" }));
    expect(screen.getByRole("textbox")).not.toHaveFocus();
    await user.type(screen.getByRole("textbox"), "Keep name");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("textbox")).toHaveValue("Keep name");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    fireEvent(screen.getByRole("textbox"), enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(createTournament).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("ignores a creation that finishes after the picker is externally disabled", async () => {
    const user = userEvent.setup();
    const pending = deferred<typeof tournament>();
    vi.mocked(createTournament).mockReturnValueOnce(pending.promise);
    const onChange = vi.fn();
    const { rerender } = render(
      <TournamentPicker clubId="club-a" value={null} onChange={onChange} />,
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "New tournament…" }));
    await user.type(screen.getByRole("textbox"), "Autumn cup");
    await user.click(screen.getByRole("button", { name: "Create tournament" }));
    rerender(<TournamentPicker clubId="club-a" value={null} onChange={onChange} disabled />);
    await act(async () => pending.resolve(tournament));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("defaults off, reports invalid while enabled without selection, and opening never mutates", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    const { rerender } = render(
      <TournamentPicker
        clubId="club-a"
        value={null}
        onChange={onChange}
        onValidityChange={onValidityChange}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Include in tournament" })).not.toBeChecked();
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
    await user.click(screen.getByRole("checkbox"));
    expect(await screen.findByRole("option", { name: tournament.name })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("combobox", { name: "Tournament" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await user.selectOptions(screen.getByRole("combobox"), tournament.id);
    expect(onChange).toHaveBeenCalledWith(tournament.id);
    rerender(
      <TournamentPicker
        clubId="club-a"
        value={tournament.id}
        onChange={onChange}
        onValidityChange={onValidityChange}
      />,
    );
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(true));
    await user.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("creates with a trimmed name only and selects only the server-issued identity", async () => {
    const user = userEvent.setup();
    const request = deferred<typeof tournament>();
    vi.mocked(createTournament).mockReturnValue(request.promise);
    const onChange = vi.fn();
    render(<TournamentPicker clubId="club-a" value={null} onChange={onChange} />);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "New tournament…" }));
    await user.type(screen.getByRole("textbox", { name: "Tournament name" }), "  Autumn cup  ");
    await user.click(screen.getByRole("button", { name: "Create tournament" }));
    expect(createTournament).toHaveBeenCalledWith("Autumn cup", "club-a");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    await act(async () => request.resolve(tournament));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(tournament.id);
  });

  it("ignores creation after cancel or a club switch, and resets busy for a fresh choice", async () => {
    const user = userEvent.setup();
    const first = deferred<typeof tournament>();
    const second = deferred<typeof tournament>();
    vi.mocked(createTournament)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onChange = vi.fn();
    const { rerender } = render(
      <TournamentPicker clubId="club-a" value={null} onChange={onChange} />,
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "New tournament…" }));
    await user.type(screen.getByRole("textbox"), "One");
    await user.click(screen.getByRole("button", { name: "Create tournament" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => first.resolve(tournament));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "New tournament…" }));
    await user.type(screen.getByRole("textbox"), "Two");
    await user.click(screen.getByRole("button", { name: "Create tournament" }));
    rerender(<TournamentPicker clubId="club-b" value={null} onChange={onChange} />);
    await act(async () => second.resolve(tournament));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    await user.click(screen.getByRole("checkbox"));
    expect(await screen.findByRole("button", { name: "New tournament…" })).toBeEnabled();
  });

  it("does not let an obsolete list replace the new club's tournaments", async () => {
    const user = userEvent.setup();
    const old = deferred<readonly (typeof tournament)[]>();
    vi.mocked(listTournaments)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([{ id: "b", name: "Winter" }]);
    const { rerender } = render(
      <TournamentPicker clubId="club-a" value={null} onChange={vi.fn()} />,
    );
    await user.click(screen.getByRole("checkbox"));
    rerender(<TournamentPicker clubId="club-b" value="b" onChange={vi.fn()} />);
    expect(await screen.findByRole("option", { name: "Winter" })).toBeInTheDocument();
    await act(async () => old.resolve([tournament]));
    expect(screen.queryByRole("option", { name: "Autumn cup" })).not.toBeInTheDocument();
  });

  it("localizes errors, retries and disabled controls without exposing raw failures", async () => {
    const user = userEvent.setup();
    vi.mocked(listTournaments).mockRejectedValueOnce(new Error("private payload"));
    const { rerender } = render(
      <I18nProvider locale="ru">
        <TournamentPicker clubId="club-a" value="event-a" onChange={vi.fn()} />
      </I18nProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить турниры.");
    expect(screen.queryByText("private payload")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("option", { name: tournament.name })).toBeInTheDocument();
    rerender(
      <I18nProvider locale="ru">
        <TournamentPicker clubId="club-a" value="event-a" onChange={vi.fn()} disabled />
      </I18nProvider>,
    );
    expect(screen.getByRole("checkbox", { name: "Включить в турнир" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Турнир" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Новый турнир…" })).toBeDisabled();
  });

  it("retains name and offers retry after creation failure, with no parent mutation", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    vi.mocked(createTournament).mockRejectedValueOnce(new Error("private"));
    render(<TournamentPicker clubId="club-a" value={null} onChange={onChange} />);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "New tournament…" }));
    await user.type(screen.getByRole("textbox"), "Autumn cup");
    await user.click(screen.getByRole("button", { name: "Create tournament" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to create tournament.");
    expect(screen.getByRole("textbox")).toHaveValue("Autumn cup");
    expect(screen.getByRole("button", { name: "Create tournament" })).toBeEnabled();
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Create tournament" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(tournament.id));
  });
});
