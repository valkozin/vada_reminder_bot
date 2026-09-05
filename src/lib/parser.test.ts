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
