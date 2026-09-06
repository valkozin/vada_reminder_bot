import { randomBytes } from 'node:crypto';

// Default configuration under test: no ENCRYPTION_KEY at all, only a bot token.
// This is what a user gets with zero key management.
delete process.env.ENCRYPTION_KEY;
const TEST_BOT_TOKEN = '7123456789:AAFtest-token-used-only-by-the-test-suite';
process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

// Both modules read their configuration lazily, on first use — never at import
// time — so setting the environment above is enough.
import {
  encryptForUser,
  decryptForUser,
  isCiphertext,
  isEncryptionEnabled,
  getEncryptionStatus,
  exportMasterKey,
} from './crypto';
import * as db from './db';

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

const ALICE = 111111;
const BOB = 222222;

function makeReminder(id: string, userId: number, text: string, dueDate: string) {
  return {
    id,
    userId,
    chatId: userId,
    text,
    dueDate,
    timezone: 'Europe/Zurich',
    recurrence: 'none' as const,
    status: 'active' as const,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------

async function main() {
console.log('\n--- 1. Шифрование ---');
{
  check('шифрование работает без ENCRYPTION_KEY, только с токеном бота', isEncryptionEnabled());
  check('ключ выведен из токена бота', getEncryptionStatus().source === 'TELEGRAM_BOT_TOKEN');

  const secret = 'Купить подарок жене 🎁 <b>не спойлерить</b>';
  const blob = encryptForUser(ALICE, secret, 'rem_1');

  check('шифротекст не содержит исходный текст', !blob.includes('подарок'), blob.slice(0, 40));
  check('шифротекст опознаётся', isCiphertext(blob));
  check('расшифровка возвращает оригинал', decryptForUser(ALICE, blob, 'rem_1') === secret);

  const blob2 = encryptForUser(ALICE, secret, 'rem_1');
  check('один и тот же текст даёт разные шифротексты (случайный IV)', blob !== blob2);
  check('оба варианта расшифровываются одинаково', decryptForUser(ALICE, blob2, 'rem_1') === secret);
}

console.log('\n--- 2. Изоляция пользователей на уровне криптографии ---');
{
  const aliceBlob = encryptForUser(ALICE, 'Секрет Алисы', 'rem_a');

  check('чужой пользователь не может расшифровать', decryptForUser(BOB, aliceBlob, 'rem_a') === null);
  check(
    'подстановка блоба в другое напоминание не проходит',
    decryptForUser(ALICE, aliceBlob, 'rem_other') === null
  );

  const parts = aliceBlob.split('.');
  const tampered = [...parts.slice(0, 4), Buffer.from('подмена').toString('base64url')].join('.');
  check('подмена шифротекста отвергается', decryptForUser(ALICE, tampered, 'rem_a') === null);

  const tamperedTag = [...parts.slice(0, 3), Buffer.from(randomBytes(16)).toString('base64url'), parts[4]].join('.');
  check('подмена тега целостности отвергается', decryptForUser(ALICE, tamperedTag, 'rem_a') === null);

  check('устаревший открытый текст читается как есть', decryptForUser(ALICE, 'старый текст', 'rem_a') === 'старый текст');
}

console.log('\n--- 3. Несколько пользователей в общем хранилище ---');
{
  await db.saveReminder(makeReminder('rem_alice_1', ALICE, 'Полить цветы', '2030-01-01T10:00:00.000Z'));
  await db.saveReminder(makeReminder('rem_alice_2', ALICE, 'Забрать посылку', '2030-01-02T10:00:00.000Z'));
  await db.saveReminder(makeReminder('rem_bob_1', BOB, 'Купить молоко', '2030-01-01T11:00:00.000Z'));

  const aliceList = await db.getUserReminders(ALICE);
  const bobList = await db.getUserReminders(BOB);

  check('Алиса видит только свои 2 напоминания', aliceList.length === 2, `получено ${aliceList.length}`);
  check('Боб видит только своё 1 напоминание', bobList.length === 1, `получено ${bobList.length}`);
  check('текст Алисы расшифрован корректно', aliceList[0].text === 'Полить цветы', aliceList[0].text);
  check('текст Боба расшифрован корректно', bobList[0].text === 'Купить молоко', bobList[0].text);
  check(
    'списки отсортированы по времени',
    new Date(aliceList[0].dueDate) < new Date(aliceList[1].dueDate)
  );
}

console.log('\n--- 4. Чужие кнопки не работают ---');
{
  check('Боб не может прочитать напоминание Алисы', (await db.getOwnedReminder('rem_alice_1', BOB)) === null);
  check('Алиса может прочитать своё', (await db.getOwnedReminder('rem_alice_1', ALICE)) !== null);
  check('Боб не может удалить напоминание Алисы', (await db.deleteReminder('rem_alice_1', BOB)) === false);

  const stillThere = await db.getUserReminders(ALICE);
  check('напоминание Алисы уцелело после чужой попытки удаления', stillThere.length === 2);
  check('Алиса может удалить своё', (await db.deleteReminder('rem_alice_2', ALICE)) === true);
  check('после удаления осталось одно', (await db.getUserReminders(ALICE)).length === 1);
}

console.log('\n--- 5. Двойная доставка и повторные апдейты ---');
{
  const due = '2030-01-01T10:00:00.000Z';
  check('первый cron-запуск забирает напоминание', (await db.claimDelivery('rem_alice_1', due)) === true);
  check('параллельный запуск его уже не получит', (await db.claimDelivery('rem_alice_1', due)) === false);

  await db.releaseDelivery('rem_alice_1', due);
  check('после сбоя доставка снова доступна для повтора', (await db.claimDelivery('rem_alice_1', due)) === true);

  const otherDue = '2030-01-01T12:00:00.000Z';
  check('перенесённое на другое время можно доставить снова', (await db.claimDelivery('rem_alice_1', otherDue)) === true);

  check('первый приход апдейта принимается', (await db.claimUpdate(9001)) === true);
  check('повторная доставка того же апдейта отбрасывается', (await db.claimUpdate(9001)) === false);
  await db.releaseUpdate(9001);
  check('после ошибки обработки апдейт можно повторить', (await db.claimUpdate(9001)) === true);
}

console.log('\n--- 6. Пользователь заблокировал и вернул бота ---');
{
  await db.saveReminder(makeReminder('rem_bob_2', BOB, 'Оплатить счёт', '2020-01-01T10:00:00.000Z'));

  await db.pauseReminder('rem_bob_1', 'bot was blocked by the user');
  await db.pauseReminder('rem_bob_2', 'bot was blocked by the user');

  const active = await db.getAllActiveReminders();
  check(
    'приостановленные не попадают в очередь доставки',
    !active.some((r) => r.id === 'rem_bob_1' || r.id === 'rem_bob_2')
  );

  const bobList = await db.getUserReminders(BOB);
  check('но остаются видны пользователю в /list', bobList.length === 2, `получено ${bobList.length}`);
  check('и помечены как приостановленные', bobList.every((r) => r.status === 'paused'));
  check('текст приостановленного всё ещё читается', bobList.some((r) => r.text === 'Купить молоко'));

  const { restored, overdue } = await db.resumeUserReminders(BOB);
  check('после /start восстановлены оба', restored === 2, `получено ${restored}`);
  check('просроченное распознано', overdue === 1, `получено ${overdue}`);

  const activeAfter = await db.getAllActiveReminders();
  check(
    'восстановленные вернулись в очередь доставки',
    activeAfter.filter((r) => r.userId === BOB).length === 2
  );
  check(
    'текст после восстановления не потерян',
    (await db.getUserReminders(BOB)).some((r) => r.text === 'Оплатить счёт')
  );
}

console.log('\n--- 7. Сработавшие напоминания ---');
{
  await db.markReminderFired('rem_bob_1');

  const active = await db.getAllActiveReminders();
  check('сработавшее ушло из очереди', !active.some((r) => r.id === 'rem_bob_1'));
  check('и пропало из /list', !(await db.getUserReminders(BOB)).some((r) => r.id === 'rem_bob_1'));
  check(
    'но кнопки «отложить» на старом сообщении ещё работают',
    (await db.getOwnedReminder('rem_bob_1', BOB)) !== null
  );
}

console.log('\n--- 8. Ожидаемое действие (редактирование из списка) ---');
{
  const future = new Date(Date.now() + 3600_000).toISOString();
  await db.saveReminder(makeReminder('rem_pending', ALICE, 'Старый текст', future));

  check('без запроса нет ожидаемого действия', (await db.getPendingAction(ALICE)) === null);

  await db.setPendingAction(ALICE, 'text', 'rem_pending');
  const textPending = await db.getPendingAction(ALICE);
  check('запомнено изменение текста', textPending?.kind === 'text');
  check('и правильный id напоминания', textPending?.reminderId === 'rem_pending');

  await db.setPendingAction(ALICE, 'time', 'rem_pending');
  const timePending = await db.getPendingAction(ALICE);
  check('запомнено изменение времени', timePending?.kind === 'time');

  // Editing the text must not disturb the schedule, and vice versa.
  const before = await db.getOwnedReminder('rem_pending', ALICE);
  await db.saveReminder({ ...before!, text: 'Новый текст' });
  const after = await db.getOwnedReminder('rem_pending', ALICE);
  check('текст изменён', after?.text === 'Новый текст');
  check('время не тронуто', after?.dueDate === before?.dueDate);
  check('после правки текста напоминание осталось в очереди', after?.status === 'active');
  check('чужой пользователь не видит отредактированное', (await db.getOwnedReminder('rem_pending', BOB)) === null);

  check('чужое ожидаемое действие не видно', (await db.getPendingAction(BOB)) === null);

  await db.clearPendingAction(ALICE);
  check('отмена сбрасывает действие', (await db.getPendingAction(ALICE)) === null);
}

console.log('\n--- 9. Смена источника ключа ---');
{
  const secret = 'Написанное на старом ключе';
  const oldBlob = encryptForUser(ALICE, secret, 'rem_rotate');
  const derivedKey = exportMasterKey();

  // The user later pins the derived key explicitly, exactly as /api/setup
  // suggests before rotating the bot token.
  process.env.ENCRYPTION_KEY = derivedKey!;
  check('явный ключ становится основным', getEncryptionStatus().source === 'ENCRYPTION_KEY');
  check('зафиксированный ключ читает старые записи', decryptForUser(ALICE, oldBlob, 'rem_rotate') === secret);

  // A different explicit key: old records must still open via the token-derived
  // fallback, and new ones are written with the new primary key.
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
  check('новый ключ активен', getEncryptionStatus().source === 'ENCRYPTION_KEY');
  check('есть запасной ключ из токена', getEncryptionStatus().fallbackKeys === 1);
  check(
    'старые записи всё ещё читаются через запасной ключ',
    decryptForUser(ALICE, oldBlob, 'rem_rotate') === secret
  );

  const newBlob = encryptForUser(ALICE, 'Написанное на новом ключе', 'rem_rotate2');
  check('новые записи пишутся новым ключом', newBlob.split('.')[1] === getEncryptionStatus().keyId);
  check(
    'и читаются',
    decryptForUser(ALICE, newBlob, 'rem_rotate2') === 'Написанное на новом ключе'
  );

  // Losing every key means the data is genuinely unrecoverable — verify that we
  // fail loudly rather than returning garbage.
  delete process.env.ENCRYPTION_KEY;
  process.env.TELEGRAM_BOT_TOKEN = '7123456789:AAF-a-completely-different-bot-token';
  check('при полной потере ключей расшифровка честно падает', decryptForUser(ALICE, oldBlob, 'rem_rotate') === null);
}

const { createHmac } = await import('node:crypto');

/** Signs initData exactly the way Telegram does. */
function sign(fields: Record<string, string>, withToken = process.env.TELEGRAM_BOT_TOKEN!): string {
  const checkString = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(withToken).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** A freshly signed launch for one user, as Telegram would produce it. */
function launchFor(userId: number): string {
  return sign({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: `U${userId}` }),
  });
}

console.log('\n--- 9. Авторизация мини-приложения ---');
{
  const { verifyInitData, isUserAllowed } = await import('./webapp-auth');

  const nowSeconds = Math.floor(Date.now() / 1000);
  const aliceFields = {
    auth_date: String(nowSeconds),
    query_id: 'AAH123',
    user: JSON.stringify({ id: ALICE, first_name: 'Алиса' }),
  };

  const valid = sign(aliceFields);
  check('корректная подпись принимается', verifyInitData(valid)?.id === ALICE);

  // Someone who does not hold the bot token cannot forge a launch.
  const forged = sign(aliceFields, '7123456789:AAF-attacker-does-not-have-the-real-token');
  check('подпись чужим токеном отвергается', verifyInitData(forged) === null);

  // Swapping the user id after signing must invalidate the whole payload.
  const swapped = new URLSearchParams(valid);
  swapped.set('user', JSON.stringify({ id: BOB, first_name: 'Боб' }));
  check('подмена user id отвергается', verifyInitData(swapped.toString()) === null);

  const noHash = new URLSearchParams(valid);
  noHash.delete('hash');
  check('без подписи отвергается', verifyInitData(noHash.toString()) === null);
  check('пустая строка отвергается', verifyInitData('') === null);

  // An old launch must not stay usable forever.
  const stale = sign({ ...aliceFields, auth_date: String(nowSeconds - 60 * 60 * 48) });
  check('устаревший запуск отвергается', verifyInitData(stale) === null);

  // A future auth_date is a forgery attempt, not clock skew.
  const future = sign({ ...aliceFields, auth_date: String(nowSeconds + 3600) });
  check('дата запуска из будущего отвергается', verifyInitData(future) === null);

  // Small skew is tolerated, otherwise honest users get locked out.
  const skewed = sign({ ...aliceFields, auth_date: String(nowSeconds - 30) });
  check('небольшой сдвиг часов допускается', verifyInitData(skewed)?.id === ALICE);

  // The Mini App must not become a way around the allow-list.
  process.env.TELEGRAM_ALLOWED_USER_IDS = String(ALICE);
  check('разрешённый пользователь проходит', isUserAllowed(ALICE));
  check('посторонний не проходит', !isUserAllowed(BOB));
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  check('без списка пускает всех', isUserAllowed(BOB));
}

console.log('\n--- 10. API мини-приложения: чтение, правка, удаление ---');
{
  // Section 8 left a rotated token behind; restore it so the records written
  // by earlier sections are readable again.
  process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;

  const { NextRequest } = await import('next/server');
  const route = await import('../app/api/reminders/route');

  interface ApiReminder {
    id: string;
    text: string;
    dueLabel: string;
    dueDate: string;
  }

  /** Earlier sections leave data in the store, so assert on this id, not counts. */
  const findOwn = (payload: { reminders: ApiReminder[] }): ApiReminder | undefined =>
    payload.reminders.find((r) => r.id === 'rem_app_1');

  function request(method: string, initData: string, opts: { body?: unknown; query?: string } = {}) {
    return new NextRequest(`http://localhost/api/reminders${opts.query ?? ''}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': initData },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  const alice = launchFor(ALICE);
  const bob = launchFor(BOB);

  await db.saveReminder({
    id: 'rem_app_1',
    userId: ALICE,
    chatId: ALICE,
    text: 'Позвонить врачу',
    dueDate: new Date('2026-12-24T09:00:00.000Z').toISOString(),
    timezone: 'Europe/Zurich',
    recurrence: 'none',
    status: 'active',
    createdAt: new Date().toISOString(),
  });

  const mine = findOwn(await (await route.GET(request('GET', alice))).json());
  check('владелец видит своё напоминание', mine !== undefined);
  check('текст расшифрован для владельца', mine?.text === 'Позвонить врачу', mine?.text);
  check('дата отдаётся человекочитаемо', /декабря/.test(mine?.dueLabel ?? ''), mine?.dueLabel);

  check(
    'чужой не видит его в своём списке',
    findOwn(await (await route.GET(request('GET', bob))).json()) === undefined
  );

  // Knowing the id is not enough: ownership is re-checked in storage.
  const bobEdit = await route.PATCH(request('PATCH', bob, { body: { id: 'rem_app_1', text: 'Взлом' } }));
  check('чужой не может отредактировать', bobEdit.status === 404);

  const bobDelete = await route.DELETE(request('DELETE', bob, { query: '?id=rem_app_1' }));
  check('чужой не может удалить', bobDelete.status === 404);
  check('напоминание на месте', (await db.getReminder('rem_app_1'))?.text === 'Позвонить врачу');

  const edit = await route.PATCH(
    request('PATCH', alice, { body: { id: 'rem_app_1', text: 'Позвонить стоматологу', dueLocal: '2026-12-24T18:30' } })
  );
  const edited = await edit.json();
  check('владелец меняет текст', edited.reminder?.text === 'Позвонить стоматологу');
  check('владелец меняет время', edited.reminder?.dueLabel.includes('18:30'), edited.reminder?.dueLabel);
  check(
    'время истолковано в зоне пользователя (17:30 UTC)',
    edited.reminder?.dueDate === '2026-12-24T17:30:00.000Z',
    edited.reminder?.dueDate
  );

  const stored = await db.getReminder('rem_app_1');
  check('правка сохранилась в базе', stored?.text === 'Позвонить стоматологу');

  const empty = await route.PATCH(request('PATCH', alice, { body: { id: 'rem_app_1', text: '   ' } }));
  check('пустой текст отклоняется', empty.status === 400);

  const badDate = await route.PATCH(
    request('PATCH', alice, { body: { id: 'rem_app_1', dueLocal: 'завтра' } })
  );
  check('некорректная дата отклоняется', badDate.status === 400);

  const gone = await route.DELETE(request('DELETE', alice, { query: '?id=rem_app_1' }));
  check('владелец удаляет', gone.status === 200);
  check('и оно исчезает из списка', findOwn(await (await route.GET(request('GET', alice))).json()) === undefined);
}

console.log(`\n${failures === 0 ? '✅' : '❌'} Проверок: ${checks}, провалено: ${failures}\n`);
if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
