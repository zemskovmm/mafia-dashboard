import { describe, expect, it } from "vitest";
import type { ReplayFrame } from "@mafia/game-domain";
import { timelineConsoleMessages } from "../../i18n/messages/timeline-console.js";
import { createSampleGameHistory } from "./sample-game-data.js";
import {
  buildTimeline as buildTimelineModel,
  englishTimelineText,
  type TimelineText,
} from "./timeline-model.js";
import { namedProfiles } from "../../test-player-directory.js";

const profiles = namedProfiles("sample-player-");
const withNames = (text: TimelineText = englishTimelineText): TimelineText => ({
  ...text,
  playerName: (id) => profiles.find((profile) => profile.id === id)?.nickname,
});
const buildTimeline = (frames: Parameters<typeof buildTimelineModel>[0], text?: TimelineText) =>
  buildTimelineModel(frames, withNames(text));

const russianTimelineText = {
  t: (key: string, values: Readonly<Record<string, string | number>> = {}) => {
    const message = timelineConsoleMessages.ru[key as keyof typeof timelineConsoleMessages.ru] as
      string | (Readonly<Record<string, string>> & { readonly other: string });
    const template =
      typeof message === "string"
        ? message
        : (message[new Intl.PluralRules("ru").select(Number(values.count ?? 0))] ?? message.other);
    return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, name: string) =>
      values[name] === undefined ? token : String(values[name]),
    );
  },
  formatList: (values: readonly string[]) =>
    new Intl.ListFormat("ru", { type: "conjunction" }).format(values),
  formatTime: (value: Date | string) =>
    new Intl.DateTimeFormat("ru", { timeStyle: "medium" }).format(
      value instanceof Date ? value : new Date(value),
    ),
};

describe("replay-frame timeline model", () => {
  it("derives contiguous color regions from replayed before and after states", () => {
    const { frames } = createSampleGameHistory();
    const timeline = buildTimeline(frames);

    expect(timeline.regions.map(({ label }) => label)).toEqual([
      "Night 1 · Mafia planning",
      "Zero round",
      "Voting · zero round",
      "Night 2",
      "Day 1",
      "Voting 1",
      "Night 3",
      "Day 2",
    ]);
    expect(timeline.regions.every(({ color }) => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
    expect(timeline.regions.every(({ frameCount }) => frameCount > 0)).toBe(true);
  });

  it("keeps an accepted Best Move finalized prefix in its actual shooting-night region", () => {
    const bestMove = createSampleGameHistory().frames.find(
      ({ entry }) => entry.type === "best-move.finalized",
    )!;

    const timeline = buildTimeline([bestMove]);

    expect(timeline.regions[0]).toMatchObject({ id: "night-1", label: "Night 2", day: 1 });
    expect(timeline.markers[0]).toMatchObject({
      eventType: "best-move.finalized",
      regionId: "night-1",
    });
  });

  it("projects semantic events into labelled, accessible markers", () => {
    const timeline = buildTimeline(createSampleGameHistory().frames);
    const markerFor = (eventType: string) =>
      timeline.markers.find((marker) => marker.eventType === eventType);

    expect(markerFor("player.nominated")).toMatchObject({
      kind: "nomination",
      label: "Player 7 set for voting",
      ariaLabel: "Nomination: Player 1 set Player 7 for voting",
    });
    expect(markerFor("voting.resolved")?.ariaLabel).toContain("Player 7 eliminated");
    expect(markerFor("don.checked")?.ariaLabel).toBe("Don checked Player 1: Sheriff");
    expect(markerFor("sheriff.checked")?.ariaLabel).toBe("Sheriff checked Player 10: Mafia");
    expect(
      timeline.markers
        .filter(({ eventType }) => eventType === "foul.issued")
        .map(({ kind }) => kind),
    ).toEqual(["foul", "foul", "foul"]);
    expect(markerFor("discipline.foul-issued")?.kind).toBe("discipline");
    expect(markerFor("discipline.removals-announced")?.kind).toBe("red-card");
    expect(timeline.markers.some(({ eventType }) => eventType === "turn.completed")).toBe(false);
    expect(
      timeline.markers.some(
        ({ eventType, label }) =>
          eventType === "phase.changed" &&
          ["Phase: night don", "Phase: night sheriff", "Phase: best move"].includes(label),
      ),
    ).toBe(false);
    expect(
      timeline.markers.find(
        ({ eventType, label }) => eventType === "phase.changed" && label === "Night",
      ),
    ).toBeDefined();
    expect(markerFor("best-move.finalized")?.regionId).toBe("night-1");
    expect(markerFor("game.completed")).toMatchObject({
      kind: "completion",
      icon: "trophy",
      ariaLabel: "Game completed: Red team won",
      regionId: null,
    });
    expect(
      timeline.markers.every(({ label, ariaLabel }) => label.length > 0 && ariaLabel.length > 0),
    ).toBe(true);
  });

  it.each([
    ["game.drawn", "draw", "Game drawn", "Game drawn: Three quiet cycles"],
    ["game.cancelled", "cancelled", "Game cancelled", "Game cancelled: Venue closed"],
  ] as const)("labels the %s terminal event and its reason", (type, phase, label, ariaLabel) => {
    const completion = createSampleGameHistory().frames.at(-1)!;
    const reason = type === "game.drawn" ? "Three quiet cycles" : "Venue closed";
    const terminal = {
      ...completion,
      entry: {
        ...completion.entry,
        type,
        payload: { reason },
        phaseAfter: phase,
      },
      after: { ...completion.after, phase, winner: null },
    } as ReplayFrame;

    expect(buildTimeline([terminal]).markers[0]).toMatchObject({
      kind: "completion",
      label,
      ariaLabel,
      regionId: null,
    });
  });

  it("groups every accepted Mafia resolution into one marker with all shooter-target pairs", () => {
    const timeline = buildTimeline(createSampleGameHistory().frames);
    const shotMarkers = timeline.markers.filter(
      ({ eventType }) => eventType === "mafia.shots-resolved",
    );

    expect(shotMarkers).toHaveLength(2);
    expect(shotMarkers[0]).toMatchObject({
      kind: "mafia-shots",
      icon: "crosshair",
      label: "Mafia kill: Player 2",
      result: "kill",
      shots: [
        { shooterSeat: 8, targetSeat: 2, shooterLabel: "Player 8", targetLabel: "Player 2" },
        { shooterSeat: 9, targetSeat: 2, shooterLabel: "Player 9", targetLabel: "Player 2" },
        { shooterSeat: 10, targetSeat: 2, shooterLabel: "Player 10", targetLabel: "Player 2" },
      ],
    });
    expect(shotMarkers[0]?.ariaLabel).toContain(
      "Player 8 to Player 2; Player 9 to Player 2; Player 10 to Player 2",
    );
    expect(shotMarkers[1]).toMatchObject({
      kind: "mafia-shots",
      label: "Mafia miss",
      result: "miss",
    });
    expect(shotMarkers[1]?.shots).toHaveLength(2);
  });

  it("cannot include later checkpoints outside the supplied retained prefix", () => {
    const history = createSampleGameHistory();
    const cutoff = history.frames.findIndex(({ entry }) => entry.type === "don.checked") + 1;
    const laterEntries = history.frames.slice(cutoff);
    const prefix = history.frames.slice(0, cutoff);
    const timeline = buildTimeline(prefix);

    expect(laterEntries.length).toBeGreaterThan(0);
    expect(timeline.markers.length).toBeLessThanOrEqual(prefix.length);
    expect(
      timeline.markers.some(({ eventId }) =>
        laterEntries.some(({ entry }) => entry.id === eventId),
      ),
    ).toBe(false);
  });

  it("falls back to an anonymous label when a profile is unavailable, without changing replay frames", () => {
    const nomination = createSampleGameHistory().frames.find(
      ({ entry }) => entry.type === "player.nominated",
    )!;
    const missingProfile: TimelineText = {
      ...withNames(),
      playerName: (id) => (id === "sample-player-7" ? undefined : withNames().playerName?.(id)),
    };

    expect(buildTimelineModel([nomination], missingProfile).markers[0]).toMatchObject({
      label: "Anonymous player set for voting",
      ariaLabel: "Nomination: Player 1 set Anonymous player for voting",
    });
    expect(nomination.before.players[6]).not.toHaveProperty("name");
  });

  it("uses a generic accessible marker instead of throwing for a malformed payload", () => {
    const nomination = createSampleGameHistory().frames.find(
      ({ entry }) => entry.type === "player.nominated",
    )!;
    const malformedFrame = {
      ...nomination,
      entry: { ...nomination.entry, payload: { nominatorSeat: 1, candidateSeat: "bad" } },
    } as unknown as ReplayFrame;

    expect(() => buildTimeline([malformedFrame])).not.toThrow();
    expect(buildTimeline([malformedFrame]).markers[0]).toMatchObject({
      kind: "generic",
      label: "Player nominated",
      ariaLabel: "Player nominated",
    });
  });

  it("projects cancellation, car-crash, skipped-check, and Best move events", () => {
    const base = createSampleGameHistory().frames[0]!;
    const marker = (type: string, payload: unknown) => {
      const frame = { ...base, entry: { ...base.entry, type, payload } } as unknown as ReplayFrame;
      return buildTimeline([frame]).markers[0];
    };

    expect(marker("voting.legally-skipped", { reason: "no-nominees" })).toMatchObject({
      kind: "voting-cancelled",
      label: "Voting skipped: no nominees",
    });
    expect(
      marker("car-crash.resolved", {
        votes: { 1: true, 2: true },
        result: { eliminate: true, seats: [4, 6], yesVotes: 6, eligibleVoters: 10 },
      }),
    ).toMatchObject({
      kind: "car-crash-result",
      label: "Car crash: Player 4 and Player 6 eliminated",
    });
    expect(marker("don.check-skipped", {})).toMatchObject({
      kind: "check-skipped",
      ariaLabel: "Don check skipped",
    });
    expect(marker("sheriff.check-skipped", {})).toMatchObject({
      kind: "check-skipped",
      ariaLabel: "Sheriff check skipped",
    });
    expect(
      buildTimeline(createSampleGameHistory().frames).markers.find(
        ({ eventType }) => eventType === "best-move.finalized",
      ),
    ).toMatchObject({
      kind: "best-move",
      ariaLabel: expect.stringContaining("Best Move by Player 2: Player 8 and Player 9"),
    });
  });

  it("localizes regions and every semantic marker projection through its injected formatter", () => {
    const history = createSampleGameHistory();
    const timeline = buildTimeline(history.frames, russianTimelineText);
    const markerFor = (eventType: string) =>
      timeline.markers.find((marker) => marker.eventType === eventType);
    const base = history.frames[0]!;
    const marker = (type: string, payload: unknown) =>
      buildTimeline(
        [{ ...base, entry: { ...base.entry, type, payload } } as unknown as ReplayFrame],
        russianTimelineText,
      ).markers[0]!;

    expect(timeline.regions.map(({ label }) => label)).toEqual([
      "Ночь 1 · договорка мафии",
      "Нулевой круг",
      "Голосование · нулевой круг",
      "Ночь 2",
      "День 1",
      "Голосование 1",
      "Ночь 3",
      "День 2",
    ]);
    expect(markerFor("player.nominated")).toMatchObject({
      label: "Player 7 выставлен на голосование",
      ariaLabel: "Номинация: Player 1 выставил Player 7 на голосование",
    });
    expect(markerFor("voting.resolved")?.ariaLabel).toContain(
      "Результат голосования: Player 7 выбывает из игры",
    );
    expect(markerFor("voting.legally-skipped")?.label).toContain("дисциплинарное удаление");
    expect(markerFor("mafia.shots-resolved")).toMatchObject({
      label: "Мафия убивает: Player 2",
      ariaLabel: expect.stringContaining("Выстрелы мафии:"),
    });
    expect(markerFor("don.checked")?.ariaLabel).toBe("Дон проверил Player 1: Шериф");
    expect(markerFor("sheriff.checked")?.ariaLabel).toBe("Шериф проверил Player 10: Мафия");
    expect(markerFor("discipline.foul-issued")?.ariaLabel).toContain("Четвёртый фол");
    expect(markerFor("discipline.removals-announced")?.ariaLabel).toContain("Объявлено удаление");
    expect(markerFor("best-move.finalized")?.ariaLabel).toContain("Лучший ход");
    expect(markerFor("game.completed")).toMatchObject({
      label: "Красные победили",
      ariaLabel: "Игра завершена: Красные победили",
    });
    expect(
      marker("car-crash.resolved", {
        result: { eliminate: false, seats: [4, 6] },
      }),
    ).toMatchObject({
      label: "Автокатастрофа: Player 4 и Player 6 остаются в игре",
    });
    expect(marker("don.check-skipped", {})).toMatchObject({ label: "Проверка Дона пропущена" });
    expect(marker("sheriff.check-skipped", {})).toMatchObject({
      label: "Проверка Шерифа пропущена",
    });
    expect(markerFor("best-move.finalized")?.ariaLabel).toContain("Player 8 и Player 9");
  });
});
