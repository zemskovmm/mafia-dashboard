import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  beginNight,
  createGameLogEntry,
  createInitialGameBaseline,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameLogEntry,
} from "@mafia/game-domain";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { timelineConsoleMessages } from "../../i18n/messages/timeline-console.js";
import type { Message } from "../../i18n/messages/types.js";
import { namedProfiles } from "../../test-player-directory.js";
import { PlayerDirectoryProvider } from "../players/player-display.js";
import { GameScreen } from "../game/GameScreen.js";
import { GameTimelineScreen } from "./GameTimelineScreen.js";
import { createSampleGameHistory } from "./sample-game-data.js";
import {
  buildPublicTimeline,
  buildTimeline,
  englishTimelineText,
  type TimelineText,
} from "./timeline-model.js";

const reasons = [
  { reason: "voted-out", en: "voted out", ru: "выбыл по голосованию" },
  { reason: "mafia-kill", en: "killed by Mafia", ru: "убит мафией" },
  { reason: "other", en: "other reason", ru: "другая причина" },
] as const;
const history = (reason: (typeof reasons)[number]["reason"], night = false) => {
  const day = createSampleGameHistory().frames.find(({ after }) => after.phase === "day")!.after;
  const initial = night ? beginNight(day) : day;
  const seat = initial.players.find((player) => player.role === "citizen")!.seat;
  const entries: GameLogEntry[] = [];
  let game = initial;
  const drafts: readonly CanonicalGameEventDraft[] = [
    { type: "game.checkpointed", payload: {} },
    { type: "player.manually-removed", payload: { seat, reason } },
  ];
  for (const draft of drafts) {
    const next = createGameLogEntry({
      gameId: "manual-history",
      id: `manual-${entries.length + 1}`,
      sequence: entries.length + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: "2026-11-12T12:00:00.000Z",
      before: game,
      draft,
    });
    entries.push(next.entry);
    game = next.after;
  }
  return { ...replayGameLog(createInitialGameBaseline(initial), entries), seat };
};
const localized = (locale: "en" | "ru"): TimelineText => ({
  ...englishTimelineText,
  playerName: (id) => `Player ${id.split("-").at(-1)}`,
  t: (key, values = {}) => {
    const message: Message = timelineConsoleMessages[locale][key];
    const template = typeof message === "string" ? message : message.other;
    return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key: string) =>
      String(values[key] ?? `{${key}}`),
    );
  },
});

describe.each(["en", "ru"] as const)("manual-removal history in %s", (locale) => {
  it.each(reasons)(
    "names the player and human $reason in public markers and inspector",
    ({ reason, ...labels }) => {
      const h = history(reason);
      const bytes = JSON.stringify(h);
      const text = localized(locale);
      const model = buildTimeline(h.frames, text);
      const marker = model.markers.at(-1)!;
      const label =
        locale === "en"
          ? `Player ${h.seat} manually removed: ${labels.en}`
          : `Игрок Player ${h.seat} удалён вручную: ${labels.ru}`;
      expect(marker).toMatchObject({
        kind: "manual-removal",
        icon: "circle",
        label,
        ariaLabel: label,
      });
      expect(marker.shots).toBeUndefined();
      expect(marker.result).toBeUndefined();
      expect(buildPublicTimeline(h.frames, text).markers.at(-1)).toMatchObject({
        eventId: marker.eventId,
        kind: marker.kind,
        icon: marker.icon,
        label,
        ariaLabel: label,
      });
      expect(
        buildTimeline(h.frames.slice(0, -1), text).markers.some(
          ({ kind }) => kind === "manual-removal",
        ),
      ).toBe(false);
      expect(buildTimeline(JSON.parse(bytes).frames, text)).toEqual(model);
      expect(JSON.stringify(h)).toBe(bytes);

      const onPreviewCurrentEvent = vi.fn();
      render(
        <I18nProvider locale={locale}>
          <GameTimelineScreen
            clubId="club"
            players={namedProfiles("sample-player-")}
            loaders={{ listCompleted: async () => [], getSession: vi.fn() }}
            onBack={vi.fn()}
            currentHistory={{
              label: "Manual history",
              frames: h.frames,
              headEventId: marker.eventId,
            }}
            onPreviewCurrentEvent={onPreviewCurrentEvent}
            onResetCurrentEvent={vi.fn()}
          />
        </I18nProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: label }));
      const inspector = within(
        screen.getByRole("complementary", {
          name: locale === "en" ? "Selected event details" : "Детали выбранного события",
        }),
      );
      expect(inspector.getByRole("heading", { name: label })).toBeInTheDocument();
      fireEvent.click(
        inspector.getByRole("button", {
          name: locale === "en" ? "Preview timeline checkpoint" : "Предпросмотр контрольной точки",
        }),
      );
      expect(onPreviewCurrentEvent).toHaveBeenCalledExactlyOnceWith(marker.eventId);
      expect(screen.queryByText("player.manually-removed")).toBeNull();
    },
  );

  it.each(reasons)(
    "renders $reason as a cause-neutral Ledger elimination with a reason under privacy",
    ({ reason, ...labels }) => {
      const h = history(reason);
      const change = vi.fn();
      const accepted = vi.fn();
      render(
        <I18nProvider locale={locale}>
          <PlayerDirectoryProvider profiles={namedProfiles("sample-player-")}>
            <GameScreen
              game={h.game}
              historyFrames={h.frames}
              hostView="ledger"
              mode="preview"
              hostName="Host"
              privacyHidden
              onGameChange={change}
              onEvent={vi.fn()}
              onAcceptedEvent={accepted}
            />
          </PlayerDirectoryProvider>
        </I18nProvider>,
      );
      const row = document.querySelector(`[data-ledger-seat="${h.seat}"]`)!;
      const label =
        locale === "en"
          ? `Eliminated · manually recorded: ${labels.en}`
          : `Выбыл · записано вручную: ${labels.ru}`;
      expect(within(row as HTMLElement).getAllByText(label).length).toBeGreaterThan(0);
      expect(row.textContent).toContain(`Player ${h.seat}`);
      expect(row.textContent).not.toMatch(
        /Citizen|Sheriff|Don|Мирный|Шериф|Дон|Foul|Фол|discipline|нарушени/,
      );
      expect(row.querySelector('[data-ledger-period="night"]')?.textContent).toBe("");
      expect(change).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled();
      expect(row.querySelector(".is-provisional")).toBeNull();
    },
  );
});
