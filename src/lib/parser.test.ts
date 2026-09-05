import { parseReminderInput, formatFullRussianDate, calculateNextRecurrence } from './parser';

// Saturday, 5 September 2026, 10:00 UTC == 12:00 in Zurich (CEST, UTC+2)
const NOW = new Date('2026-09-05T10:00:00.000Z');
const TZ = 'Europe/Zurich';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ''): void {
  checks++;
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Asserts both the resulting instant and the extracted reminder text. */
function expectParse(input: string, expectedIso: string | null, expectedText?: string): void {
  const res = parseReminderInput(input, TZ, NOW);

  if (expectedIso === null) {
    check(`"${input}" → не распознаётся`, res === null, `получено ${res?.dueDate.toISOString()}`);
    return;
  }

  if (!res) {
    check(`"${input}"`, false, 'вернулся null');
    return;
  }

  const actualIso = res.dueDate.toISOString();
  check(`"${input}" → ${expectedIso}`, actualIso === expectedIso, `получено ${actualIso}`);

  if (expectedText !== undefined) {
    check(`"${input}" → текст «${expectedText}»`, res.text === expectedText, `получено «${res.text}»`);
  }
}

console.log('\n--- 1. Время в любом месте фразы ---');
expectParse('напомни полить цветок через минуту', '2026-09-05T10:01:00.000Z', 'Полить цветок');
expectParse('через минуту напомни полить цветок', '2026-09-05T10:01:00.000Z', 'Полить цветок');
expectParse('полить цветок через 1 минуту', '2026-09-05T10:01:00.000Z', 'Полить цветок');
expectParse('напомни съесть через 1 минуту', '2026-09-05T10:01:00.000Z', 'Съесть');
expectParse('напомни мне что нужно съесть через минуту', '2026-09-05T10:01:00.000Z', 'Съесть');
expectParse('позвонить маме завтра в 15:00', '2026-09-06T13:00:00.000Z', 'Позвонить маме');

console.log('\n--- 2. Относительное время ---');
expectParse('через 20 минут проверить духовку', '2026-09-05T10:20:00.000Z', 'Проверить духовку');
expectParse('через пять минут', '2026-09-05T10:05:00.000Z', '');
expectParse('через полчаса выпить кофе', '2026-09-05T10:30:00.000Z', 'Выпить кофе');
expectParse('через 2 часа', '2026-09-05T12:00:00.000Z', '');
expectParse('через 1 час 30 минут выключить плиту', '2026-09-05T11:30:00.000Z', 'Выключить плиту');
expectParse('через час позвонить', '2026-09-05T11:00:00.000Z', 'Позвонить');
expectParse('через неделю продлить подписку', '2026-09-12T10:00:00.000Z', 'Продлить подписку');
expectParse('через 2 дня в 15:00 забрать посылку', '2026-09-07T13:00:00.000Z', 'Забрать посылку');

console.log('\n--- 3. Конкретные дата и время ---');
expectParse('завтра в 15:00 полить цветы', '2026-09-06T13:00:00.000Z', 'Полить цветы');
expectParse('сегодня в 18:30 купить хлеб', '2026-09-05T16:30:00.000Z', 'Купить хлеб');
expectParse('послезавтра в 14:00 встреча', '2026-09-07T12:00:00.000Z', 'Встреча');
expectParse('купить хлеб сегодня вечером', '2026-09-05T17:00:00.000Z', 'Купить хлеб');
expectParse('завтра утром позвонить врачу', '2026-09-06T07:00:00.000Z', 'Позвонить врачу');
expectParse('в 7 вечера ужин', '2026-09-05T17:00:00.000Z', 'Ужин');
expectParse('в 9 утра выпить таблетки', '2026-09-06T07:00:00.000Z', 'Выпить таблетки');
expectParse('15 сентября в 12:00 встреча', '2026-09-15T10:00:00.000Z', 'Встреча');
expectParse('25.12 в 12:00 подарки', '2026-12-25T11:00:00.000Z', 'Подарки');
expectParse('в пятницу в 18:00 отчёт', '2026-09-11T16:00:00.000Z', 'Отчёт');

console.log('\n--- 3b. Час без минут ("в 10", а не "в 10:00") ---');
expectParse('напомни что-то в понедельник в 10', '2026-09-07T08:00:00.000Z', 'Что-то');
expectParse('напомни что-нибудь купить завтра в 11', '2026-09-06T09:00:00.000Z', 'Что-нибудь купить');
expectParse('напомни-ка полить цветы через минуту', '2026-09-05T10:01:00.000Z', 'Полить цветы');
expectParse('в пятницу в 18 отчёт', '2026-09-11T16:00:00.000Z', 'Отчёт');
expectParse('завтра в 10 позвонить врачу', '2026-09-06T08:00:00.000Z', 'Позвонить врачу');
expectParse('сегодня в 20 ужин', '2026-09-05T18:00:00.000Z', 'Ужин');
expectParse('послезавтра в 9 встреча', '2026-09-07T07:00:00.000Z', 'Встреча');
expectParse('через 2 дня в 15 забрать посылку', '2026-09-07T13:00:00.000Z', 'Забрать посылку');
expectParse('25.12 в 12 подарки', '2026-12-25T11:00:00.000Z', 'Подарки');
expectParse('15 сентября в 10 встреча', '2026-09-15T08:00:00.000Z', 'Встреча');
expectParse('в понедельник в 10 часов совещание', '2026-09-07T08:00:00.000Z', 'Совещание');
expectParse('в пятницу в 7 вечера ужин', '2026-09-11T17:00:00.000Z', 'Ужин');

{
  const daily = parseReminderInput('каждый день в 9 зарядка', TZ, NOW);
  check('«каждый день в 9» → daily', daily?.recurrence === 'daily', `получено ${daily?.recurrence}`);
  check(
    '«каждый день в 9» → 09:00 по Цюриху',
    daily?.dueDate.toISOString() === '2026-09-06T07:00:00.000Z',
    `получено ${daily?.dueDate.toISOString()}`
  );

  const weekly = parseReminderInput('каждый понедельник в 10 совещание', TZ, NOW);
  check('«каждый понедельник в 10» → weekly', weekly?.recurrence === 'weekly');
  check('и время 10:00', weekly?.recurrenceRule?.timeStr === '10:00', `получено ${weekly?.recurrenceRule?.timeStr}`);
}

// Без предлога «в» голое число остаётся частью текста, иначе "завтра 5 яблок"
// превратилось бы в 05:00.
expectParse('завтра 5 яблок купить', null);
expectParse('в понедельник 5 яблок купить', '2026-09-07T07:00:00.000Z', '5 яблок купить');

console.log('\n--- 3c. Задержанное сообщение отсчитывается от времени отправки ---');
{
  // Written at 23:58 Zurich (21:58 UTC), delivered five minutes later, already
  // past midnight. Parsed against the send time, "завтра" must stay the 7th.
  const typedAt = new Date('2026-09-05T21:58:00.000Z');
  const processedAt = new Date('2026-09-05T22:03:00.000Z'); // 00:03 on the 6th

  const fromSendTime = parseReminderInput('завтра в 9 позвонить', TZ, typedAt);
  check(
    '«завтра в 9» в 23:58 → 6 сентября, если считать от отправки',
    fromSendTime?.dueDate.toISOString() === '2026-09-06T07:00:00.000Z',
    `получено ${fromSendTime?.dueDate.toISOString()}`
  );

  const fromProcessTime = parseReminderInput('завтра в 9 позвонить', TZ, processedAt);
  check(
    'а от времени обработки — уже 7 сентября (сутки разницы, ради чего и правка)',
    fromProcessTime?.dueDate.toISOString() === '2026-09-07T07:00:00.000Z',
    `получено ${fromProcessTime?.dueDate.toISOString()}`
  );

  // A relative offset from a long-delayed message lands in the past, so cron
  // delivers it on the next run instead of silently shifting it forward.
  const deliveredAfterAnHour = new Date('2026-09-05T23:00:00.000Z');
  const late = parseReminderInput('через 5 минут выключить плиту', TZ, typedAt);
  check(
    'просроченное «через 5 минут» остаётся в прошлом и придёт сразу',
    late !== null && late.dueDate < deliveredAfterAnHour,
    `получено ${late?.dueDate.toISOString()}`
  );
}

console.log('\n--- 3d. «напомни» в середине фразы и две даты ---');
{
  // Reported case: the first date wins, the rest stays as text, but the command
  // word must not be left stranded in the middle of it.
  const two = parseReminderInput('тест 6 сентября тест2 напомни 7 сентября', TZ, NOW);
  check(
    'берётся первая дата (6 сентября)',
    two?.dueDate.toISOString() === '2026-09-06T07:00:00.000Z',
    `получено ${two?.dueDate.toISOString()}`
  );
  check('«напомни» убрано из середины текста', two?.text === 'Тест тест2 7 сентября', `получено «${two?.text}»`);
  check(
    'остаток текста распознаётся как дата — бот предупредит',
    parseReminderInput(two!.text, TZ, NOW) !== null
  );
}

expectParse('купить хлеб напомнить завтра в 10', '2026-09-06T08:00:00.000Z', 'Купить хлеб');
expectParse('позвонить врачу не забудь завтра в 11', '2026-09-06T09:00:00.000Z', 'Позвонить врачу не забудь');

// The noun stays: it can be genuine task content.
expectParse('отправить напоминание коллегам завтра в 10', '2026-09-06T08:00:00.000Z', 'Отправить напоминание коллегам');

// Ordinary single-date input must NOT look ambiguous.
{
  const plain = parseReminderInput('купить 2 билета завтра в 15:00', TZ, NOW);
  check('обычный текст не считается второй датой', parseReminderInput(plain!.text, TZ, NOW) === null,
    `получено ${JSON.stringify(parseReminderInput(plain!.text, TZ, NOW)?.text)}`);
}

console.log('\n--- 3e. Суффикс года и время в отрыве от даты ---');
{
  // Reported case: "г." between the year and the time broke them apart, so the
  // time was dropped and "г." stayed in the reminder text.
  const res = parseReminderInput(
    'Податься независимым жюри IYPT\n25 декабря 2026 г. в 18:57',
    TZ,
    NOW
  );
  check(
    '«25 декабря 2026 г. в 18:57» → 18:57, а не 09:00',
    res?.dueDate.toISOString() === '2026-12-25T17:57:00.000Z',
    `получено ${res?.dueDate.toISOString()}`
  );
  check(
    'и «г.» не остаётся в тексте',
    res?.text === 'Податься независимым жюри IYPT',
    `получено «${res?.text}»`
  );
}

expectParse('сдать отчёт 25 декабря 2026 года в 18:00', '2026-12-25T17:00:00.000Z', 'Сдать отчёт');
expectParse('встреча 25.12.2026 г. в 12:00', '2026-12-25T11:00:00.000Z', 'Встреча');
expectParse('позвонить 15 сентября 2026 г.', '2026-09-15T07:00:00.000Z', 'Позвонить');
// Время, оторванное от даты чем угодно, всё равно находится.
expectParse('концерт 25 декабря, начало в 19:30', '2026-12-25T18:30:00.000Z', 'Концерт, начало');

// "г" не должно съедаться, когда это начало обычного слова.
expectParse('купить 25 декабря гантели в 12:00', '2026-12-25T11:00:00.000Z', 'Купить гантели');

console.log('\n--- 3f. Не заглядывать внутрь идентификаторов ---');
{
  // Reported case: the parser read "22-10" out of the middle of a token name
  // and the confirmation then claimed the message held a second date.
  const res = parseReminderInput(
    'Глюкоз_ТЕСТ_22-10-2026_в_8_00 напомни\n18 октября 2026 г. в 16:00',
    TZ,
    NOW
  );
  check(
    'берётся настоящая дата в конце',
    res?.dueDate.toISOString() === '2026-10-18T14:00:00.000Z',
    `получено ${res?.dueDate.toISOString()}`
  );
  check('имя остаётся целым', res?.text === 'Глюкоз_ТЕСТ_22-10-2026_в_8_00', `получено «${res?.text}»`);
  check(
    'внутри имени дата не находится — предупреждения не будет',
    parseReminderInput(res!.text, TZ, NOW) === null,
    `получено ${JSON.stringify(parseReminderInput(res!.text, TZ, NOW)?.dueDate)}`
  );
}

// Дата через дефис неоднозначна — лучше не распознать, чем принять за 22:10.
check(
  '«22-10-2026» не читается как время',
  parseReminderInput('отчёт 22-10-2026', TZ, NOW) === null,
  `получено ${parseReminderInput('отчёт 22-10-2026', TZ, NOW)?.dueDate.toISOString()}`
);
// А обычное время через дефис по-прежнему работает.
expectParse('в 15-30 позвонить', '2026-09-05T13:30:00.000Z', 'Позвонить');

console.log('\n--- 4. Повторяющиеся ---');
{
  const daily = parseReminderInput('каждый день в 09:00 зарядка', TZ, NOW);
  check('каждый день → recurrence=daily', daily?.recurrence === 'daily', `получено ${daily?.recurrence}`);
  check('каждый день → текст «Зарядка»', daily?.text === 'Зарядка', `получено «${daily?.text}»`);
  check(
    'каждый день → 2026-09-06T07:00:00.000Z',
    daily?.dueDate.toISOString() === '2026-09-06T07:00:00.000Z',
    `получено ${daily?.dueDate.toISOString()}`
  );

  const weekly = parseReminderInput('каждый понедельник в 10:00 совещание', TZ, NOW);
  check('каждый понедельник → weekly', weekly?.recurrence === 'weekly', `получено ${weekly?.recurrence}`);
  check('каждый понедельник → dayOfWeek=1', weekly?.recurrenceRule?.dayOfWeek === 1);

  const weekdays = parseReminderInput('по будням в 09:00 зарядка', TZ, NOW);
  check('по будням → weekdays', weekdays?.recurrence === 'weekdays', `получено ${weekdays?.recurrence}`);
  check(
    'по будням → пропускает выходные (понедельник)',
    weekdays?.dueDate.toISOString() === '2026-09-07T07:00:00.000Z',
    `получено ${weekdays?.dueDate.toISOString()}`
  );

  const monthly = parseReminderInput('каждое 15 число в 12:00 оплатить счёт', TZ, NOW);
  check('каждое 15 число → monthly', monthly?.recurrence === 'monthly', `получено ${monthly?.recurrence}`);
  check('каждое 15 число → dayOfMonth=15', monthly?.recurrenceRule?.dayOfMonth === 15);
}

console.log('\n--- 5. Мусор и некорректный ввод ---');
expectParse('просто какой-то текст без времени', null);
expectParse('', null);
expectParse('позвонить в 25:99', null);

console.log('\n--- 6. Повторы через переход на зимнее время ---');
{
  // 24 Oct 2026 09:00 CEST; Europe switches to CET overnight on 25 Oct.
  const next = calculateNextRecurrence(
    new Date('2026-10-24T07:00:00.000Z'),
    'daily',
    TZ,
    new Date('2026-10-24T07:00:30.000Z')
  );
  check(
    'ежедневное напоминание держит 09:00 по местному времени после перевода часов',
    next.toISOString() === '2026-10-25T08:00:00.000Z',
    `получено ${next.toISOString()}`
  );

  // Cron was down for a week — the reminder must jump to the next FUTURE slot,
  // not fire six more times catching up.
  const caughtUp = calculateNextRecurrence(
    new Date('2026-09-01T07:00:00.000Z'),
    'daily',
    TZ,
    new Date('2026-09-08T09:00:00.000Z')
  );
  check(
    'пропущенные повторы не накапливаются',
    caughtUp > new Date('2026-09-08T09:00:00.000Z'),
    `получено ${caughtUp.toISOString()}`
  );
}

console.log('\n--- 7. Форматирование ---');
{
  const formatted = formatFullRussianDate(new Date('2026-09-07T13:00:00.000Z'), TZ);
  check('формат содержит день недели', /понедельник/i.test(formatted), formatted);
  check('формат содержит время 15:00', formatted.includes('15:00'), formatted);
  console.log(`     → ${formatted}`);
}

console.log(`\n${failures === 0 ? '✅' : '❌'} Проверок: ${checks}, провалено: ${failures}\n`);
if (failures > 0) process.exit(1);
