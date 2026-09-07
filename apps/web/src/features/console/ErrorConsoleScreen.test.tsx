import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, checkServerReady } from "../../api/client.js";
import { clearErrorConsole, reportError } from "./error-console.js";
import { ErrorConsoleScreen } from "./ErrorConsoleScreen.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";

afterEach(() => {
  clearErrorConsole();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ErrorConsoleScreen", () => {
  it.each([
    [
      "en",
      "Replayed state does not match the recorded hash",
      "Submitted event #4",
      "Active replay position #2",
    ],
    [
      "ru",
      "Восстановленное состояние не совпадает с записанным хешем",
      "Событие в запросе №4",
      "Позиция в активной истории №2",
    ],
  ] as const)(
    "renders sanitized response diagnostics in %s",
    async (locale, explanation, submitted, replay) => {
      const canary = "PRIVATE-DIAGNOSTIC-CANARY";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: "validation_failed",
              issues: [
                {
                  path: ["state", "events", 3, "payload", canary],
                  message: canary,
                  diagnostic: {
                    code: "history.hash_mismatch",
                    eventIndex: 3,
                    replayIndex: 1,
                    payload: canary,
                    eventId: canary,
                    message: canary,
                  },
                },
              ],
            }),
            { status: 400 },
          ),
        ),
      );
      try {
        await checkServerReady();
      } catch (error) {
        reportError(error, { source: "persistence" });
      }
      render(
        <I18nProvider locale={locale}>
          <ErrorConsoleScreen onBack={vi.fn()} />
        </I18nProvider>,
      );
      const details = within(
        screen.getByRole("region", {
          name: locale === "en" ? "API error details" : "Подробности ошибки API",
        }),
      ).getByRole("listitem");
      expect(details).toHaveTextContent("history.hash_mismatch");
      expect(details).toHaveTextContent(explanation);
      expect(details).toHaveTextContent(submitted);
      expect(details).toHaveTextContent(replay);
      expect(document.body).not.toHaveTextContent(canary);
      expect(screen.getByText("HTTP 400 · validation_failed")).toBeInTheDocument();
    },
  );
  it("localizes its Russian chrome and dates without altering captured diagnostics", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T09:00:00.000Z"));
    const error = new Error("Raw failure: 42");
    error.stack = "raw-stack";
    reportError(error, { source: "api" });
    render(
      <I18nProvider locale="ru">
        <ErrorConsoleScreen onBack={vi.fn()} />
      </I18nProvider>,
    );

    expect(screen.getByRole("main", { name: "Консоль" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Консоль" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Назад" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Очистить консоль" })).toBeInTheDocument();
    const entry = screen.getByRole("article", { name: "Ошибка из api: Raw failure: 42" });
    expect(within(entry).getByText("Источник")).toBeInTheDocument();
    expect(within(entry).getByText("Контекст")).toBeInTheDocument();
    expect(within(entry).getByText("Не указан")).toBeInTheDocument();
    expect(within(entry).getByText("Raw failure: 42")).toBeInTheDocument();
    expect(within(entry).getByText("raw-stack")).toBeInTheDocument();
    expect(within(entry).getByLabelText("Стек вызовов")).toBeInTheDocument();
    expect(
      within(entry).getByText(
        new Intl.DateTimeFormat("ru", {
          dateStyle: "short",
          timeStyle: "short",
        }).format(new Date("2026-08-26T09:00:00.000Z")),
      ),
    ).toBeInTheDocument();
  });

  it("renders a semantic full-screen console with an empty state", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<ErrorConsoleScreen onBack={onBack} />);

    expect(screen.getByRole("main", { name: "Console" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Console" })).toBeInTheDocument();
    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear console" })).toBeInTheDocument();
    expect(screen.getByText("No errors have been captured.")).toBeInTheDocument();

    await user.click(back);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("renders newest entries first with every diagnostic field and accessible row labels", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T08:00:00.000Z"));
    const older = new Error("Older failure");
    older.stack = "older-stack";
    reportError(older, { source: "api", context: "Loading players" });

    vi.setSystemTime(new Date("2026-08-26T09:00:00.000Z"));
    const newer = new Error("Newer failure");
    newer.stack = "newer-stack";
    reportError(newer, { source: "persistence" });

    render(<ErrorConsoleScreen onBack={vi.fn()} />);

    const rows = screen.getAllByRole("article");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName("Error from persistence: Newer failure");
    expect(rows[1]).toHaveAccessibleName("Error from api: Older failure");

    const newestRow = within(rows[0]!);
    expect(newestRow.getByText("persistence")).toBeInTheDocument();
    expect(newestRow.getByText("None")).toBeInTheDocument();
    expect(newestRow.getByText("Newer failure")).toBeInTheDocument();
    expect(newestRow.getByText("newer-stack")).toBeInTheDocument();
    expect(rows[0]?.querySelector("time")).toHaveAttribute("datetime", "2026-08-26T09:00:00.000Z");

    const olderRow = within(rows[1]!);
    expect(olderRow.getByText("api")).toBeInTheDocument();
    expect(olderRow.getByText("Loading players")).toBeInTheDocument();
    expect(olderRow.getByText("Older failure")).toBeInTheDocument();
    expect(olderRow.getByText("older-stack")).toBeInTheDocument();
  });

  it("renders safe API status, code, and validation diagnostics", () => {
    const secretEventPayload = "must-not-render-secret-event-payload";
    reportError(
      new ApiError("Unable to save the game session operation", 400, "validation_failed", {
        issues: [
          {
            path: "state.game.voteAssignments",
            message: "The final voting candidate must receive every remaining active vote",
          },
          {
            path: "state.game.events[0].payload",
            message: secretEventPayload,
          },
        ],
        request: { state: { events: [{ payload: secretEventPayload }] } },
      }),
      { source: "persistence" },
    );
    render(<ErrorConsoleScreen onBack={vi.fn()} />);

    const entry = screen.getByRole("article", {
      name: "Error from persistence: Unable to save the game session operation",
    });
    expect(within(entry).getByText("HTTP 400 · validation_failed")).toBeInTheDocument();
    expect(within(entry).getByText("state.game.voteAssignments")).toBeInTheDocument();
    expect(within(entry).getByRole("listitem")).toHaveTextContent(
      "The final voting candidate must receive every remaining active vote",
    );
    expect(within(entry).queryByText(secretEventPayload)).not.toBeInTheDocument();
  });

  it("clears the external store and updates to the empty state", async () => {
    const user = userEvent.setup();
    reportError(new Error("Remove me"));
    render(<ErrorConsoleScreen onBack={vi.fn()} />);
    expect(screen.getByRole("article", { name: /Remove me/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear console" }));

    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.getByText("No errors have been captured.")).toBeInTheDocument();
  });
});
