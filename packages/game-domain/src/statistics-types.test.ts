import { expectTypeOf, it } from "vitest";
import type {
  ClubStatisticsResponse,
  PlayerStatisticsRow,
  StatisticsFilters,
  StatisticsGame,
  StatisticsHistoryGame,
  StatisticsParticipant,
  StatisticsTotals,
  UnratedReason,
} from "./statistics-types.js";

it("represents independently unknown participant observations", () => {
  expectTypeOf<StatisticsParticipant["playerId"]>().toEqualTypeOf<string>();
  expectTypeOf<StatisticsParticipant["seat"]>().toEqualTypeOf<number | null>();
  expectTypeOf<StatisticsParticipant["fouls"]>().toEqualTypeOf<number | null>();
  expectTypeOf<StatisticsParticipant["role"]>().extract<null>().toEqualTypeOf<null>();
  expectTypeOf<StatisticsParticipant["team"]>().extract<null>().toEqualTypeOf<null>();
  expectTypeOf<StatisticsParticipant["status"]>().extract<null>().toEqualTypeOf<null>();
});

it("does not expose a rules engine in factual records, filters or rating reasons", () => {
  expectTypeOf<StatisticsGame>().not.toHaveProperty("rulesEdition");
  expectTypeOf<StatisticsHistoryGame>().not.toHaveProperty("rulesEdition");
  expectTypeOf<StatisticsFilters>().not.toHaveProperty("edition");
  expectTypeOf<Extract<UnratedReason, "legacy-edition">>().toEqualTypeOf<never>();
});

it("distinguishes unknown roster facts from known absence of Casper", () => {
  expectTypeOf<StatisticsGame["hasCasper"]>().toEqualTypeOf<boolean | null>();
  expectTypeOf<StatisticsGame["rosterComplete"]>().toEqualTypeOf<boolean | null>();
});

it("exposes the actual observation counts for partial metrics", () => {
  expectTypeOf<StatisticsTotals["outcomeGames"]>().toEqualTypeOf<number>();
  expectTypeOf<PlayerStatisticsRow["foulGames"]>().toEqualTypeOf<number>();
  expectTypeOf<PlayerStatisticsRow["statusGames"]>().toEqualTypeOf<number>();
  expectTypeOf<ClubStatisticsResponse["coverage"]["partialGames"]>().toEqualTypeOf<number>();
});

it("keeps undated or unknown-outcome history independent of available timelines", () => {
  expectTypeOf<StatisticsHistoryGame["playedAt"]>().toEqualTypeOf<string | null>();
  expectTypeOf<StatisticsHistoryGame["outcome"]>().extract<null>().toEqualTypeOf<null>();
  expectTypeOf<StatisticsHistoryGame["hasCasper"]>().toEqualTypeOf<boolean | null>();
  expectTypeOf<StatisticsHistoryGame["timelineAvailable"]>().toEqualTypeOf<boolean>();
  expectTypeOf<StatisticsGame["timelineAvailable"]>().toEqualTypeOf<boolean>();
});
