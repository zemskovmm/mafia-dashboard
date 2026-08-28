import { describe, expect, it } from "vitest";
import type { ReplayFrame } from "@mafia/game-domain";
import { timelineConsoleMessages } from "../../i18n/messages/timeline-console.js";
import { createSampleGameHistory } from "./sample-game-data.js";
import { buildTimeline } from "./timeline-model.js";

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
      "Initial night",
      "Day 1",
      "Voting 1",
      "Night 1",
      "Day 2",
      "Voting 2",
      "Night 2",
    ]);
    expect(timeline.regions.every(({ color }) => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
    expect(timeline.regions.every(({ frameCount }) => frameCount > 0)).toBe(true);
  });

  it("keeps a later-night Best move completion in that night's numbered region", () => {
    const bestMove = createSampleGameHistory().frames.find(
      ({ entry }) => entry.type === "best-move.completed",
    )!;
    const nightTwoBestMove: ReplayFrame = {
      ...bestMove,
      before: { ...bestMove.before, day: 2 },
      after: { ...bestMove.after, day: 3 },
    };

    const timeline = buildTimeline([nightTwoBestMove]);

    expect(timeline.regions[0]).toMatchObject({ id: "night-2", label: "Night 2", day: 2 });
    expect(timeline.markers[0]).toMatchObject({
      eventType: "best-move.completed",
      regionId: "night-2",
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
    ).toEqual(["foul", "foul", "foul", "red-card"]);
    expect(markerFor("player.red-carded")?.kind).toBe("red-card");
    expect(timeline.markers.some(({ eventType }) => eventType === "turn.completed")).toBe(false);
    expect(
      timeline.markers.some(
        ({ eventType, label }) =>
          eventType === "phase.changed" &&
          [
            "Phase: sheriff wake",
            "Phase: night don",
            "Phase: night sheriff",
            "Phase: best move",
          ].includes(label),
      ),
    ).toBe(false);
    expect(
      timeline.markers.find(
        ({ eventType, label }) => eventType === "phase.changed" && label === "Night",
      ),
    ).toBeDefined();
    expect(markerFor("best-move.completed")?.regionId).toBe("night-1");
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

  it("cannot include inactive branches because its input is the active replay-frame list", () => {
    const history = createSampleGameHistory();
    const activeIds = new Set(history.frames.map(({ entry }) => entry.id));
    const inactiveEntry = history.entries.find(({ id }) => !activeIds.has(id));
    const timeline = buildTimeline(history.frames);

    expect(inactiveEntry).toBeDefined();
    expect(timeline.markers).toHaveLength(history.frames.length);
    expect(timeline.markers.some(({ eventId }) => eventId === inactiveEntry?.id)).toBe(false);
  });

  it("falls back to seat labels when a replay frame has a blank player name", () => {
    const nomination = createSampleGameHistory().frames.find(
      ({ entry }) => entry.type === "player.nominated",
    )!;
    const blankSeatSevenName = (players: ReplayFrame["after"]["players"]) =>
      players.map((player) => (player.seat === 7 ? { ...player, name: "   " } : player));
    const namelessFrame: ReplayFrame = {
      ...nomination,
      before: { ...nomination.before, players: blankSeatSevenName(nomination.before.players) },
      after: { ...nomination.after, players: blankSeatSevenName(nomination.after.players) },
    };

    expect(buildTimeline([namelessFrame]).markers[0]).toMatchObject({
      label: "Seat 7 set for voting",
      ariaLabel: "Nomination: Player 1 set Seat 7 for voting",
    });
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

    expect(marker("voting.skipped", { reason: "host-skipped" })).toMatchObject({
      kind: "voting-cancelled",
      label: "Voting skipped",
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
      marker("best-move.completed", {
        playerSeat: 2,
        selectedSeats: [8, 9, 3],
        mafiaHits: 2,
      }),
    ).toMatchObject({
      kind: "best-move",
      ariaLabel: "Best move by Player 2: Player 8, Player 9, Player 3; 2 Mafia hits",
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
      "Нулевая ночь",
      "День 1",
      "Голосование 1",
      "Ночь 1",
      "День 2",
      "Голосование 2",
      "Ночь 2",
    ]);
    expect(markerFor("player.nominated")).toMatchObject({
      label: "Player 7 выставлен на голосование",
      ariaLabel: "Номинация: Player 1 выставил Player 7 на голосование",
    });
    expect(markerFor("voting.resolved")?.ariaLabel).toContain(
      "Результат голосования: Player 7 выбывает из игры",
    );
    expect(markerFor("voting.skipped")).toMatchObject({
      label: "Голосование пропущено",
      ariaLabel: "Ведущий пропустил голосование",
    });
    expect(markerFor("mafia.shots-resolved")).toMatchObject({
      label: "Мафия убивает: Player 2",
      ariaLabel: expect.stringContaining("Выстрелы мафии:"),
    });
    expect(markerFor("don.checked")?.ariaLabel).toBe("Дон проверил Player 1: Шериф");
    expect(markerFor("sheriff.checked")?.ariaLabel).toBe("Шериф проверил Player 10: Мафия");
    expect(
      timeline.markers.filter(({ eventType }) => eventType === "foul.issued").at(-1)?.label,
    ).toContain("получил красную карточку");
    expect(markerFor("player.red-carded")?.ariaLabel).toBe("Красная карточка: Player 8");
    expect(markerFor("best-move.completed")?.ariaLabel).toContain("Лучший ход");
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
    expect(
      marker("best-move.completed", {
        playerSeat: 2,
        selectedSeats: [8, 9, 3],
        mafiaHits: 2,
      }).ariaLabel,
    ).toBe("Лучший ход Player 2: Player 8, Player 9 и Player 3; 2 попадания в мафию");
  });
});
