import { describe, expect, it } from "vitest";
import {
  createGameLogEntry,
  isSecretGameEventType,
  type CanonicalGameEventDraft,
  type GameState,
  type ReplayFrame,
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

const text: TimelineText = {
  ...englishTimelineText,
  playerName: (id) => `Player ${id.split("-").at(-1)}`,
};
const russian: TimelineText = {
  ...text,
  t: (key, values = {}) => {
    const message: Message = timelineConsoleMessages.ru[key];
    const template =
      typeof message === "string"
        ? message
        : (message[new Intl.PluralRules("ru").select(Number(values.count ?? 0))] ?? message.other);
    return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, key: string) =>
      values[key] === undefined ? token : String(values[key]),
    );
  },
  formatList: (values) => new Intl.ListFormat("ru", { type: "conjunction" }).format(values),
};
const replayFrames = (
  initial: GameState,
  drafts: readonly CanonicalGameEventDraft[],
): readonly ReplayFrame[] => {
  let game = initial;
  return drafts.map((draft, index) => {
    const before = game;
    const { entry, after } = createGameLogEntry({
      gameId: "federation-timeline-test",
      id: `f${index + 1}`,
      sequence: index + 1,
      parentEventId: index === 0 ? null : `f${index}`,
      createdAt: "2026-10-14T10:00:00Z",
      before,
      draft,
    });
    game = after;
    return { entry, before, after };
  });
};

describe("federation timeline projections", () => {
  it.each([
    ["discipline.foul-issued", { removal: null }],
    [
      "discipline.removal-observed",
      { seat: 9, stage: "constructor", rule: "6.2.3", reason: "MALFORMED_PRIVATE_VALUE" },
    ],
    ["voting.legally-skipped", { reason: "constructor" }],
    ["best-move.finalized", { reason: "__proto__", readbackAcknowledged: true }],
  ])("fails safely to a generic marker for malformed %s presentation data", (type, payload) => {
    const base = createFederationSampleGameHistory().frames.find(
      ({ entry }) => entry.type === "best-move.finalized",
    )!;
    const frame = { ...base, entry: { ...base.entry, type, payload } } as unknown as ReplayFrame;
    const marker = buildTimeline([frame], text).markers[0]!;
    expect(marker.kind).toBe("generic");
    expect(marker.ariaLabel).not.toContain("MALFORMED_PRIVATE_VALUE");
  });
  it.each([
    ["all-active", "all active players tied"],
    [
      "nine-three-restricted",
      "three tied players at a nine-player table without both required night/check conditions",
    ],
    ["zero-round-five", "five-way tie in the zero round"],
  ])(
    "explains a prohibited collective lift with basis %s rather than a generic tie",
    (skipReason, basis) => {
      const base = createFederationSampleGameHistory().frames.find(
        ({ entry }) => entry.type === "voting.resolved",
      )!;
      // Presentation contract: reducer legality for each restriction is covered in the domain suite.
      const frame = {
        ...base,
        entry: {
          ...base.entry,
          payload: {
            voteAssignments: {},
            result: {
              kind: "eliminate-all-skipped",
              seats: [1, 2, 3],
              totals: { 1: 3, 2: 3, 3: 3 },
              skipReason,
            },
          },
        },
      } as ReplayFrame;
      expect(buildTimeline([frame], text).markers[0]).toMatchObject({
        kind: "voting-result",
        label: `Collective lift prohibited: ${basis}`,
        result: "eliminate-all-skipped",
      });
      expect(buildTimeline([frame], text).markers[0]?.ariaLabel).toContain(
        "Player 1, Player 2, Player 3",
      );
    },
  );

  it("localizes every newly visible federation setup phase in Russian", () => {
    const markers = buildTimeline(createFederationSampleGameHistory().frames, russian).markers;
    for (const label of [
      "Фаза: мафия засыпает",
      "Фаза: знакомство дона в маске",
      "Фаза: знакомство шерифа в маске",
      "Фаза: свободная рассадка",
    ])
      expect(markers.some((marker) => marker.label === label)).toBe(true);
  });
  it.each([createSampleGameHistory, createFederationSampleGameHistory])(
    "projects only canonical public markers, never snapshots or private observations",
    (create) => {
      const history = create();
      const retainedBytes = JSON.stringify(history);
      const unknown = {
        ...history.frames[0]!,
        entry: {
          ...history.frames[0]!.entry,
          id: "unknown-private-entry",
          type: "future.private-observation",
          payload: { reason: "UNKNOWN_SECRET" },
        },
      } as unknown as ReplayFrame;
      const publicTimeline = buildPublicTimeline([...history.frames, unknown], text);
      expect(publicTimeline).not.toHaveProperty("frames");
      expect(
        publicTimeline.markers.every(({ eventType }) => !isSecretGameEventType(eventType)),
      ).toBe(true);
      expect(publicTimeline.markers.length).toBeLessThan(
        buildTimeline(history.frames, text).markers.length,
      );
      const serialized = JSON.stringify(publicTimeline);
      for (const privateValue of [
        "mafiaHits",
        "shotAssignments",
        "disciplinaryRemovals",
        "checkResult",
        "replayFrame",
        "readback acknowledged",
        "Obvious spoken slip",
        "Referee observed prohibited interaction",
        "Final reviewed count",
        "UNKNOWN_SECRET",
      ])
        expect(serialized).not.toContain(privateValue);
      expect(JSON.stringify(history)).toBe(retainedBytes);
      expect(
        buildTimeline(history.frames, text).markers.some(({ eventType }) =>
          isSecretGameEventType(eventType),
        ),
      ).toBe(true);
      if (history.baseline.replayVersion === 2) {
        expect(
          publicTimeline.markers.find(
            ({ eventType }) => eventType === "discipline.removals-announced",
          )?.ariaLabel,
        ).toBe("Removal announced: Player 9");
        expect(
          publicTimeline.markers.find(({ eventType }) => eventType === "game.adjudicated")?.label,
        ).toBe("Adjudicated win: red team");
      }
    },
  );
  it("separates private removal occurrence and public announcement, including reasoned fourth fouls", () => {
    const history = createFederationSampleGameHistory();
    const timeline = buildTimeline(history.frames, text);
    const removal = timeline.markers.find(
      ({ eventType }) => eventType === "discipline.removal-observed",
    )!;
    expect(removal).toMatchObject({
      kind: "discipline",
      label: "Removal recorded for Player 9 during day discussion",
    });
    expect(removal.ariaLabel).toContain("Rule 6.2.3");
    expect(removal.ariaLabel).toContain("Referee observed prohibited interaction");
    expect(removal.ariaLabel).toContain("departure: departed; announcement: pending");
    const announcement = timeline.markers.find(
      ({ eventType }) => eventType === "discipline.removals-announced",
    )!;
    expect(announcement).toMatchObject({ kind: "red-card", label: "Removal announced: Player 9" });
    expect(announcement.ariaLabel).not.toContain("6.2.3");
    expect(announcement.ariaLabel).not.toContain("Referee observed");
    const frames = replayFrames(
      history.frames.find(({ entry }) => entry.type === "discipline.removal-observed")!.before,
      [
        ...[1, 2, 3].map(
          (foulNumber) =>
            ({ type: "foul.issued", payload: { seat: 9, foulNumber, redCarded: false } }) as const,
        ),
        {
          type: "discipline.foul-issued",
          payload: {
            seat: 9,
            foulNumber: 4,
            redCarded: true,
            removal: {
              seat: 9,
              stage: "day-discussion",
              rule: "6.2.1",
              reason: "Fourth foul",
              checkInProgress: false,
            },
          },
        },
      ],
    );
    const foul = buildTimeline(frames, text).markers.at(-1)!;
    expect(foul).toMatchObject({
      kind: "discipline",
      label: "Fourth Foul: Player 9; removal recorded during day discussion",
    });
    expect(foul.ariaLabel).toContain("Rule 6.2.1");
    expect(
      timeline.markers.find(({ eventType }) => eventType === "mafia.multiple-shot-observed"),
    ).toMatchObject({ kind: "mafia-shots", label: "Actual multiple shot observed: Player 8" });
  });

  it("explains adjudication instead of presenting it as an ordinary elimination win", () => {
    const history = createFederationSampleGameHistory();
    const timeline = buildTimeline(history.frames, text);
    const adjudication = timeline.markers.find(
      ({ eventType }) => eventType === "game.adjudicated",
    )!;
    expect(adjudication).toMatchObject({
      kind: "completion",
      regionId: null,
      label: "Adjudicated win: red team",
    });
    expect(adjudication.ariaLabel).toContain("losing team: black team");
    expect(adjudication.ariaLabel).toContain("offender: Player 10");
    expect(adjudication.ariaLabel).toContain("Rule 6.3.5");
    expect(adjudication.ariaLabel).toContain("committee approved");
    expect(timeline.markers.at(-1)?.ariaLabel).toBe(adjudication.ariaLabel);
    expect(buildTimeline(history.frames, russian).markers.at(-1)?.label).toBe(
      "Победа по судейскому решению: красная команда",
    );
    expect(history.game.players.find(({ seat }) => seat === 10)?.status).toBe("active");
  });

  it("shows the rule-derived automatic draw and official federation round/night labels", () => {
    const history = createFederationSampleGameHistory("rules-draw");
    const timeline = buildTimeline(history.frames, text);
    const marker = timeline.markers.at(-1)!;
    expect(marker).toMatchObject({
      kind: "completion",
      regionId: null,
      label: "Rules draw · 6.5.6",
    });
    expect(marker.ariaLabel).toBe(
      "Automatic draw under rule 6.5.6: 3 consecutive game nights with no change to table composition; 3 game nights completed",
    );
    expect(timeline.regions.map(({ label }) => label)).toEqual([
      "Night 1 · Mafia planning",
      "Zero round",
      "Night 2",
      "Day 1",
      "Night 3",
    ]);
    expect(buildTimeline(history.frames, russian).markers.at(-1)?.label).toBe(
      "Ничья по правилам · 6.5.6",
    );
    const voting = buildTimeline(createFederationSampleGameHistory().frames, text).regions.find(
      ({ kind }) => kind === "voting",
    );
    expect(voting?.label).toBe("Voting · zero round");
  });
  it("distinguishes ordered calls, private inspection, accepted votes, clerical corrections and reviewed disputes", () => {
    const timeline = buildTimeline(createFederationSampleGameHistory().frames, text);
    const labels = (type: string) =>
      timeline.markers.filter(({ eventType }) => eventType === type).map(({ label }) => label);
    expect(labels("voting.order-announced")).toEqual([
      "Voting order announced 1/2: Player 7 and Player 6",
      "Voting order announced 2/2: Player 7 and Player 6",
    ]);
    expect(labels("voting.candidate-mentioned")).toEqual([
      "Live call 1/2: Player 7",
      "Live call 2/2: Player 7",
      "Live call 1/2: Player 6",
      "Live call 2/2: Player 6",
    ]);
    expect(labels("voting.candidate-inspected")).toEqual([
      "Candidate inspected: Player 6; live call remains Player 7",
    ]);
    expect(labels("vote.accepted")[0]).toBe("Vote accepted: Player 1 → Player 7");
    expect(labels("vote.corrected")).toEqual([
      "Vote correction: Player 1 unassigned",
      "Vote correction: Player 1 → Player 7",
    ]);
    expect(labels("voting.candidate-stopped")).toEqual(["STOP: Player 7", "STOP: Player 6"]);
    expect(labels("voting.live-advanced")).toEqual(["Next live candidate: Player 6"]);
    const dispute = timeline.markers.find(
      ({ eventType }) => eventType === "voting.count-disputed",
    )!;
    expect(dispute).toMatchObject({
      kind: "voting-dispute",
      label: "Voting paused: count disputed for Player 7",
    });
    expect(dispute.ariaLabel).toContain("Missed hand");
    const ruling = timeline.markers.find(({ eventType }) => eventType === "voting.count-ruled")!;
    expect(ruling.label).toBe("Final count for Player 7 after acknowledged external review");
    expect(ruling.ariaLabel).toContain("Player 7: 1 vote");
    expect(ruling.ariaLabel).toContain("Final reviewed count");
    expect(labels("voting.legally-skipped")).toEqual(["Voting cancelled: disciplinary removal"]);
    expect(
      timeline.markers
        .filter(({ eventType }) => eventType.startsWith("voting.") || eventType.startsWith("vote."))
        .every(({ kind }) => kind !== "generic"),
    ).toBe(true);
    const translated = buildTimeline(createFederationSampleGameHistory().frames, russian);
    expect(
      translated.markers.find(({ eventType }) => eventType === "voting.count-disputed")?.label,
    ).toBe("Голосование приостановлено: оспорен счёт Player 7");
    expect(
      translated.markers.find(({ eventType }) => eventType === "voting.count-ruled")?.label,
    ).toBe("Окончательный счёт Player 7 после подтверждённого внешнего просмотра");
  });

  it.each([
    ["no-nominees", "no nominees"],
    ["zero-round-sole-nominee", "sole nominee in the zero round"],
    ["all-active", "all active players tied"],
    [
      "nine-three-restricted",
      "three tied players at a nine-player table without both required night/check conditions",
    ],
    ["zero-round-five", "five-way tie in the zero round"],
  ])("explains a legal skip with basis %s", (reason, explanation) => {
    const base = createFederationSampleGameHistory().frames.find(
      ({ entry }) => entry.type === "voting.legally-skipped",
    )!;
    const frame = { ...base, entry: { ...base.entry, payload: { reason } } } as ReplayFrame;
    expect(buildTimeline([frame], text).markers[0]).toMatchObject({
      kind: "voting-cancelled",
      label: `Voting skipped: ${explanation}`,
    });
  });
  it("renders the accepted Best Move transcript and obvious-slip correction in spoken order before morning", () => {
    const frames = createFederationSampleGameHistory().frames;
    const bestMove = buildTimeline(frames, text).markers.filter(({ eventType }) =>
      eventType.startsWith("best-move."),
    );
    expect(bestMove.map(({ label }) => label)).toEqual([
      "Best Move number 1 accepted: Player 8",
      "Best Move number 2 accepted: Player 8",
      "Best Move slip corrected at number 2: Player 8 → Player 9",
      "Best Move finished early: Player 8 and Player 9",
    ]);
    expect(
      bestMove.every(({ kind, regionId }) => kind === "best-move" && regionId === "night-1"),
    ).toBe(true);
    expect(bestMove[2]?.ariaLabel).toContain("Obvious spoken slip");
    expect(bestMove[3]?.ariaLabel).toBe(
      "Best Move by Player 2: Player 8 and Player 9; 2 Mafia hits; finished early; readback acknowledged",
    );
    expect(
      buildTimeline(frames, russian).markers.find(
        ({ eventType }) => eventType === "best-move.finalized",
      )?.ariaLabel,
    ).toBe(
      "Лучший ход Player 2: Player 8 и Player 9; 2 попадания в мафию; завершён досрочно; принятые номера зачитаны и подтверждены",
    );
  });

  it.each([
    ["declined", [], "declined"],
    ["finished-early", [8], "finished early"],
    ["time-expired", [8, 8], "time expired"],
    ["interrupted", [8, 8], "interrupted"],
    ["complete-list", [8, 9, 2], "complete list"],
  ] as const)("keeps the exact %s prefix in its finalized checkpoint", (reason, seats, ending) => {
    const initial = createFederationSampleGameHistory().frames.find(
      ({ entry }) => entry.type === "best-move.number-accepted",
    )!.before;
    const frames = replayFrames(initial, [
      ...seats.map((seat) => ({ type: "best-move.number-accepted", payload: { seat } }) as const),
      { type: "best-move.finalized", payload: { reason, readbackAcknowledged: true } },
    ]);
    const marker = buildTimeline(frames, text).markers.at(-1)!;
    expect(marker.kind).toBe("best-move");
    expect(marker.ariaLabel).toContain(ending);
    expect(marker.ariaLabel).toContain(
      seats.length === 0
        ? "no accepted numbers"
        : text.formatList(seats.map((seat) => `Player ${seat}`)),
    );
    expect(marker.ariaLabel).toContain(
      `${new Set(seats.filter((seat) => seat >= 8)).size} Mafia hit`,
    );
    expect(frames.at(-1)?.after.bestMove?.selectedSeats).toEqual(seats);
  });
});
