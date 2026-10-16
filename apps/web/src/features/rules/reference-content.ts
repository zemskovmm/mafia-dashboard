import type { RuleReferenceId } from "./rule-references.js";

interface ReferenceText {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly note: string;
}
interface RuleReference {
  readonly id: RuleReferenceId;
  readonly en: ReferenceText;
  readonly ru: ReferenceText;
  readonly source: string;
}

// Authored bilingual paraphrases, not official translations.
// MAFGAME 1 July 2026, sections 6.2 / 6.3 / 6.6; source checked 15 October 2026.
export const ruleReferences = [
  {
    id: "6.2.1",
    en: {
      title: "Fourth foul: removal without a final speech",
      paragraphs: [
        "Receiving a fourth foul is itself a ground for removal. Unlike the speech restriction attached to three fouls, it ends the player's participation; rule 5.5 gives no final speech. A separate disqualifying offence need not be established for this fourth-foul basis.",
        "The associated ballot consequence depends on timing. Rules 6.5.1–6.5.2 cancel the current or nearest ballot, except for a player already departing through a night kill or the vote. If another player is removed after that day's voting result is known, the next day's ballot is cancelled.",
      ],
      note: "App: the fourth-foul action supplies this rule automatically. An additional removal note is optional; the observed timing still matters.",
    },
    ru: {
      title: "Четвёртый фол: удаление без последнего слова",
      paragraphs: [
        "Получение четвёртого фола само по себе является основанием для удаления. В отличие от ограничения речи при трёх фолах, это прекращение участия в игре: пункт 5.5 не предоставляет последнего слова. Для удаления по этому основанию не требуется отдельное дисквалифицирующее нарушение.",
        "Последствие для голосования зависит от момента удаления. Пункты 6.5.1–6.5.2 отменяют текущее или ближайшее голосование, кроме удаления игрока, уже уходящего вследствие ночного убийства или голосования. Если после известного результата голосования удаляется другой игрок, не проводится голосование следующего дня.",
      ],
      note: "В приложении четвёртый фол автоматически выбирает этот пункт. Дополнительная причина необязательна; фактический момент нарушения всё равно нужно указать.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.2",
    en: {
      title: "Insults, discriminatory remarks and disguised equivalents",
      paragraphs: [
        "Insulting another player, a judge or a spectator is punishable by removal, including disguised insults. The clause expressly covers references or attributions to another player involving illness, diagnoses, death, health or alcohol/drug intoxication; sexual remarks directed at someone; and discriminatory remarks concerning race, sex, sexual orientation, religion or nationality.",
        "It also includes any mention of suicide. Gestures, mouthing and other concealed equivalents of the listed conduct remain covered, including when presented as a joke. This is broader than a prohibition on spoken swear words alone.",
      ],
      note: "Tournament rule 6.4.2 separately covers expulsion for insulting a judge or chief judge. The app's game-discipline action does not administer tournament expulsion.",
    },
    ru: {
      title: "Оскорбления, дискриминация и завуалированные аналоги",
      paragraphs: [
        "Оскорбление другого игрока, судьи или зрителя наказывается удалением, в том числе если оно завуалировано. Пункт прямо охватывает упоминания или приписывание другому игроку состояний, связанных с болезнями, диагнозами, смертью, здоровьем, алкогольным или наркотическим опьянением; сексуальные высказывания в чей-либо адрес; дискриминацию по расе, полу, сексуальной ориентации, вероисповеданию или национальности.",
        "Также перечислены любые упоминания суицида. Жесты, артикуляция и другие скрытые аналоги перечисленного тоже подпадают под правило, в том числе в шутливом контексте. Запрет не ограничивается произнесённым вслух матом.",
      ],
      note: "Турнирный пункт 6.4.2 отдельно предусматривает удаление с турнира за оскорбление судьи или главного судьи. Приложение не оформляет турнирное исключение.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.3",
    en: {
      title: "Night hints, accidental peeking and other night misconduct",
      paragraphs: [
        "Removal applies to night-time signs giving hints to the Don or Sheriff, accidental peeking, touching other players, talking or shouting, and other breaches of night behaviour. Deliberate peeking to obtain information has its own basis in 6.2.10; accidental peeking is already included here.",
        "Effective exclusion and announcement need not coincide. During shooting the judge finishes the count before announcing removal. During checks, an eligible check already underway is completed, and removals are announced after the Sheriff's check, so the announcement does not reveal extra role information.",
      ],
      note: "App: the judge identifies the misconduct and records its actual stage. Software does not detect night hints or peeking.",
    },
    ru: {
      title: "Ночные подсказки, непроизвольное подглядывание и поведение",
      paragraphs: [
        "Удалением наказываются ночные подсказки знаками Дону или Шерифу, непроизвольное подглядывание, прикосновения к игрокам, разговоры, выкрики и другие нарушения ночного поведения. Сознательное подглядывание ради информации отдельно указано в 6.2.10; непроизвольное уже охватывается этим пунктом.",
        "Исключение из игры и объявление могут происходить в разные моменты. При стрельбе судья завершает отсчёт перед объявлением удаления. Во время проверок уже начатая допустимая проверка завершается, а удаления объявляются после проверки Шерифа, чтобы не раскрывать дополнительную информацию о ролях.",
      ],
      note: "В приложении судья сам определяет нарушение и указывает фактическую стадию. Программа не выявляет ночные подсказки или подглядывание.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.4",
    en: {
      title: "Leaving the table without permission",
      paragraphs: [
        "Leaving the game table without permission is punishable by removal. The rule defines the boundary expressly: a player who rises from their seat into an upright standing position is considered to have left the table. It does not require the player to walk away or leave the room first.",
        "The relevant conduct is an unauthorised departure, not the ordinary required exit after elimination. Standing up cannot be treated as harmless merely because the player remains beside the chair; the stated standing-position criterion is already sufficient for this definition.",
      ],
      note: "App: record the judge-observed departure and its timing. A software seat or status change is not evidence that someone physically stood up.",
    },
    ru: {
      title: "Самовольный уход из-за игрового стола",
      paragraphs: [
        "Самовольное покидание игрового стола наказывается удалением. Граница прямо определена в правиле: игрок, вставший со своего места и принявший вертикальное положение, считается покинувшим стол. Для этого не требуется сначала отойти от стула или выйти из комнаты.",
        "Речь идёт именно об уходе без разрешения, а не об обязательном выходе после игрового выбывания. Нельзя считать вставание безразличным только потому, что игрок остаётся рядом со стулом: указанного в пункте вертикального положения уже достаточно для определения факта ухода.",
      ],
      note: "В приложении фиксируется наблюдение судьи и момент события. Изменение программного места или статуса не доказывает физического вставания игрока.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.5",
    en: {
      title: "Tears and a near-tears state at the table",
      paragraphs: [
        "The removal clause covers both tears at the game table and what the Russian rules call a “near-tears state” (предслезное состояние). Its wording does not require an attempt to prove a role or influence a vote, and it does not supply a duration or a more precise threshold for that state.",
        "A possible team-loss escalation is separate: under 6.3.5, a player “in the version” who breaches this clause, including during farewell, may trigger opposing-team victory only with the required committee agreement. Removal alone is not that ruling.",
      ],
      note: "App: the judge assesses the observed state; the interface neither diagnoses emotion nor automatically awards a team loss.",
    },
    ru: {
      title: "Слёзы и предслезное состояние за столом",
      paragraphs: [
        "Основание для удаления охватывает как слёзы за игровым столом, так и «предслезное состояние». В формулировке нет условия о попытке доказать роль или повлиять на голосование. Также не указаны длительность и более точный порог, определяющий такое состояние.",
        "Возможная ППК — отдельное решение. По 6.3.5 нарушение этого пункта игроком, «находящимся в версии», в том числе на прощальной минуте, позволяет присудить победу противоположной команде только при необходимом согласовании с СК. Само удаление ещё не означает присуждения ППК.",
      ],
      note: "В приложении состояние оценивает судья. Интерфейс не диагностирует эмоции и не назначает команде поражение автоматически.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.6",
    en: {
      title: "Using the wrong physical voting gesture",
      paragraphs: [
        "This clause concerns the form of the physical vote: voting with a palm, finger, elbow, both hands or another non-prescribed gesture is punishable by removal. Rule 4.4.3 prescribes an upright fist on the table with the thumb raised.",
        "Do not confuse form with voting order. Withdrawing a hand before the count is announced is separately a foul, and the vote still counts under 4.4.7. Other order violations appear in 6.1.8. Those provisions do not replace the removal basis for an invalid voting gesture.",
      ],
      note: "App: changing a recorded vote corrects transcription; it is not a new physical hand gesture and does not itself establish this offence.",
    },
    ru: {
      title: "Неправильная физическая форма голосования",
      paragraphs: [
        "Пункт относится к форме физического голоса: голосование ладонью, пальцем, локтем, двумя руками или иным непредписанным способом наказывается удалением. Пункт 4.4.3 требует поставить на стол вертикальный кулак с поднятым большим пальцем.",
        "Форму не следует смешивать с порядком голосования. Отдёргивание руки до объявления количества голосов отдельно наказывается фолом, причём голос засчитывается по 4.4.7. Другие нарушения порядка перечислены в 6.1.8. Они не заменяют основание для удаления за неправильную форму жеста.",
      ],
      note: "В приложении изменение записанного голоса исправляет запись. Оно не является новым физическим жестом и само по себе не устанавливает это нарушение.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.7",
    en: {
      title: "Claiming Best Move influence as role evidence",
      paragraphs: [
        "A player is removed for appealing to influence over Best Move in order to prove a game role or explain game actions. The prohibited argument is that claimed influence used as evidence or justification; the clause is not a blanket ban on mentioning Best Move.",
        "Best Move is the eligible first shooting-night victim's opportunity to name three suspected black players. Rule 6.2.7 concerns appeals to influence over that procedure, not a new right to change its accepted numbers. Rule 4.6.4 separately allows changes only for obvious slips.",
      ],
      note: "App: record the actual argument the judge identified. Selecting this reference neither changes Best Move nor revises its accepted statement.",
    },
    ru: {
      title: "Ссылки на влияние на лучший ход как доказательство роли",
      paragraphs: [
        "Игрок удаляется за апелляцию к влиянию на лучший ход ради доказательства игровой роли или объяснения игровых действий. Запрещён именно аргумент о таком влиянии, используемый как доказательство или оправдание. Пункт не устанавливает общий запрет на упоминание лучшего хода.",
        "Лучший ход позволяет имеющей это право жертве первой стрельбы назвать трёх предполагаемых чёрных игроков. Пункт 6.2.7 касается ссылок на влияние на эту процедуру, а не предоставляет право менять принятые номера. Их изменение отдельно допускается по 4.6.4 только для очевидных оговорок.",
      ],
      note: "В приложении фиксируется выявленный судьёй аргумент. Открытие справки не изменяет лучший ход или уже принятое высказывание.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.8",
    en: {
      title: "Covertly whispering unique daytime information",
      paragraphs: [
        "Removal applies to an attempt to pass unique daytime information by whispering that is deliberately hidden from the judges and most players. The rule makes the intended setting explicit: whispering directly into a neighbour's ear so that nobody else hears. An attempt, not only a completed transfer, is covered.",
        "This is more specific than any quiet speech. Speaking out of turn, including whispering or intelligible mouthing, is separately listed as a foul in 6.1.4. Here the defining combination is unique daytime information and a clearly concealed channel.",
      ],
      note: "App: the judge identifies the attempted private communication. The software does not listen for or verify whispered content.",
    },
    ru: {
      title: "Скрытый шёпот с уникальной дневной информацией",
      paragraphs: [
        "Удаление предусмотрено за попытку передать уникальную дневную информацию шёпотом, явно скрываемым от судей и большинства игроков. Правило конкретизирует ситуацию: шёпот строго на ухо соседу, чтобы никто больше не услышал. Охватывается сама попытка, а не только успешно завершённая передача.",
        "Это более узкое основание, чем любая тихая речь. Речь вне своей минуты, включая шёпот и понятную артикуляцию, отдельно указана как фол в 6.1.4. Здесь существенны вместе уникальная дневная информация и явно скрытый способ её сообщения.",
      ],
      note: "В приложении попытку тайного общения определяет судья. Программа не прослушивает и не проверяет содержание шёпота.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.9",
    en: {
      title: "Profanity, including concealed or mouthed profanity",
      paragraphs: [
        "Using obscene language is a removal offence. The wording expressly includes concealed profanity and swear words conveyed by mouthing. Audible pronunciation is therefore not necessary: hiding the word's form or articulating it silently does not take it outside the clause.",
        "The stated basis is the obscene language itself; unlike 6.2.12, this clause adds no requirement that it be used to prove a role or influence voting. It is a direct removal ground, not merely another ordinary foul that becomes removal only at four.",
      ],
      note: "App: the judge classifies the observed language. The interface is not a profanity filter and does not infer an offence from a player's text or speech.",
    },
    ru: {
      title: "Нецензурная лексика, включая скрытый мат и артикуляцию",
      paragraphs: [
        "Использование нецензурной лексики является основанием для удаления. Прямо включены завуалированная нецензурная лексика и мат артикуляцией. Поэтому произнесение вслух не обязательно: скрытая форма слова или его беззвучное артикулирование не выводят поведение за рамки пункта.",
        "Основание — сама нецензурная лексика. В отличие от 6.2.12, здесь не добавлено условие о доказательстве роли или влиянии на голосование. Это самостоятельное основание удаления, а не только очередной обычный фол, который приводит к удалению лишь при достижении четырёх.",
      ],
      note: "В приложении наблюдаемое выражение квалифицирует судья. Интерфейс не является фильтром мата и не выводит нарушение из текста или речи автоматически.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.10",
    en: {
      title: "Deliberate peeking and other non-game information gathering",
      paragraphs: [
        "Deliberately peeking to obtain information is punishable by removal, as are other ways of acquiring information outside the permitted game process. For peeking, the wording expressly identifies conscious conduct aimed at obtaining information; it should not be reduced to the broader label “night misconduct.”",
        "Accidental night-time peeking is separately included in 6.2.3. The same deliberate information-gathering conduct is also listed in tournament-expulsion rule 6.4.1, so game removal and tournament consequences are distinct levels of regulation, not interchangeable software statuses.",
      ],
      note: "App: record game discipline and the observed boundary. The app does not detect peeking or administer tournament expulsion.",
    },
    ru: {
      title: "Сознательное подглядывание и неигровое получение информации",
      paragraphs: [
        "Сознательное подглядывание ради получения информации наказывается удалением, как и другие способы получения информации вне игрового процесса. Для подглядывания прямо указаны сознательность и цель получения информации. Поэтому смысл пункта нельзя сводить к общей метке «ночные нарушения».",
        "Непроизвольное ночное подглядывание отдельно включено в 6.2.3. Такое же сознательное неигровое получение информации указано в турнирном пункте 6.4.1. Удаление из игры и последствия на уровне турнира — разные уровни регламента, а не взаимозаменяемые программные статусы.",
      ],
      note: "В приложении фиксируются игровое взыскание и фактический момент. Программа не выявляет подглядывание и не оформляет удаление с турнира.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.11",
    en: {
      title: "Concealing speech through an incomprehensible language",
      paragraphs: [
        "Removal applies to concealing spoken information by delivering it in a language that most players at the table and the judge do not understand. The clause is about hiding information through language, not simply the presence of a foreign word or a player's multilingual background.",
        "The rule's audience condition includes both the majority of players and the judge. A separate escalation exists in 6.3.5: for a player “in the version,” this offence can lead to opposing-team victory, including during farewell, strictly with committee agreement.",
      ],
      note: "App: reading this rule does not change the interface language. The judge assesses concealment and records any disciplinary ruling.",
    },
    ru: {
      title: "Сокрытие речи с помощью непонятного языка",
      paragraphs: [
        "Удалением наказывается сокрытие речевой информации путём её произнесения на языке, непонятном большинству игроков за столом и судье. Основание связано именно со скрытием информации посредством языка, а не просто с иностранным словом или многоязычием участника.",
        "В условии о понимании названы и большинство игроков, и судья. Отдельное усиление предусмотрено в 6.3.5: для игрока, «находящегося в версии», такое нарушение может привести к победе противоположной команды, включая случай прощальной минуты, строго по согласованию с СК.",
      ],
      note: "В приложении чтение этого пункта не меняет язык интерфейса. Сокрытие оценивает судья; дисциплинарное решение фиксируется отдельно.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.12",
    en: {
      title: "Excessive emotion or shouting used to prove or sway",
      paragraphs: [
        "Removal applies when excessive emotion or shouting is used to prove the player's role or influence voting. That purpose is part of the clause: loudness alone is not its complete definition. Rule 6.1.7 separately lists shouting or other excessive emotional displays during one's speech as a foul.",
        "For a player “in the version,” 6.3.5 permits the judge to escalate this offence to opposing-team victory, even during a farewell speech, but strictly with committee agreement. The removal clause itself is not an automatic team-loss instruction.",
      ],
      note: "App: the judge identifies the conduct and its purpose. Selecting this rule does not automatically record committee approval or award victory.",
    },
    ru: {
      title: "Чрезмерные эмоции или крик для доказательства и влияния",
      paragraphs: [
        "Удаление предусмотрено за чрезмерный эмоционал или крик с целью доказать свою роль либо повлиять на голосование. Эта цель входит в формулировку: одна громкость не исчерпывает определение нарушения. Пункт 6.1.7 отдельно относит к фолу крик или другие чрезмерные эмоциональные проявления во время своей речи.",
        "Для игрока, «находящегося в версии», пункт 6.3.5 позволяет усилить последствие до победы противоположной команды, даже на прощальной минуте, но строго по согласованию с СК. Сам пункт об удалении не предписывает автоматического командного поражения.",
      ],
      note: "В приложении поведение и его цель определяет судья. Выбор пункта не подтверждает согласование с СК и не присуждает победу автоматически.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.2.13",
    en: {
      title: "Non-game role claims and influence through words or gestures",
      paragraphs: [
        "Removal applies to attempts to reveal a role or influence the game or voting through non-game arguments, gestures, mouthing or turns of phrase. The word “attempts” matters: the clause does not require the argument to persuade the table or change the eventual vote.",
        "It is not a blanket prohibition on role claims or game reasoning; the specified basis is non-game argument or communication. Under 6.3.5, a player “in the version” can instead receive a team-loss ruling for this offence, including during farewell, strictly with committee agreement.",
      ],
      note: "App: the judge supplies the rule basis and observed timing. Software does not decide whether an argument is non-game evidence.",
    },
    ru: {
      title: "Неигровое вскрытие роли и влияние словами или жестами",
      paragraphs: [
        "Удаление предусмотрено за попытки вскрыть роль или повлиять на игру либо голосование неигровыми аргументами, жестикуляцией, артикуляцией или речевыми оборотами. Существенно слово «попытки»: пункт не требует, чтобы довод убедил стол или фактически изменил результат голосования.",
        "Это не общий запрет на заявления о роли или игровую аргументацию: указанное основание связано с неигровым доказательством или сообщением. По 6.3.5 нарушение игроком, «находящимся в версии», может привести к командному поражению, включая случай прощальной минуты, строго по согласованию с СК.",
      ],
      note: "В приложении судья указывает пункт и фактический момент. Программа не определяет, является ли аргумент неигровым доказательством.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.3.1",
    en: {
      title: "Oaths, pleading, blackmail, threats, bribery and wagers",
      paragraphs: [
        "Using oaths, pleading, blackmail, threats, bribery or wagers, in any form or equivalent, to prove a role or influence the course of the game leads to opposing-team victory. The purpose connects the listed conduct to the offence; the wording is not limited to a particular phrase or to explicit money offers.",
        "The rule's example includes pleading with someone to vote together. Its sanction is a team result under section 6.3, not merely a fourth-foul removal or an adjustment to a player's ordinary foul count.",
      ],
      note: "App: the judge records the losing side, rule and reason. Awarding this victory does not fabricate eliminations or change player statuses.",
    },
    ru: {
      title: "Клятвы, мольбы, шантаж, угрозы, подкуп и пари",
      paragraphs: [
        "Клятвы, мольбы, шантаж, угрозы, подкуп, пари и их аналоги в любой форме приводят к победе противоположной команды, когда используются для доказательства роли или влияния на ход игры. Указанная цель связывает поведение с нарушением; правило не ограничено конкретной фразой или прямым денежным предложением.",
        "Среди примеров есть мольба проголосовать вместе с игроком. Санкция относится к результату команды по разделу 6.3, а не только к удалению за четвёртый фол или изменению обычного счётчика фолов.",
      ],
      note: "В приложении судья фиксирует проигравшую сторону, пункт и обоснование. Такая победа не создаёт выбываний и не меняет статусы игроков.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.3.2",
    en: {
      title: "Non-game ethical or religious appeals",
      paragraphs: [
        "Opposing-team victory applies to appeals to non-game ethical or religious values, or other non-game appeals, used to prove a role directly or indirectly or to influence the voting outcome. The source examples invoke God as evidence of being red or as a reason to believe a Sheriff claim.",
        "The defining issue is using those outside-game values as proof or voting pressure. The clause is not a general ban on holding a belief, and indirect role proof is covered just as direct claims are.",
      ],
      note: "App: the judge records a reasoned result ruling, not an invented elimination. The interface does not evaluate beliefs or automatically classify a statement.",
    },
    ru: {
      title: "Неигровые этические и религиозные апелляции",
      paragraphs: [
        "Победа противоположной команды предусмотрена за обращения к неигровым этическим или религиозным ценностям и другие неигровые апелляции ради прямого либо косвенного доказательства роли или влияния на результат голосования. Примеры источника ссылаются на Бога как подтверждение красной роли или повод поверить вскрытию Шерифом.",
        "Определяющий признак — использование внешних для игры ценностей как доказательства или давления при голосовании. Это не общий запрет иметь убеждения; косвенное доказывание роли охватывается так же, как прямое.",
      ],
      note: "В приложении судья обосновывает решение о результате без выдуманного выбывания. Интерфейс не оценивает убеждения и не классифицирует высказывание автоматически.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.3.3",
    en: {
      title: "Proving a Sheriff claim with unique night observations",
      paragraphs: [
        "A player who has claimed Sheriff causes opposing-team victory by proving that role through unique night information: actions or events that could be seen while a check was taking place. The wording refers to a Sheriff claimant, not only someone whose true card is Sheriff.",
        "The target is role proof based on privileged night observations, rather than every Sheriff claim or report of a check. The distinctive evidence is what the claimant could observe during the check, used to authenticate the claimed role outside ordinary game reasoning.",
      ],
      note: "App: the judge assesses the claimed proof and records the rule and reason. Private check information is not made public merely by opening this reference.",
    },
    ru: {
      title: "Доказательство вскрытия Шерифом уникальными ночными сведениями",
      paragraphs: [
        "Игрок, вскрывшийся Шерифом, приводит к победе противоположной команды, если доказывает роль уникальной ночной информацией: действиями игроков или событиями, которые можно было увидеть во время проверки. Формулировка относится к заявившему роль игроку, а не только к обладателю настоящей карты Шерифа.",
        "Речь о доказательстве роли через особые ночные наблюдения, а не о любом вскрытии Шерифом или сообщении проверки. Отличительный признак — увиденное во время проверки используется для подтверждения подлинности заявленной роли вне обычной игровой аргументации.",
      ],
      note: "В приложении доказательство оценивает судья, фиксируя пункт и причину. Открытие справки само по себе не публикует сведения приватных проверок.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.3.4",
    en: {
      title: "Game-related hints from the audience",
      paragraphs: [
        "The published clause names game-related hints from the audience as a ground for opposing-team victory. Read with the section 6.3 heading, this is a result-level sanction, not an ordinary player foul. It concerns outside assistance entering the game from spectators rather than a participating player's permitted game argument.",
        "The clause itself is brief: it does not specify a method for assigning the losing side or a detailed test for what constitutes a hint. Those details must not be invented as if they were additional official wording.",
      ],
      note: "App: the judge identifies the applicable losing side and records the rule and reason. No audience monitoring or automatic attribution is performed.",
    },
    ru: {
      title: "Игровые подсказки из зрительного зала",
      paragraphs: [
        "Опубликованный пункт называет игровые подсказки из зрительного зала основанием для победы противоположной команды. Вместе с заголовком раздела 6.3 это означает санкцию на уровне результата, а не обычный фол игроку. Речь о внешней помощи от зрителей, а не о допустимом игровом доводе участника стола.",
        "Формулировка краткая: она не задаёт способ определения проигравшей стороны и подробный критерий подсказки. Эти детали нельзя дописывать как якобы существующий официальный текст правила.",
      ],
      note: "В приложении судья определяет соответствующую проигравшую сторону, указывает пункт и обоснование. Мониторинга зрителей и автоматического определения виновной стороны нет.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.3.5",
    en: {
      title: "Committee-agreed escalation of four specified removal offences",
      paragraphs: [
        "For a player described as “in the version” (в версии), the judge may award opposing-team victory for violations of 6.2.5, 6.2.11, 6.2.12 or 6.2.13, including during the farewell minute. These are tears/near-tears, language concealment, emotional role-proof or voting pressure, and non-game role claims or influence.",
        "This is a discretionary escalation, strictly subject to agreement with СК, the judges' committee. It is not an automatic team loss for every removal, does not extend to all of section 6.2, and does not dispense with the stated “in the version” condition.",
      ],
      note: "App: this ruling requires a reason and explicit confirmation that the required committee agreement was obtained. Software neither obtains nor verifies that agreement.",
    },
    ru: {
      title: "Усиление четырёх нарушений строго по согласованию с СК",
      paragraphs: [
        "Если игрок, «находящийся в версии», нарушает 6.2.5, 6.2.11, 6.2.12 или 6.2.13, судья может присудить победу противоположной команды, в том числе за нарушение на прощальной минуте. Перечень охватывает слёзы и предслезное состояние, языковое сокрытие информации, эмоциональное доказывание роли или влияние на голосование и неигровое вскрытие либо влияние.",
        "Это возможность усиления санкции строго по согласованию с СК, а не автоматическое командное поражение за любое удаление. Она не распространяется на весь раздел 6.2 и не отменяет указанного условия «в версии».",
      ],
      note: "В приложении требуются обоснование и явное подтверждение полученного согласования. Программа не получает согласование с СК и не проверяет его фактическое наличие.",
    },
    source: "https://mafgame.org/pages/rules",
  },
  {
    id: "6.6.4",
    en: {
      title: "Information passed after effective disqualification",
      paragraphs: [
        "Disqualification takes effect when the removal violation is recorded, even if the player is still physically at the table. Subsequent actions are treated as a spectator's actions. If the player then passes information to participants by any means, including shouting, gestures or touching, the judge awards opposing-team victory.",
        "The express exception concerns a black player's participation in shooting: the disqualified player's shots are ignored. Such shooting is not itself the information-transfer basis for team loss. Delayed departure or announcement does not restore permission to communicate.",
      ],
      note: "App: exclusion, physical departure and announcement are separate. An eligible check already underway is completed under 6.6.3; later checks by previously disqualified players are not permitted.",
    },
    ru: {
      title: "Передача информации после фиксации нарушения",
      paragraphs: [
        "Дисквалификация действует с момента фиксации нарушения, ведущего к удалению, даже если игрок физически ещё за столом. Последующие действия рассматриваются как действия зрителя. Если после этого игрок передаёт участникам информацию любым способом, включая выкрики, жесты или касания, судья присуждает победу противоположной команде.",
        "Прямое исключение касается участия чёрного игрока в стрельбе: его выстрелы не учитываются. Такая стрельба сама по себе не является основанием ППК за передачу информации. Отложенный уход или объявление не возвращают право общаться с участниками.",
      ],
      note: "В приложении исключение, физический уход и объявление разделены. Уже начатая допустимая проверка завершается по 6.6.3; последующие проверки ранее дисквалифицированного игрока не разрешены.",
    },
    source: "https://mafgame.org/pages/rules",
  },
] as const satisfies readonly RuleReference[];
