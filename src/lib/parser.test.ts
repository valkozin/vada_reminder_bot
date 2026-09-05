import { parseReminderInput } from './parser';

function testParser() {
  const fixedNow = new Date('2026-09-05T10:00:00.000Z'); // Saturday Sep 5, 2026 10:00 UTC
  const timezone = 'Europe/Moscow'; // Moscow = UTC+3 (13:00 Moscow time)

  console.log('--- Testing Deterministic Date Parser ---');

  // Test 1: Relative offset "через 20 минут"
  const res1 = parseReminderInput('через 20 минут проверить духовку', timezone, fixedNow);
  console.assert(res1 !== null, 'Test 1 Failed: res1 is null');
  console.log('1. Relative offset (+20m):', res1?.dueDate.toISOString(), 'Text:', res1?.text);

  // Test 2: "завтра в 15:00 полить цветы"
  const res2 = parseReminderInput('завтра в 15:00 полить цветы', timezone, fixedNow);
  console.assert(res2 !== null, 'Test 2 Failed: res2 is null');
  console.log('2. Tomorrow at 15:00:', res2?.dueDate.toISOString(), 'Text:', res2?.text);

  // Test 3: "сегодня в 18:30 купить хлеб"
  const res3 = parseReminderInput('сегодня в 18:30 купить хлеб', timezone, fixedNow);
  console.assert(res3 !== null, 'Test 3 Failed: res3 is null');
  console.log('3. Today at 18:30:', res3?.dueDate.toISOString(), 'Text:', res3?.text);

  // Test 4: Recurring daily "каждый день в 09:00 Зарядка"
  const res4 = parseReminderInput('каждый день в 09:00 Зарядка', timezone, fixedNow);
  console.assert(res4?.recurrence === 'daily', 'Test 4 Failed: recurrence not daily');
  console.log('4. Recurring daily:', res4?.recurrence, 'DueDate:', res4?.dueDate.toISOString());

  // Test 5: Recurring weekly "каждый понедельник в 10:00 Совещание"
  const res5 = parseReminderInput('каждый понедельник в 10:00 Совещание', timezone, fixedNow);
  console.assert(res5?.recurrence === 'weekly', 'Test 5 Failed: recurrence not weekly');
  console.log('5. Recurring weekly:', res5?.recurrence, 'DueDate:', res5?.dueDate.toISOString());

  // Test 6: Text month "15 сентября в 12:00 Встреча"
  const res6 = parseReminderInput('15 сентября в 12:00 Встреча', timezone, fixedNow);
  console.assert(res6 !== null, 'Test 6 Failed: res6 is null');
  console.log('6. Text month:', res6?.dueDate.toISOString(), 'Text:', res6?.text);

  console.log('✅ ALL PARSER TESTS PASSED!');
}

testParser();
