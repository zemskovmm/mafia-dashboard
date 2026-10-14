import type { FeatureMessages } from "../I18nProvider.js";
import type { Message } from "./types.js";

const englishVotingMessages = {
  ballotTools: "Ballot rules & review",
  ballotRulesLabel: "Rules",
  closeBallotTools: "Close ballot tools",
  liftVote: "Lift vote for #{seat}",
  liftYes: "Yes — eliminate all tied players",
  liftNo: "No — players stay",
  liftDraftGuidance:
    "Transcribe Yes or No explicitly. Unassigned votes are unknown, not No. These counts remain a draft until the judge accepts the result.",
  noGenericSkip:
    "Federation ballots cannot be skipped by host choice. Only named rule exceptions or disciplinary cancellation may bypass a required ballot.",
  disciplinaryCancellation:
    "A disciplinary removal cancels this day’s ballot under the rules. Proceed to night without a voted-out player or farewell speech.",
  nineThreeRestricted:
    "Three tied players with nine active: collective lift is unavailable until the third official night is completed AND at least two actual Sheriff checks have been performed. Proceed to night without elimination or farewell speeches.",
  zeroRoundFive:
    "Five players tied again on the zero round. No collective-lift ballot is held; proceed to night without elimination or farewell speeches.",
  closeDetermined: "Close determined result",
  determinedGuidance:
    "Outcome is determined. Unassigned votes remain uncast; closing does not assign them.",
  dispute: "Dispute count",
  disputeCandidate: "Disputed candidate",
  disputeReason: "Dispute reason",
  pauseReview: "Pause voting for review",
  pausedDispute: "Voting paused — technical dispute",
  pausedGuidance:
    "Calls, votes, corrections and resolution are frozen. Discipline remains available. Review the external recording, then enter the final count; this app cannot verify the recording.",
  reviewedVote: "Reviewed vote for #{seat}",
  externalReview: "I reviewed the external recording",
  rulingReason: "Final ruling reason",
  acceptRuling: "Accept final reviewed count",
  finalRuling:
    "Reviewed ruling is final for ordinary appeals. Clerical correction remains separate.",
  correction: "Correct transcription",
  correctionGuidance:
    "Judge-only clerical correction, not a second player vote. Accepted late or withdrawn hands remain counted unless a transcription error is corrected.",
  correctionVoter: "Voter to correct",
  correctedVote: "Corrected vote",
  correctionReason: "Correction reason",
  applyCorrection: "Apply transcription correction",
  unassigned: "Unassigned",
  nominationPrivate:
    "Judge-private nomination list. Do not disclose it in response to player requests.",
  panelLiveCall: "Live call: #{seat}",
  liveCall: "Live call",
  inspectedCandidate: "Inspecting #{seat}",
  orderedGuidance:
    "Announce the full order twice. Accept hands on the candidate number’s second mention, until the judge says STOP. Timing is advisory; the judge decides physical acceptance.",
  announceOrder: "Announce full order ({current}/2)",
  mentionCandidate: "Mention candidate #{seat} ({current}/2)",
  stopCandidate: "STOP — accept count",
  acceptanceOpen: "Acceptance open",
  countStopped: "Count accepted — STOP",
  waitingCall: "Waiting for ordered call",
  uncastVotes: "Unassigned votes: {count}",
  beginNight: "Begin night",
  candidate: "Candidate {current} of {total}",
  candidateLabel: "Voting candidate",
  carCrash: "Car crash",
  carCrashDecision: "Car-crash decision",
  carCrashResult: "Car-crash result",
  continue: "Continue",
  eliminateAllPlayers: "Eliminate all players voting",
  skipExplanation: "Rule-specific skip explanation",
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
  resolveVoting: "Finish voting",
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
  ballotTools: "Правила и проверка голосования",
  ballotRulesLabel: "Правила",
  closeBallotTools: "Закрыть инструменты голосования",
  liftVote: "Голос за коллективное удаление от №{seat}",
  liftYes: "Да — удалить всех игроков с равными голосами",
  liftNo: "Нет — игроки остаются",
  liftDraftGuidance:
    "Явно запишите «Да» или «Нет». Нераспределённые голоса неизвестны, а не означают «Нет». Подсчёт остаётся черновиком до принятия результата судьёй.",
  noGenericSkip:
    "Ведущий не может пропустить голосование по своему выбору. Обязательное голосование отменяется только по конкретному исключению правил или дисциплинарному основанию.",
  disciplinaryCancellation:
    "Дисциплинарное удаление отменяет голосование этого дня по правилам. Переходите к ночи без выбывшего по голосованию игрока и без прощальной речи.",
  nineThreeRestricted:
    "При девяти активных и трёх игроках с равным числом голосов коллективное удаление недоступно, пока не завершена третья официальная ночь И Шериф не выполнил минимум две реальные проверки. Переходите к ночи без удаления и прощальных речей.",
  zeroRoundFive:
    "На нулевом круге пять игроков повторно набрали равное число голосов. Голосование за коллективное удаление не проводится; переходите к ночи без удаления и прощальных речей.",
  closeDetermined: "Завершить определённый результат",
  determinedGuidance:
    "Исход определён. Нераспределённые голоса остаются неподанными; завершение не распределяет их.",
  dispute: "Оспорить подсчёт",
  disputeCandidate: "Кандидат спорного подсчёта",
  disputeReason: "Причина спора",
  pauseReview: "Приостановить голосование для просмотра",
  pausedDispute: "Голосование приостановлено — технический спор",
  pausedGuidance:
    "Вызовы, голоса, исправления и завершение заблокированы. Дисциплинарные меры доступны. Просмотрите внешнюю запись и введите окончательный подсчёт; приложение не может проверить запись.",
  reviewedVote: "Голос после просмотра за №{seat}",
  externalReview: "Я просмотрел внешнюю запись",
  rulingReason: "Основание окончательного решения",
  acceptRuling: "Принять окончательный подсчёт после просмотра",
  finalRuling:
    "Решение после просмотра окончательно для обычных апелляций. Исправление записи — отдельная процедура.",
  correction: "Исправить запись голосов",
  correctionGuidance:
    "Судейское исправление записи, не повторный голос игрока. Принятые поздние или отозванные руки сохраняются в подсчёте, если не исправляется ошибка записи.",
  correctionVoter: "Чей голос исправить",
  correctedVote: "Исправленный голос",
  correctionReason: "Причина исправления",
  applyCorrection: "Применить исправление записи",
  unassigned: "Не распределён",
  nominationPrivate:
    "Список выставленных — рабочая информация судьи. Не раскрывайте его по запросам игроков.",
  panelLiveCall: "Текущий вызов: №{seat}",
  liveCall: "Текущий вызов",
  inspectedCandidate: "Просмотр №{seat}",
  orderedGuidance:
    "Объявите полный порядок дважды. Принимайте руки при втором упоминании номера кандидата до команды судьи «СТОП». Время — лишь подсказка; принятие голосов определяет судья.",
  announceOrder: "Объявить полный порядок ({current}/2)",
  mentionCandidate: "Назвать кандидата №{seat} ({current}/2)",
  stopCandidate: "СТОП — принять подсчёт",
  acceptanceOpen: "Приём голосов открыт",
  countStopped: "Подсчёт принят — СТОП",
  waitingCall: "Ожидание вызова по порядку",
  uncastVotes: "Нераспределённые голоса: {count}",
  beginNight: "Начать ночь",
  candidate: "Кандидат {current} из {total}",
  candidateLabel: "Кандидат голосования",
  carCrash: "Автокатастрофа",
  carCrashDecision: "Решение по автокатастрофе",
  carCrashResult: "Результат автокатастрофы",
  continue: "Продолжить",
  eliminateAllPlayers: "Голосование за удаление всех игроков",
  skipExplanation: "Основание пропуска по правилам",
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
