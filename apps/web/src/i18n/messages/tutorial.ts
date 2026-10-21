import type { FeatureMessages } from "../I18nProvider.js";

const en = {
  back: "Back",
  next: "Next",
  done: "Done",
  close: "Close tutorial",
  progress: "Step {current} of {total}",
  swipe: "Swipe left or right to explore",
  harmless: "Just a guide — game, timer and music stay unchanged.",
  unavailable:
    "Instructional example — the live control is unavailable or outside the visible area.",
  exampleCard: "Example: player card",
  exampleAction: "Example: advance control",
  exampleNominee: "Example: voting-order entry",
  exampleShot: "Example: shooter control",
  exampleCorrection: "Example: Yes / No / Unassigned",
  exampleObservation: "Example: observation mode",
  dayHelp: "Day table help",
  dayTitle: "Day table tutorial",
  votingHelp: "Voting help",
  votingTitle: "Voting tutorial",
  nightHelp: "Night help",
  nightTitle: "Night tutorial",
  dayTapTitle: "Tap to nominate or support",
  dayTapBody:
    "During the current speaker’s turn, tap an active player to nominate them or support an existing nominee. Retap removes only this speaker’s own selection. One new nomination per speaker; supports are independent.",
  dayTapUnavailable:
    "There is no eligible current speaker. Nomination taps are unavailable until the live turn permits them.",
  foulTitle: "Swipe down for a foul",
  foulBody:
    "Swipe a live eligible player card downward to issue one foul. A fourth foul opens the discipline flow. This gesture does not also nominate or vote.",
  foulUnavailable:
    "Fouls are unavailable in the current state. This is an example of the downward gesture, not an active control.",
  penaltyTitle: "Swipe up for discipline",
  penaltyBody:
    "Swipe a player card upward to open that player’s discipline menu. Opening or dismissing the menu applies nothing; a decision requires explicit confirmation.",
  penaltyUnavailable:
    "Discipline is unavailable in the current state. No penalty can be applied from this guide.",
  advanceTitle: "Advance the live table",
  advanceBody:
    "After the current turn, use “{action}” when enabled. The last speaker’s action follows this day’s nominations and may begin voting or night. The tutorial never advances the turn.",
  nomineeTitle: "Choose the current nominee",
  nomineeBody:
    "Select the current nominee in the Voting order panel beside the table. This sets the recipient of voter-card taps; the tutorial never changes the selection. If the panel is collapsed, use this example without opening it.",
  voteTitle: "Record or correct votes",
  voteBody:
    "Tap an eligible voter card to record, clear or reassign its vote for the selected candidate. These taps correct the host’s transcription, not a participant’s physical vote. Reviewed or disabled entries cannot be changed here.",
  candidateTitle: "Follow nomination order",
  candidateBody:
    "Next candidate follows nomination order. Deliberately selecting the last candidate assigns remaining votes. Merely reading this guide never selects a candidate or refills a cleared vote.",
  finishTitle: "Finish voting explicitly",
  finishBody:
    "Use Finish voting only when enabled: the ballot must be fully recorded or mathematically conclusive. Next candidate is not completion. A disabled action must wait for the permitted count or review.",
  disputeTitle: "Voting is paused for external review",
  disputeBody:
    "Candidate progression and completion are suspended during a technical dispute. The judge must review the external recording and accept the final ruling through the ballot review tools. This guide cannot resolve the dispute.",
  tieTitle: "Tie speeches",
  tieBody:
    "The current tied candidate has a 30-second speech. Use “{action}” after the speech; the final speech leads to the restricted revote. The timer remains under your control.",
  collectiveTitle: "Record the collective count",
  collectiveBody:
    "Tap an eligible voter card to toggle Yes or No for eliminating the tied group. Only more than half of eligible voters can approve elimination. Disabled controls do not accept votes.",
  correctionTitle: "Correct Yes, No or Unassigned",
  correctionBody:
    "The collapsed correction tools contain a separate Yes / No / Unassigned choice for each voter. Use Unassigned to clear a transcription. Reading this example does not open the tools or change votes.",
  collectiveFinishTitle: "Complete the physical count",
  collectiveFinishBody:
    "Use the enabled count-completion button after the physical count, even with zero supporting hands. Untouched voters remain unobserved; the tutorial does not manufacture No votes or complete the count.",
  cancelledTitle: "Voting is cancelled",
  cancelledBody:
    "Read the visible cancellation status. There is no ordinary ballot to transcribe here. Use the enabled continuation to begin night when the host is ready.",
  skippedTitle: "The collective ballot is skipped",
  skippedBody:
    "Read the on-screen reason for skipping this collective ballot. Do not record a lift here. The enabled continuation proceeds to night.",
  ballotResultTitle: "Read the accepted ballot result",
  ballotResultBody:
    "The table shows the accepted collective result. Review it, then use the enabled continuation. This is a result screen, not an open ballot.",
  planningTitle: "Mafia agreement",
  planningBody:
    "Give Mafia 60 seconds to agree on target order. Confirm Mafia is asleep with the table’s advance button when ready. This opening prompt does not record shooting targets.",
  sleepTitle: "Confirm Mafia is asleep",
  sleepBody:
    "Follow the current opening prompt, then use the table’s advance button to begin the separate Sheriff greeting. Nothing advances automatically.",
  openingTitle: "Continue the opening",
  openingBody:
    "This restored opening step remains explicitly continuable. Follow its visible prompt and use the enabled advance button; this is not an ordinary-night check.",
  greetingTitle: "Sheriff greeting",
  greetingBody:
    "Wake the Sheriff for ten seconds to look around the table and greet the host, then choose Begin round zero. This is a greeting, not a target check or a recorded result.",
  zeroTitle: "Begin round zero",
  zeroBody:
    "Follow the visible opening prompt and choose Begin round zero when ready. The tutorial does not change seating or begin a turn.",
  shotsTitle: "Transcribe Mafia shots",
  shotsBody:
    "Tap a target card to assign all eligible shooters, or a numbered shooter control to assign just that shooter. Retap clears that assignment; another target corrects it. All seated targets remain available. An unassigned shooter has no recorded shot.",
  observationTitle: "Record physical shot observations",
  observationBody:
    "Observation mode is active. Each tap records another physical shot: a numbered control records one shooter; a target card records all eligible shooters. A further actual shot causes a miss, even at the same target. This is not ordinary transcription correction.",
  observationToggleTitle: "Observation is a separate mode",
  observationToggleBody:
    "Observed multiple shooting toggles in-place observation mode without recording a shot by itself. Existing assignments remain. Use it only for actual physical observations; ordinary correction does not erase recorded observations.",
  evaluateTitle: "Evaluate the recorded count",
  evaluateBody:
    "When the physical shooting count is complete, use Evaluate Mafia shots. Missing, conflicting or actual multiple shots miss. Reading this guide neither records a shot nor evaluates the count.",
  shootingResultTitle: "Review the shooting result",
  shootingResultBody:
    "Review the result already displayed on the table. Use the enabled continuation when required announcements are complete. The guide does not repeat private assignments or start another count.",
  donTitle: "Choose a Don-check target",
  donBody:
    "During the ten-second window, tap a seated target to check for Sheriff. Inactive targets remain available. The actual live eligibility controls whether this check can be performed; reading help never selects a target.",
  sheriffTitle: "Choose a Sheriff-check target",
  sheriffBody:
    "During the ten-second window, tap a seated target to check alignment. Inactive targets remain available. The actual live eligibility controls whether this check can be performed; reading help never selects a target.",
  checkUnavailableTitle: "Check unavailable",
  checkUnavailableBody:
    "This check is unavailable under the live eligibility state. Target selection is disabled. Follow only an enabled Skip action if one is offered; the guide cannot grant a check.",
  skipTitle: "Skip only when available",
  skipBody:
    "Skip is a separate explicit action, not a completed check. Use it only if the live Skip control is enabled. A check already underway under a sanction may have to be completed instead.",
  privateTitle: "Read the private result",
  privateBody:
    "Read back the selected seat and privately show the result already on the table. No target identity or live answer is copied into these instructions. Use the enabled continuation after the check.",
  sheriffResultBody:
    "Read back the selected seat and privately show the existing result: red is thumb up, black is thumb down. No target identity or live answer is copied here. Use the enabled continuation after the check.",
  resolutionTitle: "Complete the night",
  resolutionBody:
    "Follow the current result and required announcements, then use the enabled advance action to record Best Move or announce morning as offered. The tutorial never announces, checks or advances anything.",
} as const;
export type TutorialMessageKey = keyof typeof en;

export const tutorialMessages: FeatureMessages<TutorialMessageKey> = {
  en,
  ru: {
    back: "Назад",
    next: "Далее",
    done: "Готово",
    close: "Закрыть подсказки",
    progress: "Шаг {current} из {total}",
    swipe: "Листайте влево или вправо",
    harmless: "Это лишь подсказки — игра, таймер и музыка не меняются.",
    unavailable:
      "Учебный пример: настоящий элемент сейчас недоступен или находится вне видимой области.",
    exampleCard: "Пример: карточка игрока",
    exampleAction: "Пример: продолжение этапа",
    exampleNominee: "Пример: строка порядка голосования",
    exampleShot: "Пример: кнопка стрелка",
    exampleCorrection: "Пример: Да / Нет / Не назначено",
    exampleObservation: "Пример: режим наблюдения",
    dayHelp: "Помощь с дневным столом",
    dayTitle: "Подсказки для дневного стола",
    votingHelp: "Помощь с голосованием",
    votingTitle: "Подсказки для голосования",
    nightHelp: "Помощь с ночью",
    nightTitle: "Подсказки для ночи",
    dayTapTitle: "Нажмите для выставления или поддержки",
    dayTapBody:
      "Во время речи текущего игрока нажмите на активного игрока, чтобы выставить его или поддержать уже выставленного. Повторное нажатие убирает только выбор этого выступающего. Один новый кандидат за речь; поддержки независимы.",
    dayTapUnavailable:
      "Сейчас нет доступного выступающего. Выставление нажатием недоступно, пока текущий ход его не допускает.",
    foulTitle: "Смахните вниз для фола",
    foulBody:
      "Смахните вниз по доступной карточке игрока, чтобы выдать один фол. Четвёртый фол открывает оформление санкции. Жест не выставляет игрока и не записывает голос.",
    foulUnavailable:
      "В текущем состоянии фолы недоступны. Это пример жеста вниз, а не действующая кнопка.",
    penaltyTitle: "Смахните вверх для санкций",
    penaltyBody:
      "Смахните вверх по карточке, чтобы открыть меню санкций для этого игрока. Открытие и закрытие ничего не применяют: решение требует явного подтверждения.",
    penaltyUnavailable:
      "Санкции в текущем состоянии недоступны. Из этих подсказок нельзя применить наказание.",
    advanceTitle: "Продолжите игру за столом",
    advanceBody:
      "После текущей речи нажмите «{action}», когда кнопка доступна. Действие последнего выступающего зависит от выставлений: далее голосование или ночь. Подсказки не завершают ход.",
    nomineeTitle: "Выберите текущего кандидата",
    nomineeBody:
      "Выберите текущего кандидата в панели «Порядок голосования» рядом со столом. Это получатель голосов при нажатии карточек; подсказки не меняют выбор. Если панель свёрнута, изучите пример, не открывая её.",
    voteTitle: "Запишите или исправьте голоса",
    voteBody:
      "Нажмите на доступную карточку голосующего, чтобы записать, убрать или переназначить голос текущему кандидату. Это исправление записи ведущего, а не физического голоса участника. Проверенные и недоступные записи здесь не меняются.",
    candidateTitle: "Следуйте порядку выставления",
    candidateBody:
      "«Следующий кандидат» следует порядку выставления. Явный выбор последнего кандидата назначает оставшиеся голоса. Чтение подсказок не выбирает кандидата и не восстанавливает снятые голоса.",
    finishTitle: "Завершите голосование явно",
    finishBody:
      "Нажмите «Завершить голосование», только когда кнопка доступна: голоса должны быть записаны полностью или результат математически определён. Следующий кандидат не завершает голосование. Недоступное действие ждёт допустимого подсчёта или проверки.",
    disputeTitle: "Голосование приостановлено для проверки",
    disputeBody:
      "При техническом споре переход по кандидатам и завершение приостановлены. Судья просматривает внешнюю запись и принимает итоговое решение через инструменты проверки голосования. Подсказки не разрешают спор.",
    tieTitle: "Речи при равенстве голосов",
    tieBody:
      "Текущему кандидату даётся 30 секунд. После речи нажмите «{action}»; последняя речь ведёт к переголосованию только по этим кандидатам. Таймер остаётся под вашим управлением.",
    collectiveTitle: "Запишите общий подсчёт рук",
    collectiveBody:
      "Нажмите на доступную карточку голосующего, чтобы переключить Да или Нет за подъём связанной группы. Для подъёма нужно больше половины доступных голосов. Недоступные элементы голоса не принимают.",
    correctionTitle: "Исправьте Да, Нет или Не назначено",
    correctionBody:
      "В свёрнутых инструментах исправления для каждого голосующего есть выбор Да / Нет / Не назначено. «Не назначено» убирает запись. Чтение примера не открывает инструменты и не меняет голоса.",
    collectiveFinishTitle: "Завершите физический подсчёт",
    collectiveFinishBody:
      "После физического подсчёта нажмите доступную кнопку завершения, даже если рук за подъём нет. Нетронутые голоса остаются ненаблюдавшимися: подсказки не записывают за них Нет и не завершают подсчёт.",
    cancelledTitle: "Голосование отменено",
    cancelledBody:
      "Прочитайте показанный статус отмены. Обычного голосования для записи здесь нет. Когда ведущий готов, доступное продолжение начинает ночь.",
    skippedTitle: "Общее голосование пропущено",
    skippedBody:
      "Прочитайте причину пропуска на экране. Подъём здесь не записывается. Доступная кнопка продолжения ведёт к ночи.",
    ballotResultTitle: "Прочитайте принятый итог голосования",
    ballotResultBody:
      "На столе показан принятый итог общего голосования. Проверьте его и нажмите доступную кнопку продолжения. Это экран результата, а не открытое голосование.",
    planningTitle: "Договорённость мафии",
    planningBody:
      "Дайте мафии 60 секунд договориться о порядке целей. Когда она готова, подтвердите, что мафия уснула, кнопкой продолжения. Этот начальный этап не записывает выстрелы.",
    sleepTitle: "Подтвердите, что мафия уснула",
    sleepBody:
      "Следуйте текущей начальной подсказке, затем кнопкой продолжения начните отдельное знакомство Шерифа. Ничего не переходит дальше автоматически.",
    openingTitle: "Продолжите начало игры",
    openingBody:
      "Этот восстановленный начальный этап продолжается явно. Следуйте показанной инструкции и доступной кнопке продолжения: это не обычная ночная проверка.",
    greetingTitle: "Знакомство Шерифа",
    greetingBody:
      "Разбудите Шерифа на десять секунд, чтобы он осмотрел стол и познакомился с ведущим, затем начните нулевой круг. Это знакомство, не выбор цели и не запись проверки.",
    zeroTitle: "Начните нулевой круг",
    zeroBody:
      "Следуйте текущей начальной инструкции и начните нулевой круг, когда готовы. Подсказки не меняют рассадку и не начинают ход.",
    shotsTitle: "Запишите выстрелы мафии",
    shotsBody:
      "Нажмите на карточку цели, чтобы назначить всех доступных стрелков, или на номер стрелка для одного назначения. Повторное нажатие убирает назначение; другая цель исправляет его. Доступны все места. Без назначения выстрел не записан.",
    observationTitle: "Запишите наблюдаемые выстрелы",
    observationBody:
      "Режим наблюдения включён. Каждое нажатие записывает очередной физический выстрел: номер — одного стрелка, карточка цели — всех доступных. Повторный фактический выстрел означает промах даже в ту же цель. Это не обычное исправление записи.",
    observationToggleTitle: "Наблюдение — отдельный режим",
    observationToggleBody:
      "Кнопка многократной стрельбы включает и выключает режим наблюдения на столе, сама не записывая выстрел. Назначения сохраняются. Используйте режим только для реальных наблюдений; обычное исправление не стирает их.",
    evaluateTitle: "Определите итог подсчёта",
    evaluateBody:
      "Закончив физический подсчёт стрельбы, определите результат кнопкой на столе. Отсутствующие, разные или фактические повторные выстрелы дают промах. Подсказки не записывают выстрел и не определяют результат.",
    shootingResultTitle: "Проверьте результат стрельбы",
    shootingResultBody:
      "Проверьте уже показанный на столе результат. Продолжайте доступной кнопкой после обязательных объявлений. Подсказки не повторяют закрытые назначения и не начинают новый подсчёт.",
    donTitle: "Выберите цель проверки Дона",
    donBody:
      "В десятисекундное окно нажмите на сидящего игрока для проверки на Шерифа. Неактивные цели тоже доступны. Возможность проверки определяется текущим состоянием игры; чтение подсказок цель не выбирает.",
    sheriffTitle: "Выберите цель проверки Шерифа",
    sheriffBody:
      "В десятисекундное окно нажмите на сидящего игрока для проверки команды. Неактивные цели тоже доступны. Возможность проверки определяется текущим состоянием игры; чтение подсказок цель не выбирает.",
    checkUnavailableTitle: "Проверка недоступна",
    checkUnavailableBody:
      "По текущему состоянию игры эта проверка недоступна. Выбор цели выключен. Используйте только доступную кнопку пропуска, если она есть: подсказки не дают права на проверку.",
    skipTitle: "Пропускайте только доступную проверку",
    skipBody:
      "Пропуск — отдельное явное действие, не выполненная проверка. Он возможен только при доступной кнопке. Уже начатую проверку при санкции может потребоваться завершить.",
    privateTitle: "Прочитайте закрытый результат",
    privateBody:
      "Повторите выбранное место и приватно покажите уже отображённый результат. Имя цели и фактический ответ в эти инструкции не копируются. После проверки используйте доступное продолжение.",
    sheriffResultBody:
      "Повторите выбранное место и приватно покажите существующий результат: красный — большой палец вверх, чёрный — вниз. Имя цели и фактический ответ здесь не повторяются. После проверки используйте доступное продолжение.",
    resolutionTitle: "Завершите ночь",
    resolutionBody:
      "Следуйте текущему результату и обязательным объявлениям. Затем доступной кнопкой запишите лучший ход или объявите утро — по предложенному действию. Подсказки ничего не объявляют, не проверяют и не продолжают.",
  },
};
