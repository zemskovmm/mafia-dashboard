import { describe, expect, it } from "vitest";
import type { RemoteGameSession } from "../../api/client.js";
import { completedRecordFacts } from "./completed-record.js";

const session = (
  results: Record<string, unknown> | null,
  state: Record<string, unknown> = {},
): RemoteGameSession => ({
  gameId: "game",
  name: "Recorded",
  status: "completed",
  revision: 1,
  duplicate: false,
  updatedAt: "2026-10-16T12:00:00Z",
  state,
  results,
});

describe("read-only completed factual projection", () => {
  it("does not infer results, dates, host or a complete roster from record storage metadata", () => {
    expect(completedRecordFacts(session({}), null)).toMatchObject({
      outcome: null,
      winner: null,
      playedAt: null,
      hostPlayerId: null,
      day: null,
      participants: null,
    });
  });
  it("does not derive a team from an observed role or fill unknown observations with zero", () => {
    expect(
      completedRecordFacts(session({ players: [{ playerId: "known", role: "sheriff" }] }), null)
        .participants,
    ).toEqual([
      {
        playerId: "known",
        seat: null,
        role: "sheriff",
        team: null,
        status: null,
        fouls: null,
        bestMoveHits: null,
      },
    ]);
  });
  it("retains independent results and zeros despite invalid optional peer observations", () => {
    expect(
      completedRecordFacts(
        session({
          outcome: "red",
          playedAt: "not a time",
          players: [
            {
              playerId: "known",
              seat: 0,
              role: "old-role",
              team: "black",
              fouls: 0,
              bestMoveHits: 0,
              status: "old-status",
            },
          ],
        }),
        null,
      ),
    ).toMatchObject({
      outcome: "red",
      playedAt: null,
      participants: [
        {
          playerId: "known",
          seat: null,
          role: null,
          team: "black",
          fouls: 0,
          bestMoveHits: 0,
          status: null,
        },
      ],
    });
  });
  it.each(["2026-02-30T12:00:00Z", "2026-08-24", "2026-08-24T18:00:00", "not a date"])(
    "does not turn an invalid/unobserved played time into an invented date: %s",
    (playedAt) => {
      expect(completedRecordFacts(session({ playedAt }), null).playedAt).toBeNull();
    },
  );
  it("retains observed offset date, non-result explanation and partial adjudication without mutating records", () => {
    const original = session({
      playedAt: "2026-08-24T18:00:00+02:00",
      reason: "Recorded explanation",
      adjudication: { reason: "Independent referee note", committeeApproved: false },
    });
    const bytes = JSON.stringify(original);
    expect(completedRecordFacts(original, null)).toMatchObject({
      playedAt: "2026-08-24T18:00:00+02:00",
      outcome: null,
      reason: "Recorded explanation",
      adjudication: {
        losingTeam: null,
        offenderSeat: null,
        rule: null,
        reason: "Independent referee note",
        committeeApproved: false,
      },
    });
    expect(JSON.stringify(original)).toBe(bytes);
  });
  it.each(["finished", "draw", "cancelled"])(
    "retains a stored Best Move hit observation only for its known owner in terminal phase %s",
    (phase) => {
      const original = session(null, {
        game: {
          phase,
          players: [{ id: "owner", seat: 2 }, { id: "other", seat: 4 }, { id: "unknown-seat" }],
          bestMove: { playerSeat: 2, mafiaHits: 2 },
        },
      });
      expect(
        completedRecordFacts(original, null).participants?.map(({ bestMoveHits }) => bestMoveHits),
      ).toEqual([2, null, null]);
    },
  );

  it.each([
    ["opaque-A", "opaque-A"],
    ["a0000000-0000-4000-8000-000000000001", "A0000000-0000-4000-8000-000000000001"],
  ])(
    "fills only absent result observations for matching completed identities %s / %s",
    (savedId, resultId) => {
      const original = session(
        { players: [{ playerId: resultId }] },
        {
          game: {
            phase: "finished",
            players: [
              {
                id: savedId,
                seat: 1,
                role: "sheriff",
                team: "red",
                status: "eliminated",
                fouls: 2,
              },
              { id: "not-in-results", seat: 2, role: "mafia" },
            ],
            bestMove: { playerSeat: 1, mafiaHits: 2 },
          },
        },
      );
      const before = JSON.stringify(original);
      expect(completedRecordFacts(original, null).participants).toEqual([
        {
          playerId: resultId,
          seat: 1,
          role: "sheriff",
          team: "red",
          status: "eliminated",
          fouls: 2,
          bestMoveHits: 2,
        },
      ]);
      expect(JSON.stringify(original)).toBe(before);
    },
  );

  it("does not join differently cased opaque identities or revive an explicitly replaced roster", () => {
    const state = {
      game: { phase: "finished", players: [{ id: "opaque-A", seat: 1, role: "sheriff" }] },
    };
    expect(
      completedRecordFacts(session({ players: [{ playerId: "opaque-a" }] }, state), null)
        .participants,
    ).toEqual([
      {
        playerId: "opaque-a",
        seat: null,
        role: null,
        team: null,
        status: null,
        fouls: null,
        bestMoveHits: null,
      },
    ]);
    expect(completedRecordFacts(session({ players: [] }, state), null).participants).toEqual([]);
    expect(completedRecordFacts(session({ players: null }, state), null).participants).toBeNull();
  });

  it("preserves explicit corrections, zeroes and unknowns instead of falling back to older snapshot facts", () => {
    const original = session(
      {
        winner: null,
        hostPlayerId: null,
        players: [
          {
            playerId: "known",
            role: "don",
            team: null,
            status: null,
            fouls: 0,
            bestMoveHits: null,
          },
        ],
      },
      {
        hostPlayerId: "old-host",
        game: {
          phase: "finished",
          winner: "red",
          players: [
            { id: "known", seat: 1, role: "sheriff", team: "red", status: "eliminated", fouls: 2 },
          ],
          bestMove: { playerSeat: 1, mafiaHits: 2 },
        },
      },
    );
    expect(completedRecordFacts(original, null)).toMatchObject({
      winner: null,
      hostPlayerId: null,
      participants: [
        {
          playerId: "known",
          seat: 1,
          role: "don",
          team: null,
          status: null,
          fouls: 0,
          bestMoveHits: null,
        },
      ],
    });
  });

  it("does not expose active-record observations through the completed facts reader", () => {
    const active = {
      ...session(
        { players: [{ playerId: "known", role: "don" }] },
        { game: { winner: "black", players: [{ id: "known", role: "don" }] } },
      ),
      status: "active" as const,
    };
    expect(completedRecordFacts(active, null)).toMatchObject({ winner: null, participants: null });
  });

  it("retains actual completed snapshot participant observations when no result roster was recorded", () => {
    expect(
      completedRecordFacts(
        session(null, {
          hostPlayerId: "host",
          game: {
            phase: "finished",
            day: 2,
            players: [{ id: "observed", seat: 6, fouls: 2, role: "citizen", status: "active" }],
          },
        }),
        null,
      ),
    ).toMatchObject({
      hostPlayerId: "host",
      day: 2,
      participants: [
        {
          playerId: "observed",
          seat: 6,
          fouls: 2,
          role: "citizen",
          team: null,
          status: "active",
          bestMoveHits: null,
        },
      ],
      outcome: null,
    });
  });
});
