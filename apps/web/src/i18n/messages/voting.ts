import type { FeatureMessages } from "../I18nProvider.js";
import type { Message } from "./types.js";

const englishVotingMessages = {
  beginNight: "Begin night",
  candidate: "Candidate {current} of {total}",
  candidateLabel: "Voting candidate",
  carCrash: "Car crash",
  carCrashDecision: "Car-crash decision",
  carCrashResult: "Car-crash result",
  continue: "Continue",
  eliminateAllPlayers: "Eliminate all players voting",
  eliminateAllSkipped: "Eliminate-all vote skipped",
  eliminateVotes: "{yesVotes} of {eligibleVoters} eliminate votes",
  eliminated: "Eliminated",
  foul: "Foul",
  foulLabel: "Foul {name}",
  host: "Host",
  hostSkipped: "Voting was skipped by the host.",
  nextCandidate: "Next candidate",
  noCandidate: "No candidate",
  playersStay: "Players stay",
  redCardCancelled: "A player received a red card, so voting is cancelled for this day.",
  removeAllVote: "Remove {name}'s eliminate-all vote",
  resolveCarCrash: "Resolve car crash",
  resolveVoting: "Resolve voting",
  seat: "Seat {seat}",
  seatWithName: "Seat {seat}: {name}",
  skipMessage:
    "All active players are tied. Eliminating everyone would leave no way to determine a winner.",
  skipVoting: "Skip voting",
  voteAs: "Vote as {voter} for {candidate}",
  voteAsEliminateAll: "Vote as {name} to eliminate all car-crash players",
  votedForSeat: "{name} voted for seat {seat}",
  votes: {
    one: "{count} vote",
    other: "{count} votes",
  },
  voting: "Voting",
  votingCancelled: "Voting cancelled",
} as const satisfies Record<string, Message>;

export type VotingMessageKey = keyof typeof englishVotingMessages;

const russianVotingMessages = {
  beginNight: "Начать ночь",
  candidate: "Кандидат {current} из {total}",
  candidateLabel: "Кандидат голосования",
  carCrash: "Автокатастрофа",
  carCrashDecision: "Решение по автокатастрофе",
  carCrashResult: "Результат автокатастрофы",
  continue: "Продолжить",
  eliminateAllPlayers: "Голосование за удаление всех игроков",
  eliminateAllSkipped: "Голосование за удаление всех пропущено",
  eliminateVotes: "За удаление: {yesVotes} из {eligibleVoters}",
  eliminated: "Удалены",
  foul: "Фол",
  foulLabel: "Фол: {name}",
  host: "Ведущий",
  hostSkipped: "Ведущий пропустил голосование.",
  nextCandidate: "Следующий кандидат",
  noCandidate: "Нет кандидата",
  playersStay: "Игроки остаются в игре",
  redCardCancelled: "Игрок получил красную карту, поэтому голосование в этот день отменено.",
  removeAllVote: "Снять голос {name} за удаление всех",
  resolveCarCrash: "Завершить автокатастрофу",
  resolveVoting: "Завершить голосование",
  seat: "Место {seat}",
  seatWithName: "Место {seat}: {name}",
  skipMessage:
    "Все активные игроки набрали одинаковое число голосов. Удаление всех не позволит определить победителя.",
  skipVoting: "Пропустить голосование",
  voteAs: "Проголосовать игроком {voter} за {candidate}",
  voteAsEliminateAll: "Проголосовать игроком {name} за удаление всех участников автокатастрофы",
  votedForSeat: "{name} проголосовал за место {seat}",
  votes: {
    one: "{count} голос",
    few: "{count} голоса",
    many: "{count} голосов",
    other: "{count} голоса",
  },
  voting: "Голосование",
  votingCancelled: "Голосование отменено",
} as const satisfies Record<VotingMessageKey, Message>;

export const votingMessages = {
  en: englishVotingMessages,
  ru: russianVotingMessages,
} as const satisfies FeatureMessages<VotingMessageKey>;
