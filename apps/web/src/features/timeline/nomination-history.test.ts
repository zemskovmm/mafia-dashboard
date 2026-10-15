import { describe, expect, it } from "vitest";
import {
  createGameLogEntry,
  createInitialGameBaseline,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type GameState,
} from "@mafia/game-domain";
import { timelineConsoleMessages } from "../../i18n/messages/timeline-console.js";
import type { Message } from "../../i18n/messages/types.js";
import { createFederationSampleGameHistory, createSampleGameHistory } from "./sample-game-data.js";
import {
  buildPublicTimeline,
  buildTimeline,
  englishTimelineText,
  type TimelineText,
} from "./timeline-model.js";

const selection = (
  nominatorSeat: number,
  candidateSeat: number,
  selected = true,
): CanonicalGameEventDraft => ({
  type: "nomination.selection-set",
  payload: { nominatorSeat, candidateSeat, selected },
});

const history = (federation: boolean, drafts: readonly CanonicalGameEventDraft[]) => {
  const initial = (
    federation ? createFederationSampleGameHistory() : createSampleGameHistory()
  ).frames.find(({ entry }) => entry.type === "player.nominated")!.before;
  let game: GameState = initial;
  const entries: GameLogEntry[] = [];
  for (const draft of [{ type: "game.checkpointed", payload: {} } as const, ...drafts]) {
    const accepted = createGameLogEntry({
      gameId: "history-selections",
      id: `selection-${entries.length + 1}`,
      sequence: entries.length + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: "2026-10-15T16:00:00Z",
      before: game,
      draft,
    });
    entries.push(accepted.entry);
    game = accepted.after;
  }
  const baseline = createInitialGameBaseline(initial);
  const replay = replayGameLog(
    JSON.parse(JSON.stringify(baseline)),
    JSON.parse(JSON.stringify(entries)),
  );
  return { ...replay, entries, baseline };
};

const localized = (locale: "en" | "ru"): TimelineText => ({
  ...englishTimelineText,
  playerName: (id) => `Player ${id.split("-").at(-1)}`,
  t: (key, values = {}) => {
    const message: Message = timelineConsoleMessages[locale][key];
    const template =
      typeof message === "string"
        ? message
        : (message[new Intl.PluralRules(locale).select(Number(values.count ?? 0))] ??
          message.other);
    return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, name: string) =>
      values[name] === undefined ? token : String(values[name]),
    );
  },
  formatList: (values) => new Intl.ListFormat(locale, { type: "conjunction" }).format(values),
});

const corrections = [
  selection(1, 7),
  { type: "foul.issued", payload: { seat: 10, foulNumber: 1, redCarded: false } },
  selection(1, 7, false),
  selection(1, 7),
  selection(2, 7),
  selection(2, 8),
  selection(3, 7),
  selection(3, 8),
  selection(3, 9),
  selection(3, 9, false),
  selection(3, 9),
  selection(3, 7, false),
  selection(3, 7),
  selection(3, 7, false),
] as const satisfies readonly CanonicalGameEventDraft[];

describe.each([false, true])("surviving nomination history (federation=%s)", (federation) => {
  it.each(["en", "ru"] as const)(
    "collapses toggles into one attributed round checkpoint in %s without changing canonical facts",
    (locale) => {
      const replay = history(federation, corrections);
      const bytes = JSON.stringify(replay);
      const timeline = buildTimeline(replay.frames, localized(locale));
      const nominations = timeline.markers.filter(({ kind }) => kind === "nomination");
      expect(nominations).toHaveLength(1);
      const summary = nominations[0]!;
      expect(summary.label).toBe(
        locale === "en" ? "Nomination selections: 3 candidates" : "Выставления: 3 кандидата",
      );
      expect(summary.ariaLabel).toContain(
        locale === "en"
          ? "#7 Player 7 — nominated by #1 Player 1"
          : "#7 Player 7 — выставил #1 Player 1",
      );
      expect(summary.ariaLabel).toContain(
        locale === "en"
          ? "Additional supporters (+1): #2 Player 2"
          : "Дополнительно поддержали (+1): #2 Player 2",
      );
      expect(summary.ariaLabel).toContain(
        locale === "en"
          ? "#8 Player 8 — nominated by #2 Player 2"
          : "#8 Player 8 — выставил #2 Player 2",
      );
      expect(summary.ariaLabel).toContain(
        locale === "en"
          ? "Additional supporters (+1): #3 Player 3"
          : "Дополнительно поддержали (+1): #3 Player 3",
      );
      expect(summary.ariaLabel).toContain(
        locale === "en"
          ? "#9 Player 9 — nominated by #3 Player 3"
          : "#9 Player 9 — выставил #3 Player 3",
      );
      expect(summary.ariaLabel).not.toMatch(/vote|голос/i);
      expect(summary.eventId).toBe(replay.entries.at(-1)!.id);
      expect(timeline.frames[summary.frameIndex]!.replayFrame).toBe(replay.frames.at(-1));
      expect(timeline.markers.filter(({ kind }) => kind === "foul")).toHaveLength(1);
      expect(replay.game.players.find(({ seat }) => seat === 10)?.fouls).toBe(1);
      expect(replay.game.voteAssignments).toEqual({});
      expect(JSON.stringify(replay)).toBe(bytes);
      expect(replayGameLog(replay.baseline, replay.entries).game).toEqual(replay.game);
    },
  );

  it("keeps an empty corrected checkpoint instead of a false nomination or an on/off stream", () => {
    const replay = history(federation, [
      selection(1, 7),
      selection(1, 7, false),
      selection(1, 8),
      selection(1, 8, false),
    ]);
    const timeline = buildTimeline(replay.frames, localized("en"));
    expect(timeline.markers.filter(({ kind }) => kind === "nomination")).toEqual([]);
    expect(timeline.markers).toHaveLength(2);
    expect(timeline.markers.at(-1)).toMatchObject({
      eventId: replay.entries.at(-1)!.id,
      kind: "generic",
      label: "No nomination selections",
    });
    expect(replay.entries).toHaveLength(5);
  });

  it("uses only the supplied prefix for preview and retains past-round attribution after rollover", () => {
    const replay = history(federation, [
      selection(1, 7),
      selection(2, 7),
      { type: "phase.changed", payload: { to: "night-mafia" } },
      { type: "mafia.shots-resolved", payload: { shots: [], result: { kind: "miss" } } },
      { type: "don.check-skipped", payload: {} },
      { type: "sheriff.check-skipped", payload: {} },
      { type: "phase.changed", payload: { to: "day" } },
      selection(2, 6),
    ]);
    const prefix = buildTimeline(replay.frames.slice(0, 2), localized("en"));
    expect(prefix.markers.at(-1)?.label).toBe("Nomination selections: 1 candidate");
    expect(prefix.markers.at(-1)?.ariaLabel).not.toContain("Additional supporters");
    const summaries = buildTimeline(replay.frames, localized("en")).markers.filter(
      ({ kind }) => kind === "nomination",
    );
    expect(summaries.map(({ label }) => label)).toEqual([
      "Nomination selections: 1 candidate",
      "Nomination selections: 1 candidate",
    ]);
    expect(summaries[0]?.ariaLabel).toContain("Additional supporters (+1): #2 Player 2");
    expect(summaries[0]?.ariaLabel).toContain("#7 Player 7");
    expect(summaries[1]?.ariaLabel).toContain("#6 Player 6");
    expect(summaries[1]?.ariaLabel).not.toContain("Additional supporters");
  });

  it("does not disclose secret attribution through public markers or public event descriptions", () => {
    const replay = history(federation, corrections);
    const publicTimeline = buildPublicTimeline(replay.frames, localized("en"));
    expect(publicTimeline).not.toHaveProperty("frames");
    expect(
      publicTimeline.markers.some(({ eventType }) => eventType === "nomination.selection-set"),
    ).toBe(false);
    expect(JSON.stringify(publicTimeline)).not.toMatch(
      /supporter|nominator|nomination.selection-set|Nomination selections|#7 Player 7/,
    );
  });

  it("preserves legacy public nomination facts without disclosing secret support carried by later public snapshots", () => {
    const replay = history(federation, [
      { type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: 7 } },
      selection(2, 7),
      { type: "player.nominated", payload: { nominatorSeat: 2, candidateSeat: 8 } },
    ]);
    const privateSummary = buildTimeline(replay.frames, localized("en")).markers.at(-1)!;
    expect(privateSummary.label).toBe("Nomination selections: 2 candidates");
    expect(privateSummary.ariaLabel).toContain("Additional supporters (+1): #2 Player 2");
    const publicTimeline = buildPublicTimeline(replay.frames, localized("en"));
    expect(publicTimeline.markers.filter(({ kind }) => kind === "nomination")).toHaveLength(2);
    expect(publicTimeline.markers.at(-1)?.ariaLabel).toBe(
      "Nomination: Player 2 set Player 8 for voting",
    );
    expect(JSON.stringify(publicTimeline)).not.toMatch(/supporter|nominator|Nomination selections/);
  });

  it("resolves renamed or retired contributors at display time without mutating history or exposing roles", () => {
    const replay = history(federation, [selection(1, 7), selection(2, 7)]);
    const bytes = JSON.stringify(replay);
    const text = localized("en");
    const summary = buildTimeline(replay.frames, {
      ...text,
      playerName: (id) =>
        id.endsWith("-2")
          ? undefined
          : id.endsWith("-1")
            ? "Renamed host-visible profile"
            : text.playerName?.(id),
    }).markers.at(-1)!;
    expect(summary.ariaLabel).toContain("nominated by #1 Renamed host-visible profile");
    expect(summary.ariaLabel).toContain("Additional supporters (+1): #2 Anonymous player");
    expect(summary.ariaLabel).not.toMatch(/citizen|sheriff|mafia|don/i);
    expect(JSON.stringify(replay)).toBe(bytes);
  });

  it("collapses compatible old nomination facts with newly recorded supports without inventing old support", () => {
    const replay = history(federation, [
      { type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: 7 } },
      selection(2, 7),
      selection(2, 7, false),
    ]);
    const timeline = buildTimeline(replay.frames, localized("en"));
    expect(timeline.markers.filter(({ kind }) => kind === "nomination")).toHaveLength(1);
    expect(timeline.markers.at(-1)?.ariaLabel).toContain("#7 Player 7 — nominated by #1 Player 1");
    expect(timeline.markers.at(-1)?.ariaLabel).not.toContain("Additional supporters");
    expect(replay.game.nominations[0]).not.toHaveProperty("supporterSeats");
  });
});
