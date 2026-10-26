import type { RulesChapter } from "./rules-types.js";

// Authored club guide, not an official tournament translation.
// Behavior source: IDD-0002; MAFGAME 1 July 2026: https://mafgame.org/pages/rules
export const guideChapters = [
  {
    id: "table",
    art: "club",
    source: "Setup and participants; Outcomes and finalization",
    en: {
      title: ["A city of", "secrets."],
      name: "The table",
      tag: "01 / THE ART OF NOT KNOWING",
      plate: "Fig. I — An evening at the club",
      note: "Ten strangers. Two sides. One very good story.",
      lede: "A small guide to a game of observation, persuasion, and beautifully misplaced trust.",
      intro:
        "Ten players sit around a table. Seven belong to the red team: six Citizens and a Sheriff. Three belong to the black team: two Mafia and a Don.",
      outro:
        "By day, everyone speaks and the table votes. By night, the Mafia acts in secret. The host keeps the rhythm — and the secrets.",
      margin: "Red wins when no Mafia remain. Black wins at parity or a numerical advantage.",
      signature: "Trust carefully.",
    },
    ru: {
      title: ["Город", "секретов."],
      name: "За столом",
      tag: "01 / ИСКУССТВО НЕ ЗНАТЬ",
      plate: "Рис. I — Вечер в клубе",
      note: "Десять игроков. Две стороны. Одна история.",
      lede: "Небольшая книга о наблюдательности, убеждении и доверии не тем людям.",
      intro:
        "За столом десять игроков. Семеро — красные: шесть Мирных жителей и Шериф. Трое — чёрные: две Мафии и Дон.",
      outro:
        "Днём все говорят и голосуют. Ночью Мафия действует тайно. Ведущий хранит секреты и задаёт ритм игры.",
      margin:
        "Красные побеждают, когда чёрных не осталось. Чёрные — при равенстве или превосходстве в числе.",
      signature: "Доверяйте осторожно.",
    },
  },
  {
    id: "opening",
    art: "night",
    source: "Rules edition; Setup and participants",
    en: {
      title: ["Before the", "city wakes."],
      name: "The first night",
      tag: "02 / AN AGREEMENT IN THE DARK",
      plate: "Fig. II — The city keeps its secrets",
      note: "The first night is for introductions, not shots.",
      lede: "The roles are private. The ritual is shared.",
      rules: [
        [
          "Deal the roles",
          "The host is not a seated player. Roles are drawn in secret; the ten-seat composition stays fixed.",
        ],
        [
          "Give the Mafia a minute",
          "Mafia planning lasts 60 seconds. The host then puts the black team to sleep and confirms it.",
        ],
        [
          "Greet the Sheriff",
          "The Sheriff gets ten seconds to look around and greet the host. Then begin round zero. No opening kill or check.",
        ],
      ],
      margin:
        "This is the app’s streamlined club opening. Planning counts as game night one; the first shooting night is night two.",
    },
    ru: {
      title: ["Пока город", "ещё спит."],
      name: "Первая ночь",
      tag: "02 / ДОГОВОРКА В ТЕМНОТЕ",
      plate: "Рис. II — Город хранит тайны",
      note: "Первая ночь — для знакомства, не для стрельбы.",
      lede: "Роли тайные. Ритуал — общий.",
      rules: [
        [
          "Раздайте роли",
          "Ведущий не занимает игровое место. Роли раздаются тайно; состав колоды для десяти мест неизменен.",
        ],
        [
          "Минута для Мафии",
          "На договорку — 60 секунд. Затем ведущий укладывает чёрных спать и подтверждает это.",
        ],
        [
          "Приветствие Шерифа",
          "Шерифу даются десять секунд осмотреться и поприветствовать ведущего. Далее — нулевой круг, без убийства и проверки.",
        ],
      ],
      margin:
        "Так устроено сокращённое клубное открытие в приложении. Договорка — первая игровая ночь; первая стрельба — вторая.",
    },
  },
  {
    id: "day",
    art: "table",
    source: "Speeches, nominations and discipline",
    en: {
      title: ["A minute", "to convince."],
      name: "The conversation",
      tag: "03 / LISTEN BETWEEN THE LINES",
      plate: "Fig. III — A place for every story",
      note: "Clockwise, one voice at a time.",
      lede: "Every speech is a chance to change the room.",
      rules: [
        [
          "Follow the circle",
          "The first discussion starts at seat one. Speak clockwise among active players; each later day starts from the next active seat after the previous opener.",
        ],
        [
          "Sixty seconds",
          "An ordinary speech lasts a minute. Listen for contradictions, alliances, and the things left unsaid.",
        ],
        [
          "Make one nomination",
          "The current speaker may nominate once — including themselves. A candidate cannot appear twice in the nomination order.",
        ],
      ],
      margin:
        "The nomination queue is the judge’s private working information, not something to reveal on a player’s request.",
    },
    ru: {
      title: ["Минута,", "чтобы убедить."],
      name: "Дневной разговор",
      tag: "03 / СЛУШАЙТЕ МЕЖДУ СТРОК",
      plate: "Рис. III — У каждой истории своё место",
      note: "По часовой стрелке. По одному голосу.",
      lede: "Каждая речь может изменить мнение стола.",
      rules: [
        [
          "По кругу",
          "Первое обсуждение начинает место № 1. Говорят активные игроки по часовой стрелке; в следующие дни начало сдвигается к следующему активному месту.",
        ],
        [
          "Шестьдесят секунд",
          "Обычная речь длится минуту. Слушайте противоречия, замечайте союзы и недосказанность.",
        ],
        [
          "Одна кандидатура",
          "Говорящий может выставить одного кандидата, в том числе себя. Повторно выставлять уже названного игрока нельзя.",
        ],
      ],
      margin: "Порядок выставления — рабочая информация судьи. По просьбе игрока её не раскрывают.",
    },
  },
  {
    id: "voting",
    art: "cards",
    source: "Voting and host correction",
    en: {
      title: ["A show", "of hands."],
      name: "The vote",
      tag: "04 / SUSPICION BECOMES A DECISION",
      plate: "Fig. IV — One player, one recorded vote",
      note: "A correction on screen is not a second physical vote.",
      lede: "Listen first. Commit when your candidate is called.",
      rules: [
        [
          "In nomination order",
          "Candidates are called in the order they were nominated. Each eligible voter has at most one recorded assignment.",
        ],
        [
          "No unnecessary ballot",
          "No nominees means no vote. A lone nominee survives round zero; on a later day the lone nominee leaves as discussion ends.",
        ],
        [
          "Finish deliberately",
          "The host explicitly finishes a complete or mathematically decided ballot. A mere lead is not enough. Highest counts determine elimination or a tie.",
        ],
      ],
      margin:
        "A disputed count pauses the ballot for the judge’s review. Correcting a transcription does not change a player’s physical vote.",
    },
    ru: {
      title: ["Решение", "поднятой руки."],
      name: "Голосование",
      tag: "04 / ПОДОЗРЕНИЕ СТАНОВИТСЯ РЕШЕНИЕМ",
      plate: "Рис. IV — Один игрок, один учтённый голос",
      note: "Исправление записи — не повторный физический голос.",
      lede: "Сначала слушайте. Затем сделайте выбор.",
      rules: [
        [
          "В порядке выставления",
          "Кандидатов называют по порядку номинаций. У каждого имеющего право голосовать — не больше одного учтённого голоса.",
        ],
        [
          "Без лишнего голосования",
          "Нет кандидатов — нет голосования. Один кандидат на нулевом круге остаётся; в последующие дни уходит по завершении обсуждения.",
        ],
        [
          "Завершает ведущий",
          "Завершить можно полный или математически решённый подсчёт. Простого лидерства мало. Максимум голосов ведёт к уходу или перестрелке.",
        ],
      ],
      margin:
        "Спор о подсчёте приостанавливает голосование до решения судьи. Исправление записи не меняет физический голос игрока.",
    },
  },
  {
    id: "ties",
    art: "table",
    source: "Ties",
    en: {
      title: ["When the", "table divides."],
      name: "The tie",
      tag: "05 / ANOTHER CHANCE TO BE HEARD",
      plate: "Fig. V — A divided table",
      note: "Thirty seconds can change everything.",
      lede: "A tie is another conversation, not a coin toss.",
      rules: [
        [
          "Speak, then vote again",
          "The tied leaders each get 30 seconds. Hold a clean revote for those candidates only. If the tie shrinks, repeat for the smaller group.",
        ],
        [
          "An unchanged tie",
          "Eliminating all tied candidates requires more than half of eligible voters. Skip that ballot if every active player is tied.",
        ],
        [
          "Two special boundaries",
          "With nine active and three repeatedly tied, a lift needs completed game night three AND two actual Sheriff checks. A repeated five-way tie on round zero proceeds to night.",
        ],
      ],
      margin:
        "Evaluate a collective elimination together, then check victory — never one departing player at a time.",
    },
    ru: {
      title: ["Когда стол", "разделился."],
      name: "Перестрелка",
      tag: "05 / ЕЩЁ ОДИН ШАНС БЫТЬ УСЛЫШАННЫМ",
      plate: "Рис. V — Разделившийся стол",
      note: "Тридцать секунд могут изменить всё.",
      lede: "Равенство — новый разговор, не бросок монеты.",
      rules: [
        [
          "Речь и новый подсчёт",
          "Лидеры с равными голосами говорят по 30 секунд. Затем — чистое переголосование только по ним. Если круг сузился, процедура повторяется.",
        ],
        [
          "Состав не изменился",
          "Для подъёма всех нужно больше половины голосов. Если связаны равенством все активные игроки, подъём не проводят.",
        ],
        [
          "Особые границы",
          "При девяти активных и трёх связанных нужны и завершённая третья ночь, и две проверки Шерифа. Повторное равенство пяти на нулевом круге ведёт в ночь.",
        ],
      ],
      margin:
        "Коллективный уход оценивается целиком, и только затем проверяется победа — не после каждого игрока отдельно.",
    },
  },
  {
    id: "night",
    art: "night",
    source: "Night and private checks",
    en: {
      title: ["The city", "closes its eyes."],
      name: "Nightfall",
      tag: "06 / WHAT ONLY THE HOST KNOWS",
      plate: "Fig. VI — A quiet street, a hidden decision",
      note: "Keep the night’s information in the night.",
      lede: "Agreement matters. So does a well-kept secret.",
      rules: [
        [
          "One shared target",
          "Every eligible black-team shooter must agree. Missing, conflicting, or actual multiple shots mean a miss. An inactive target is not eliminated again.",
        ],
        [
          "Two different questions",
          "The Don asks whether a target is Sheriff. The Sheriff asks whether a target is red or black. Each ordinary check has a ten-second window.",
        ],
        [
          "Private means private",
          "Keep assignments and results host-only. Inactive targets may be checked; owners who left on a previous day or night cannot keep checking.",
        ],
      ],
      margin:
        "An eligible same-night victim may finish a check. But a deciding elimination ends play immediately, before any further check.",
    },
    ru: {
      title: ["Город", "закрывает глаза."],
      name: "Ночь",
      tag: "06 / ТО, ЧТО ЗНАЕТ ТОЛЬКО ВЕДУЩИЙ",
      plate: "Рис. VI — Тихая улица, тайное решение",
      note: "Пусть ночная информация остаётся ночной.",
      lede: "Важны и согласие, и умение хранить тайну.",
      rules: [
        [
          "Общая цель",
          "Все допущенные чёрные должны выбрать одну цель. Пропуск, разнобой или повторная физическая стрельба дают промах. Неактивная цель не выбывает снова.",
        ],
        [
          "Два разных вопроса",
          "Дон выясняет, является ли цель Шерифом. Шериф — красная она или чёрная. На каждую обычную проверку даётся десять секунд.",
        ],
        [
          "Тайна остаётся тайной",
          "Выстрелы и результаты видит ведущий. Неактивных проверять можно; ушедший ранее владелец роли больше не проверяет.",
        ],
      ],
      margin:
        "Допущенная жертва этой ночи может завершить проверку. Но решающее выбытие немедленно останавливает игру.",
    },
  },
  {
    id: "best-move",
    art: "cards",
    source: "Best Move",
    en: {
      title: ["One last", "good instinct."],
      name: "Best Move",
      tag: "07 / THREE PLAYERS, OR SKIP",
      plate: "Fig. VII — A thought left on the table",
      note: "Tap a card again to remove it from the selection.",
      lede: "The first shooting-night victim can leave a reading of the table.",
      rules: [
        [
          "A short night-time statement",
          "When eligible, the victim gets up to 20 seconds before morning and farewell. The option is unavailable after two or more first-day departures or a miss.",
        ],
        [
          "Select three other players",
          "Tap player cards to select or deselect them. Record Best Move becomes available when exactly three other players are selected and saves them immediately.",
        ],
        [
          "Record or skip",
          "Skip Best Move discards the selection without recording a result. Neither action needs a checkbox or extra confirmation; use Undo for corrections. The timer never advances automatically.",
        ],
      ],
      margin:
        "Best Move is enabled for standard new games, but is a club option. A decisive outcome takes precedence over it and any farewell.",
    },
    ru: {
      title: ["Последняя", "догадка."],
      name: "Лучший ход",
      tag: "07 / ТРИ ИГРОКА ИЛИ ПРОПУСК",
      plate: "Рис. VII — Мысль, оставленная за столом",
      note: "Повторное нажатие на карточку снимает выбор.",
      lede: "Жертва первой стрельбы может оставить своё видение стола.",
      rules: [
        [
          "Короткая речь ночью",
          "При наличии права даётся до 20 секунд до утра и прощальной речи. После двух уходов в первый день или промаха ЛХ недоступен.",
        ],
        [
          "Выберите трёх других игроков",
          "Нажимайте на карточки, чтобы выбрать игроков или снять выбор. Кнопка «Записать лучший ход» доступна только при выборе трёх других игроков и сразу сохраняет их.",
        ],
        [
          "Запишите или пропустите",
          "«Пропустить лучший ход» сбрасывает выбор без записи результата. Флажки и дополнительные подтверждения не нужны; для исправлений используйте отмену действия. Таймер не переключает этап автоматически.",
        ],
      ],
      margin:
        "ЛХ включён в новых стандартных играх, но остаётся клубной опцией. Решающий исход важнее ЛХ и прощальной речи.",
    },
  },
  {
    id: "discipline",
    art: "club",
    source: "Speeches, nominations and discipline; Night discipline",
    en: {
      title: ["The art of", "fair play."],
      name: "The judge’s notes",
      tag: "08 / A CLEAR BOUNDARY",
      plate: "Fig. VIII — The host keeps the rhythm",
      note: "Observe the moment. Record the rule.",
      lede: "The host guides the procedure. The judge observes the people.",
      rules: [
        [
          "Three fouls",
          "The next ordinary speech is lost, but nomination remains. With three or four players left, give 30 seconds instead. An already-started speech is not shortened.",
        ],
        [
          "Four fouls or disqualification",
          "Remove the player at the applicable boundary, without farewell. Removal may cancel the current or next eligible ballot — not a series of future ballots.",
        ],
        [
          "Respect the night sequence",
          "Observation, exclusion, departure and public announcement can happen at different moments. Complete required counts or eligible checks before announcing.",
        ],
      ],
      margin:
        "Software does not detect misconduct. The judge records the observed rule and timing without exposing private night information.",
    },
    ru: {
      title: ["Искусство", "честной игры."],
      name: "Записки судьи",
      tag: "08 / ЯСНАЯ ГРАНИЦА",
      plate: "Рис. VIII — Ведущий хранит ритм",
      note: "Заметьте момент. Укажите правило.",
      lede: "Ведущий ведёт процедуру. Судья наблюдает за людьми.",
      rules: [
        [
          "Три фола",
          "Следующая обычная речь пропускается, но выставление сохраняется. При трёх или четырёх игроках — 30 секунд. Начавшаяся речь не сокращается.",
        ],
        [
          "Четыре фола или удаление",
          "Игрок уходит в установленный момент без прощания. Удаление может отменить текущее или ближайшее допустимое голосование, но не цепочку будущих.",
        ],
        [
          "Ночная последовательность",
          "Нарушение, исключение, уход и объявление могут быть разнесены. Сначала завершите обязательный отсчёт или допустимую проверку.",
        ],
      ],
      margin:
        "Программа не выявляет нарушения. Судья фиксирует правило и момент, не раскрывая ночные секреты.",
    },
  },
  {
    id: "outcome",
    art: "night",
    source: "Outcomes and finalization; Setup and participants",
    en: {
      title: ["And then,", "the reveal."],
      name: "The final page",
      tag: "09 / EVERY SECRET HAS AN ENDING",
      plate: "Fig. IX — Until the city wakes again",
      note: "A decided game is not yet a finalized record.",
      lede: "The moment the balance is decided, the story stops.",
      rules: [
        [
          "Red or black",
          "Red wins when no active black players remain. Black wins when its active players equal or outnumber red. Stop immediately, before further checks or farewell.",
        ],
        [
          "An unchanged table",
          "Three consecutive completed game nights with no population change produce a rules draw. Planning counts; any intervening departure resets the streak.",
        ],
        [
          "Keep the record honest",
          "An outcome and Finish game are different. Permitted corrections remain possible until explicit finalization. Other draws or cancellation need a host reason.",
        ],
      ],
      margin:
        "Club options include virtual-Citizen Casper and disabling Best Move. Existing legacy games retain their original captured rules.",
    },
    ru: {
      title: ["И наконец —", "раскрытие."],
      name: "Последняя страница",
      tag: "09 / У КАЖДОЙ ТАЙНЫ ЕСТЬ КОНЕЦ",
      plate: "Рис. IX — Пока город не проснётся вновь",
      note: "Решённая игра — ещё не завершённая запись.",
      lede: "Как только исход определён, история останавливается.",
      rules: [
        [
          "Красные или чёрные",
          "Красные выигрывают без активных чёрных. Чёрные — при равенстве или превосходстве над красными. Игра останавливается до проверок и прощания.",
        ],
        [
          "Стол без изменений",
          "Три завершённые ночи подряд без изменения числа игроков дают ничью. Договорка считается; любой уход за этот период сбрасывает отсчёт.",
        ],
        [
          "Честная история",
          "Исход и «Завершить игру» — разные действия. До завершения остаются допустимые исправления. Иная ничья или отмена требуют причины.",
        ],
      ],
      margin:
        "Клубные опции: виртуальный Мирный Каспер и отключение ЛХ. Старые сохранённые игры сохраняют свои исходные правила.",
    },
  },
] as const satisfies readonly RulesChapter[];
