import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotebookGameCreation } from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { NotebookImportScreen } from "./NotebookImportScreen.js";

const players = [
  { id: "p1", nickname: "Alice" },
  { id: "p2", nickname: "Boris" },
  { id: "p3", nickname: "Cleo" },
  { id: "host", nickname: "Host" },
];
const texts = {
  en: {
    label: "Game label",
    player: "Player at seat",
    role: "Role at seat",
    day: "Seat 1, day 1",
    night: "Seat 2, night 1",
    review: "Review import",
    save: "Import game",
    success: "Game imported and verified",
    table: "Recorded notebook",
    retry: "Retry same import",
    edit: "Edit table",
    saving: "Saving and verifying…",
    owner: "Best Move owner seat",
    target: "Best Move target 1",
  },
  ru: {
    label: "Название игры",
    player: "Игрок на месте",
    role: "Роль на месте",
    day: "Место 1, день 1",
    night: "Место 2, ночь 1",
    review: "Проверить импорт",
    save: "Импортировать игру",
    success: "Игра импортирована и проверена",
    table: "Записи из тетради",
    retry: "Повторить тот же импорт",
    edit: "Изменить таблицу",
    saving: "Сохранение и проверка…",
    owner: "Место автора лучшего хода",
    target: "Номер 1 в лучшем ходе",
  },
} as const;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const session = (payload: NotebookGameCreation, overrides: Record<string, unknown> = {}) => ({
  gameId: "saved-game",
  name: payload.name,
  revision: 1,
  duplicate: false,
  status: "completed",
  updatedAt: "2026-10-25T12:00:00Z",
  state: payload.state,
  results: payload.results,
  ...overrides,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const change = (name: string, value: string) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
const start = (locale: "en" | "ru" = "en", onSaved = vi.fn()) => {
  const view = render(
    <I18nProvider locale={locale}>
      <NotebookImportScreen clubId="club-a" players={players} onBack={vi.fn()} onSaved={onSaved} />
    </I18nProvider>,
  );
  change(texts[locale].label, "Paper evening");
  change(`${texts[locale].player} 1`, "p1");
  return { ...view, onSaved };
};
const reviewAndSave = (locale: "en" | "ru" = "en") => {
  fireEvent.click(screen.getByRole("button", { name: texts[locale].review }));
  fireEvent.click(screen.getByRole("button", { name: texts[locale].save }));
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["en", "ru"] as const)("manual notebook UI (%s)", (locale) => {
  it("reviews, imports sparse identity-only facts and shows the actual read-back table", async () => {
    const text = texts[locale];
    const requests: NotebookGameCreation[] = [];
    const readback = deferred<Response>();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as NotebookGameCreation;
        requests.push(payload);
        return json(session(payload));
      }
      return readback.promise;
    });
    vi.stubGlobal("fetch", fetcher);
    window.localStorage.setItem("active-game-sentinel", "untouched");
    const { onSaved } = start(locale);
    change(`${text.player} 2`, "p2");
    change(`${text.player} 3`, "p3");
    change(`${text.role} 2`, "mafia");
    change(`${text.role} 4`, "don");
    change(text.day, "4 х");
    change(text.night, "Х");
    change(text.owner, "1");
    change(text.target, "2");
    fireEvent.click(screen.getByRole("button", { name: text.review }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("table", { name: text.table })).getByText("4 X"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("table", { name: text.table })).getByText(
        locale === "en" ? "Д Don" : "Д Дон",
      ),
    ).toBeInTheDocument();
    const save = screen.getByRole("button", { name: text.save });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: text.saving })).toBeDisabled();
    expect(requests).toHaveLength(1);
    const payload = requests[0]!;
    expect(payload.results).toEqual({
      players: [
        { playerId: "p1", seat: 1, status: "eliminated", bestMoveHits: 1 },
        { playerId: "p2", seat: 2, role: "mafia", team: "black", status: "eliminated" },
        { playerId: "p3", seat: 3 },
      ],
    });
    expect(payload.state).toEqual({
      notebook: {
        dayCount: 5,
        seatRoles: [
          { seat: 2, role: "mafia" },
          { seat: 4, role: "don" },
        ],
        cells: [
          { seat: 1, day: 1, phase: "day", nomination: 4, eliminated: true },
          { seat: 2, day: 1, phase: "night", eliminated: true },
        ],
        bestMove: { ownerSeat: 1, targetSeats: [2] },
      },
    });
    expect(payload.creationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(payload)).not.toMatch(
      /Alice|Boris|Cleo|nickname|events|fouls|playedAt|outcome|hostPlayerId|"active"/,
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-club-id": "club-a" });
    await act(async () => readback.resolve(json({ session: session(payload) })));
    expect(await screen.findByRole("status")).toHaveTextContent(text.success);
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ gameId: "saved-game", status: "completed" }),
    );
    expect(
      within(screen.getByRole("table", { name: text.table })).getByText("4 X"),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem("active-game-sentinel")).toBe("untouched");
    expect(
      within(screen.getByRole("table", { name: text.table })).getByText(
        locale === "en" ? "Д Don" : "Д Дон",
      ),
    ).toBeInTheDocument();
  });
});

it("retains the exact request and creation id after failed read-back, then verifies a duplicate retry", async () => {
  const bodies: string[] = [];
  let payload!: NotebookGameCreation;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        bodies.push(String(init.body));
        payload = JSON.parse(String(init.body)) as NotebookGameCreation;
        return json(session(payload, { duplicate: bodies.length > 1 }));
      }
      reads += 1;
      return reads === 1
        ? json({ error: "temporary_failure" }, 503)
        : json({ session: session(payload, { duplicate: true }) });
    }),
  );
  const { onSaved } = start();
  reviewAndSave();
  expect(await screen.findByRole("alert")).toHaveTextContent("not confirmed");
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Edit table" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry same import" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Game imported and verified");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it("keeps the original request locked after an ambiguous POST even if a later retry is rejected", async () => {
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new TypeError("Connection lost after commit");
      return json({ error: "unauthorized" }, 401);
    }),
  );
  start();
  reviewAndSave();
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry same import" }));
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(screen.getByRole("button", { name: "Edit table" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Retry same import" })).toBeEnabled();
  expect(bodies[1]).toBe(bodies[0]);
});

it("validates night-only X, duplicate identities and host overlap without rejecting an unknown seat's role", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  start();
  change("Seat 2, night 1", "4");
  change("Player at seat 2", "p1");
  change("Role at seat 3", "don");
  change("Host (optional)", "p1");
  change("Best Move target 1", "2");
  change("Best Move target 2", "2");
  fireEvent.click(screen.getByRole("button", { name: "Review import" }));
  expect(
    screen.getByText("Night accepts X only; move nominations to a day cell."),
  ).toBeInTheDocument();
  expect(screen.getByText("This player is already seated.")).toBeInTheDocument();
  expect(screen.getByLabelText("Player at seat 3")).not.toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText(/Choose an existing host who is not seated/)).toBeInTheDocument();
  expect(screen.getByText("Choose up to three distinct seats 1–10.")).toBeInTheDocument();
  expect(screen.getByLabelText("Seat 2, night 1")).toHaveAttribute("aria-invalid", "true");
  expect(screen.queryByRole("button", { name: "Import game" })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Game label")).toHaveValue("Paper evening");
});

it("allows observations on unknown seats, bounds added days and preserves unknown Best Move hits", async () => {
  let payload!: NotebookGameCreation;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        payload = JSON.parse(String(init.body)) as NotebookGameCreation;
        return json(session(payload));
      }
      return json({ session: session(payload) });
    }),
  );
  start();
  change("Seat 10, day 1", "10 X");
  change("Best Move owner seat", "1");
  change("Best Move target 1", "10");
  fireEvent.click(screen.getByRole("button", { name: "Add day / night" }));
  expect(screen.getByLabelText("Seat 1, day 6")).toHaveValue("");
  reviewAndSave();
  await screen.findByRole("status");
  expect(payload.state.notebook.cells).toEqual([
    { seat: 10, day: 1, phase: "day", nomination: 10, eliminated: true },
  ]);
  expect(payload.results.players).toEqual([{ playerId: "p1", seat: 1 }]);
  expect(payload.state.notebook.dayCount).toBe(6);
});

it("disables adding beyond twenty day/night pairs without discarding entered cells", () => {
  start();
  change("Seat 1, day 1", "4 X");
  const add = screen.getByRole("button", { name: "Add day / night" });
  for (let count = 5; count < 20; count += 1) fireEvent.click(add);
  expect(add).toBeDisabled();
  expect(screen.getByLabelText("Seat 10, night 20")).toHaveValue("");
  expect(screen.queryByLabelText("Seat 1, day 21")).toBeNull();
  expect(screen.getByLabelText("Seat 1, day 1")).toHaveValue("4 X");
});

it.each(["gameId", "status", "notebook", "name", "results", "defaults", "state"] as const)(
  "does not confirm mismatched read-back %s",
  async (mismatch) => {
    let payload!: NotebookGameCreation;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          payload = JSON.parse(String(init.body)) as NotebookGameCreation;
          return json(session(payload));
        }
        const overrides =
          mismatch === "state"
            ? { state: { ...payload.state, game: { phase: "finished" } } }
            : mismatch === "gameId"
              ? { gameId: "another-game" }
              : mismatch === "status"
                ? { status: "active" }
                : mismatch === "name"
                  ? { name: "Another paper game" }
                  : mismatch === "results"
                    ? { results: { players: [{ playerId: "p2", seat: 1 }] } }
                    : mismatch === "defaults"
                      ? {
                          results: {
                            ...payload.results,
                            players: [{ ...payload.results.players[0], fouls: 0 }],
                          },
                        }
                      : { state: { notebook: { dayCount: 1, cells: [] } } };
        return json({ session: session(payload, overrides) });
      }),
    );
    const { onSaved } = start();
    reviewAndSave();
    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Edit table" })).toBeDisabled();
  },
);

it("unlocks a definitely rejected POST for corrections without losing the draft", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ error: "validation_failed" }, 400)),
  );
  start();
  reviewAndSave();
  expect(await screen.findByRole("alert")).toHaveTextContent("server rejected");
  expect(screen.getByLabelText("Game label")).toHaveValue("Paper evening");
  expect(screen.getByLabelText("Player at seat 1")).toHaveValue("p1");
  change("Game label", "Corrected game");
  fireEvent.click(screen.getByRole("button", { name: "Review import" }));
  expect(screen.getByRole("button", { name: "Edit table" })).toBeEnabled();
});

it("ignores a previous club's delayed creation response and resets the next club's draft", async () => {
  const post = deferred<Response>();
  const fetcher = vi.fn(() => post.promise);
  vi.stubGlobal("fetch", fetcher);
  const { rerender, onSaved } = start();
  reviewAndSave();
  const payload = JSON.parse(
    String((fetcher.mock.calls as unknown as [unknown, RequestInit][])[0]?.[1].body),
  ) as NotebookGameCreation;
  rerender(
    <I18nProvider locale="en">
      <NotebookImportScreen clubId="club-b" players={players} onBack={vi.fn()} onSaved={onSaved} />
    </I18nProvider>,
  );
  expect(screen.getByLabelText("Game label")).toHaveValue("");
  await act(async () => post.resolve(json(session(payload))));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});

it("does not invoke onSaved after unmount while read-back is pending", async () => {
  const readback = deferred<Response>();
  let payload!: NotebookGameCreation;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      payload = JSON.parse(String(init.body)) as NotebookGameCreation;
      return json(session(payload));
    }
    return readback.promise;
  });
  vi.stubGlobal("fetch", fetcher);
  const { unmount, onSaved } = start();
  reviewAndSave();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  unmount();
  await act(async () => readback.resolve(json({ session: session(payload) })));
  expect(onSaved).not.toHaveBeenCalled();
});

it("asks before leaving a dirty draft and respects cancellation", () => {
  const onBack = vi.fn();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<NotebookImportScreen clubId="club-a" players={players} onBack={onBack} />);
  change("Game label", "Draft");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(onBack).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(onBack).toHaveBeenCalledTimes(1);
});
