import { Bot, Context, InlineKeyboard, Keyboard, GrammyError, HttpError } from 'grammy';
import { parseReminderInput, formatFullRussianDate, formatTimeUntil } from './parser';
import {
  getUserTimezone,
  setUserTimezone,
  saveReminder,
  getUserReminders,
  deleteReminder,
  deleteAllUserReminders,
  getOwnedReminder,
  resumeUserReminders,
  setPendingAction,
  getPendingAction,
  clearPendingAction,
} from './db';
import { Reminder } from './types';
import {
  DEFAULT_TIMEZONE,
  EUROPEAN_TIMEZONES,
  isValidTimezone,
  getUtcOffsetLabel,
  getLocalTimeLabel,
} from './timezones';
import { addMinutes } from 'date-fns';

const token = process.env.TELEGRAM_BOT_TOKEN || 'dummy_token_for_build';
export const bot = new Bot(token);

// ---------------------------------------------------------------------------
// Formatting helpers
//
// Messages are sent as HTML rather than Markdown: reminder text is written by
// the user and a stray "*" or "_" makes Telegram reject the whole message,
// which used to silently swallow reminders.
// ---------------------------------------------------------------------------

/** Escapes the three characters that are special in Telegram HTML mode. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HTML = { parse_mode: 'HTML' as const };

const RECURRENCE_LABELS: Record<string, string> = {
  none: '',
  daily: 'каждый день',
  weekdays: 'по будням',
  weekly: 'каждую неделю',
  monthly: 'каждый месяц',
};

// ---------------------------------------------------------------------------
// Persistent keyboard shown under the message input
// ---------------------------------------------------------------------------

const BTN_LIST = '📋 Мои напоминания';
const BTN_TIMEZONE = '🌍 Часовой пояс';
const BTN_HELP = '❓ Помощь';

const mainKeyboard = new Keyboard()
  .text(BTN_LIST)
  .row()
  .text(BTN_TIMEZONE)
  .text(BTN_HELP)
  .resized()
  .persistent();

/** Buttons attached to a single reminder (creation, snooze, delivery). */
function reminderKeyboard(reminderId: string, includeSnooze = true): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (includeSnooze) {
    keyboard
      .text('⏰ +15 мин', `snz:${reminderId}:15`)
      .text('⏰ +1 час', `snz:${reminderId}:60`)
      .row()
      .text('⏰ +3 часа', `snz:${reminderId}:180`)
      .text('📅 Завтра', `snz:${reminderId}:1440`)
      .row();
  }
  keyboard.text('✍️ Другое время', `resched:${reminderId}`).text('✅ Готово', `del:${reminderId}`);
  return keyboard;
}

// ---------------------------------------------------------------------------
// Command menu (the "/" button inside Telegram)
// ---------------------------------------------------------------------------

const BOT_COMMANDS = [
  { command: 'list', description: '📋 Мои напоминания' },
  { command: 'tz', description: '🌍 Часовой пояс' },
  { command: 'help', description: '❓ Справка и примеры' },
  { command: 'cancel', description: '❌ Отменить текущее действие' },
  { command: 'clear', description: '🗑 Удалить все напоминания' },
  { command: 'start', description: '🔄 Начать заново' },
];

let commandsRegistered = false;

/** Registers the command menu once per serverless instance (cheap, idempotent). */
export async function ensureBotCommands(force = false): Promise<void> {
  if (commandsRegistered && !force) return;
  commandsRegistered = true;
  try {
    await bot.api.setMyCommands(BOT_COMMANDS);
  } catch (err) {
    commandsRegistered = false;
    console.error('Failed to register bot commands:', err);
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

bot.use(async (ctx, next) => {
  const allowedIdsStr = process.env.TELEGRAM_ALLOWED_USER_IDS;
  if (allowedIdsStr && ctx.from) {
    const allowedIds = allowedIdsStr
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => Number.isFinite(id));

    if (allowedIds.length > 0 && !allowedIds.includes(ctx.from.id)) {
      await ctx.reply('⛔ Доступ ограничен. Вы не авторизованы для использования этого бота.');
      return;
    }
  }
  await next();
});

/** Update ids whose handler threw — read by the webhook route to release the claim. */
export const failedUpdates = new Set<number>();

// Errors must not escape to the webhook handler: an unhandled throw would make
// Telegram redeliver the same update in a loop. Instead we log it, remember it,
// and — crucially — tell the user, so a failed save is never silent.
bot.catch(async (err) => {
  const ctx = err.ctx;
  const updateId = ctx.update.update_id;
  failedUpdates.add(updateId);

  console.error(`Error while handling update ${updateId}:`, err.error);

  if (err.error instanceof GrammyError) {
    console.error('Telegram API error:', err.error.description);
    // The failure was Telegram rejecting our message — another message would
    // fail the same way (blocked bot, bad chat), so do not try.
    return;
  }
  if (err.error instanceof HttpError) {
    console.error('Could not reach Telegram:', err.error);
    return;
  }

  try {
    await ctx.reply(
      '⚠️ Не удалось выполнить операцию — база данных временно недоступна.\n\n' +
        'Напоминание <b>не сохранено</b>. Пожалуйста, отправьте сообщение ещё раз через минуту.',
      HTML
    );
  } catch (notifyError) {
    console.error('Could not notify the user about the failure:', notifyError);
  }
});

// ---------------------------------------------------------------------------
// Shared handlers (reused by both slash commands and keyboard buttons)
// ---------------------------------------------------------------------------

async function sendWelcome(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const tz = await getUserTimezone(userId);

  // If delivery previously failed (bot blocked, chat deleted), the reminders
  // were parked rather than dropped. Coming back with /start restores them.
  const { restored, overdue } = await resumeUserReminders(userId);
  if (restored > 0) {
    await ctx.reply(
      `♻️ <b>Восстановлено напоминаний: ${restored}</b>\n` +
        (overdue > 0
          ? `Из них просрочено: ${overdue} — они придут в ближайшую минуту.\n`
          : 'Все они снова в очереди.\n'),
      HTML
    );
  }

  const text =
    `👋 <b>Привет! Я ваш приватный бот-напоминатель.</b>\n\n` +
    `🌍 Часовой пояс: <code>${esc(tz)}</code> — сейчас там ${getLocalTimeLabel(tz)} ` +
    `(${getUtcOffsetLabel(tz)}).\nИзменить: кнопка «${BTN_TIMEZONE}» ниже.\n\n` +
    `📌 <b>Просто напишите, что и когда напомнить:</b>\n` +
    `• <code>напомни полить цветы через минуту</code>\n` +
    `• <code>через 2 часа позвонить маме</code>\n` +
    `• <code>завтра в 15:00 забрать посылку</code>\n` +
    `• <code>купить хлеб сегодня вечером</code>\n` +
    `• <code>в понедельник в 10:00 совещание</code>\n` +
    `• <code>каждый день в 09:00 зарядка</code>\n` +
    `• <code>каждую пятницу в 18:00 отчёт</code>\n\n` +
    `Время можно писать в любом месте фразы — в начале или в конце.\n\n` +
    `📋 Все задачи — кнопка «${BTN_LIST}» или /list`;

  await ctx.reply(text, { ...HTML, reply_markup: mainKeyboard });
}

async function sendHelp(ctx: Context): Promise<void> {
  const text =
    `📖 <b>Справка</b>\n\n` +
    `<b>Команды</b>\n` +
    `/list — список напоминаний по 5 на страницу; нажмите номер, ` +
    `чтобы изменить текст, изменить время или удалить\n` +
    `/tz — часовой пояс\n` +
    `/clear — удалить все напоминания\n` +
    `/cancel — отменить текущее действие\n\n` +
    `<b>1️⃣ Относительное время</b>\n` +
    `• <code>через минуту</code> / <code>через 20 минут</code>\n` +
    `• <code>через полчаса</code> / <code>через 2 часа</code>\n` +
    `• <code>через 1 час 30 минут</code>\n` +
    `• <code>через 2 дня в 15:00</code>\n` +
    `• <code>через неделю</code>\n\n` +
    `<b>2️⃣ Конкретное время</b>\n` +
    `• <code>сегодня в 19:00</code> / <code>завтра в 10:30</code>\n` +
    `• <code>завтра утром</code> (09:00), <code>вечером</code> (19:00)\n` +
    `• <code>послезавтра в 14:00</code>\n` +
    `• <code>в пятницу в 18:00</code>\n` +
    `• <code>в 9 утра</code> / <code>в 7 вечера</code>\n` +
    `• <code>25.12 в 12:00</code> / <code>15 сентября в 10:00</code>\n\n` +
    `<b>3️⃣ Повторяющиеся</b>\n` +
    `• <code>каждый день в 09:00</code>\n` +
    `• <code>по будням в 09:00</code>\n` +
    `• <code>каждый понедельник в 10:00</code>\n` +
    `• <code>каждое 1 число в 12:00</code>\n\n` +
    `💡 Слова «напомни», «напомни мне», «не забыть» можно писать в начале — ` +
    `они не попадут в текст задачи.`;

  await ctx.reply(text, { ...HTML, reply_markup: mainKeyboard });
}

/** Reminders shown on one page of /list. */
const LIST_PAGE_SIZE = 5;

const DIGIT_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

const EMPTY_LIST_TEXT =
  '📭 Активных напоминаний нет.\n\nНапишите, например: <code>через 10 минут проверить духовку</code>';

/** Longest reminder text accepted on creation and editing. */
const MAX_TEXT_LENGTH = 500;

/** Longest text shown per list entry, so a page always fits Telegram's 4096. */
const LIST_TEXT_PREVIEW = 120;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** One reminder rendered as a list entry. */
function formatListEntry(reminder: Reminder, number: number, userTz: string): string {
  const due = new Date(reminder.dueDate);
  const recur = RECURRENCE_LABELS[reminder.recurrence];
  const recurText = recur ? ` 🔄 ${recur}` : '';
  const pausedText = reminder.status === 'paused' ? '\n    ⏸ <i>приостановлено — доставка не прошла</i>' : '';

  return (
    `<b>${number}.</b> ${esc(truncate(reminder.text, LIST_TEXT_PREVIEW))}\n` +
    `    ⏰ ${esc(formatFullRussianDate(due, userTz))}${recurText}\n` +
    `    ⏳ <i>${esc(formatTimeUntil(due))}</i>${pausedText}\n\n`
  );
}

/**
 * Renders one page of the list.
 *
 * The reminders are re-read on every render, so a page stays correct even when
 * something was deleted or fired since the message was drawn. `page` is clamped
 * rather than trusted: it arrives from callback data.
 */
async function renderList(ctx: Context, requestedPage: number, editInPlace: boolean): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const [reminders, userTz] = await Promise.all([getUserReminders(userId), getUserTimezone(userId)]);

  if (reminders.length === 0) {
    if (editInPlace) {
      await ctx.editMessageText(EMPTY_LIST_TEXT, HTML).catch(() => {});
    } else {
      await ctx.reply(EMPTY_LIST_TEXT, { ...HTML, reply_markup: mainKeyboard });
    }
    return;
  }

  const pages = Math.ceil(reminders.length / LIST_PAGE_SIZE);
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const slice = reminders.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE);

  let text = `📋 <b>Напоминания (${reminders.length})</b>`;
  if (pages > 1) text += ` — страница ${page + 1} из ${pages}`;
  text += '\n\n';

  slice.forEach((reminder, i) => {
    text += formatListEntry(reminder, page * LIST_PAGE_SIZE + i + 1, userTz);
  });
  text += '<i>Нажмите номер, чтобы изменить или удалить.</i>';

  const keyboard = new InlineKeyboard();
  slice.forEach((reminder, i) => {
    keyboard.text(DIGIT_EMOJI[i] ?? String(i + 1), `item:${reminder.id}:${page}`);
  });

  if (pages > 1) {
    keyboard.row();
    if (page > 0) keyboard.text('◀️', `page:${page - 1}`);
    keyboard.text(`${page + 1}/${pages}`, 'noop');
    if (page < pages - 1) keyboard.text('▶️', `page:${page + 1}`);
  }

  if (editInPlace) {
    await ctx.editMessageText(text, { ...HTML, reply_markup: keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { ...HTML, reply_markup: keyboard });
  }
}

function sendList(ctx: Context): Promise<void> {
  return renderList(ctx, 0, false);
}

/** The card for a single reminder: edit text, edit time, delete, back. */
async function renderItem(ctx: Context, reminderId: string, page: number): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const reminder = await getOwnedReminder(reminderId, userId);
  if (!reminder) return false;

  const userTz = await getUserTimezone(userId);
  const due = new Date(reminder.dueDate);
  const recur = RECURRENCE_LABELS[reminder.recurrence];

  let text =
    `📌 <b>${esc(reminder.text)}</b>\n\n` +
    `⏰ ${esc(formatFullRussianDate(due, userTz))}\n` +
    `⏳ <i>${esc(formatTimeUntil(due))}</i>\n`;
  if (recur) text += `🔄 Повтор: <b>${esc(recur)}</b>\n`;
  if (reminder.status === 'paused') text += `⏸ <i>приостановлено — доставка не прошла</i>\n`;

  const keyboard = new InlineKeyboard()
    .text('✏️ Изменить текст', `etext:${reminder.id}:${page}`)
    .row()
    .text('🕐 Изменить время', `etime:${reminder.id}:${page}`)
    .row()
    .text('🗑 Удалить', `del:${reminder.id}:${page}`)
    .text('◀️ К списку', `page:${page}`);

  await ctx.editMessageText(text, { ...HTML, reply_markup: keyboard }).catch(() => {});
  return true;
}

async function sendTimezoneMenu(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const currentTz = await getUserTimezone(userId);
  const keyboard = new InlineKeyboard();

  EUROPEAN_TIMEZONES.forEach((tz, idx) => {
    const mark = tz.id === currentTz ? '✅ ' : '';
    keyboard.text(`${mark}${tz.label} ${getUtcOffsetLabel(tz.id)}`, `tz:${tz.id}`);
    if (idx % 2 === 1) keyboard.row();
  });

  await ctx.reply(
    `🌍 <b>Часовой пояс</b>\n\n` +
      `Сейчас: <code>${esc(currentTz)}</code> — местное время ${getLocalTimeLabel(currentTz)} ` +
      `(${getUtcOffsetLabel(currentTz)}).\n\n` +
      `Выберите город кнопкой ниже или задайте любую зону вручную:\n` +
      `<code>/tz Asia/Tokyo</code>`,
    { ...HTML, reply_markup: keyboard }
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

bot.command('start', async (ctx) => {
  await ensureBotCommands();
  await sendWelcome(ctx);
});

bot.command('help', sendHelp);
bot.command('list', sendList);

bot.command('cancel', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const pending = await getPendingAction(userId);
  if (pending) {
    await clearPendingAction(userId);
    const what = pending.kind === 'text' ? 'Изменение текста' : 'Изменение времени';
    await ctx.reply(`❌ ${what} отменено.`, { reply_markup: mainKeyboard });
  } else {
    await ctx.reply('ℹ️ Нет активных действий для отмены.', { reply_markup: mainKeyboard });
  }
});

bot.command('clear', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const reminders = await getUserReminders(userId);
  if (reminders.length === 0) {
    await ctx.reply('📭 Удалять нечего — активных напоминаний нет.');
    return;
  }

  await ctx.reply(
    `⚠️ Удалить <b>все ${reminders.length}</b> напоминаний? Это необратимо.`,
    {
      ...HTML,
      reply_markup: new InlineKeyboard()
        .text('🗑 Да, удалить все', 'clearall:confirm')
        .text('↩️ Отмена', 'clearall:cancel'),
    }
  );
});

bot.command('tz', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const arg = ctx.match?.trim();
  if (!arg) {
    await sendTimezoneMenu(ctx);
    return;
  }

  if (isValidTimezone(arg)) {
    await setUserTimezone(userId, arg);
    await ctx.reply(
      `✅ Часовой пояс: <code>${esc(arg)}</code>\n🕒 Местное время: ${getLocalTimeLabel(arg)} (${getUtcOffsetLabel(arg)})`,
      { ...HTML, reply_markup: mainKeyboard }
    );
  } else {
    await ctx.reply(
      `❌ Не знаю такой часовой пояс: <code>${esc(arg)}</code>\n\n` +
        `Нужно имя из базы IANA, например <code>Europe/Zurich</code>, <code>Europe/Berlin</code>, <code>UTC</code>.\n` +
        `Или выберите город кнопкой: /tz`,
      HTML
    );
  }
});

// ---------------------------------------------------------------------------
// Callback queries (delete / snooze / reschedule / timezone)
// ---------------------------------------------------------------------------

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from?.id;
  if (!userId) return;

  // --- Timezone picked from the menu ---
  if (data.startsWith('tz:')) {
    const tz = data.slice(3);
    if (!isValidTimezone(tz)) {
      await ctx.answerCallbackQuery({ text: '❌ Неизвестный часовой пояс' });
      return;
    }
    await setUserTimezone(userId, tz);
    await ctx.answerCallbackQuery({ text: `🌍 ${tz}` });
    await ctx.editMessageText(
      `✅ <b>Часовой пояс установлен</b>\n\n` +
        `<code>${esc(tz)}</code>\n🕒 Местное время: ${getLocalTimeLabel(tz)} (${getUtcOffsetLabel(tz)})`,
      HTML
    );
    return;
  }

  // --- Delete all (only reachable from the /clear confirmation) ---
  if (data === 'clearall:confirm') {
    const count = await deleteAllUserReminders(userId);
    await ctx.answerCallbackQuery({ text: `Удалено: ${count}` });
    await ctx.editMessageText(`🗑 Удалено напоминаний: <b>${count}</b>`, HTML);
    return;
  }

  if (data === 'clearall:cancel') {
    await ctx.answerCallbackQuery({ text: 'Отменено' });
    await ctx.editMessageText('↩️ Удаление отменено.');
    return;
  }

  // --- The page counter in the middle of the navigation row ---
  if (data === 'noop') {
    await ctx.answerCallbackQuery();
    return;
  }

  // --- List navigation ---
  if (data.startsWith('page:')) {
    await ctx.answerCallbackQuery();
    await renderList(ctx, parseInt(data.slice(5), 10) || 0, true);
    return;
  }

  // --- Open one reminder's card ---
  if (data.startsWith('item:')) {
    const [, reminderId, pageStr] = data.split(':');
    const page = parseInt(pageStr, 10) || 0;

    if (!(await renderItem(ctx, reminderId, page))) {
      // Deleted or fired since the list was drawn — show the fresh list instead.
      await ctx.answerCallbackQuery({ text: '❌ Напоминание больше не существует' });
      await renderList(ctx, page, true);
      return;
    }
    await ctx.answerCallbackQuery();
    return;
  }

  // --- Edit the text of a reminder ---
  if (data.startsWith('etext:')) {
    const [, reminderId, pageStr] = data.split(':');
    const reminder = await getOwnedReminder(reminderId, userId);

    if (!reminder) {
      await ctx.answerCallbackQuery({ text: '❌ Напоминание не найдено' });
      await renderList(ctx, parseInt(pageStr, 10) || 0, true);
      return;
    }

    await setPendingAction(userId, 'text', reminderId);
    await ctx.answerCallbackQuery({ text: '✏️ Напишите новый текст' });
    await ctx.reply(
      `✏️ <b>Новый текст напоминания</b>\n\n` +
        `Сейчас: «${esc(reminder.text)}»\n\n` +
        `Отправьте новый текст одним сообщением. Время не изменится.\n\n` +
        `<i>(или /cancel для отмены)</i>`,
      HTML
    );
    return;
  }

  // --- Edit the time of a reminder (same flow as "✍️ Другое время") ---
  if (data.startsWith('etime:')) {
    const [, reminderId, pageStr] = data.split(':');
    const reminder = await getOwnedReminder(reminderId, userId);

    if (!reminder) {
      await ctx.answerCallbackQuery({ text: '❌ Напоминание не найдено' });
      await renderList(ctx, parseInt(pageStr, 10) || 0, true);
      return;
    }

    await setPendingAction(userId, 'time', reminderId);
    await ctx.answerCallbackQuery({ text: '🕐 Напишите новое время' });
    await ctx.reply(
      `🕐 <b>Новое время для задачи</b>\n📌 «${esc(reminder.text)}»\n\n` +
        `Напишите время словами:\n` +
        `• <code>через 45 минут</code>\n` +
        `• <code>сегодня в 21:00</code>\n` +
        `• <code>завтра в 11:30</code>\n` +
        `• <code>каждый день в 09:00</code>\n\n` +
        `<i>(или /cancel для отмены)</i>`,
      HTML
    );
    return;
  }

  // --- Mark done / delete one ---
  // Callback data round-trips through the client, so ownership is re-checked in
  // storage: a reminder id from another user's chat must not match anything.
  if (data.startsWith('del:')) {
    const [, reminderId, pageStr] = data.split(':');
    const deleted = await deleteReminder(reminderId, userId);

    if (!deleted) {
      await ctx.answerCallbackQuery({ text: '❌ Напоминание не найдено' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '✅ Готово!' });

    // Deleted from the list: go back to it. Deleted from a delivered reminder
    // or a confirmation: that message becomes the receipt.
    if (pageStr !== undefined) {
      await renderList(ctx, parseInt(pageStr, 10) || 0, true);
    } else {
      await ctx.editMessageText('✅ Напоминание выполнено и удалено.').catch(() => {});
    }
    return;
  }

  // --- Ask for a new time in words ---
  if (data.startsWith('resched:')) {
    const reminderId = data.slice(8);
    const reminder = await getOwnedReminder(reminderId, userId);

    if (!reminder) {
      await ctx.answerCallbackQuery({ text: '❌ Напоминание не найдено' });
      return;
    }

    await setPendingAction(userId, 'time', reminderId);
    await ctx.answerCallbackQuery({ text: '✍️ Напишите новое время' });
    await ctx.reply(
      `✍️ <b>Когда напомнить о задаче?</b>\n📌 «${esc(reminder.text)}»\n\n` +
        `Напишите время словами:\n` +
        `• <code>через 45 минут</code>\n` +
        `• <code>сегодня в 21:00</code>\n` +
        `• <code>завтра в 11:30</code>\n` +
        `• <code>в понедельник в 10:00</code>\n\n` +
        `<i>(или /cancel для отмены)</i>`,
      HTML
    );
    return;
  }

  // --- Snooze by a fixed number of minutes: snz:<id>:<minutes> ---
  if (data.startsWith('snz:')) {
    const [, reminderId, minsStr] = data.split(':');
    const mins = parseInt(minsStr, 10);
    const reminder = await getOwnedReminder(reminderId, userId);

    if (!reminder || !Number.isFinite(mins)) {
      await ctx.answerCallbackQuery({ text: '❌ Напоминание не найдено' });
      return;
    }

    const userTz = await getUserTimezone(userId);
    const newDueDate = addMinutes(new Date(), mins);
    await saveReminder({ ...reminder, dueDate: newDueDate.toISOString(), timezone: userTz });

    const durationLabel =
      mins === 60 ? '1 час' : mins === 180 ? '3 часа' : mins === 1440 ? 'завтра' : `${mins} мин`;

    await ctx.answerCallbackQuery({ text: `⏰ Отложено на ${durationLabel}` });
    await ctx
      .editMessageText(
        `⏰ «<b>${esc(reminder.text)}</b>» отложено на <b>${esc(durationLabel)}</b>\n\n` +
          `🔔 Новое время: ${esc(formatFullRussianDate(newDueDate, userTz))}`,
        { ...HTML, reply_markup: reminderKeyboard(reminder.id) }
      )
      .catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery();
});

// ---------------------------------------------------------------------------
// Free-form text: keyboard buttons, reschedule replies, new reminders
// ---------------------------------------------------------------------------

bot.on('message:text', async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();

  if (!userId || text.startsWith('/')) return;

  // Persistent keyboard buttons arrive as ordinary text messages. Tapping one
  // means the user moved on, so any half-finished prompt is dropped.
  if (text === BTN_LIST || text === BTN_HELP || text === BTN_TIMEZONE) {
    await clearPendingAction(userId);
    if (text === BTN_LIST) return sendList(ctx);
    if (text === BTN_HELP) return sendHelp(ctx);
    return sendTimezoneMenu(ctx);
  }

  const userTz = await getUserTimezone(userId);

  // --- Answering an "✏️ Изменить текст" / "🕐 Изменить время" prompt ---
  const pending = await getPendingAction(userId);
  if (pending) {
    const reminder = await getOwnedReminder(pending.reminderId, userId);
    if (!reminder) {
      await clearPendingAction(userId);
      await ctx.reply('❌ Исходное напоминание не найдено или уже удалено.');
      return;
    }

    if (pending.kind === 'text') {
      const newText = text.trim();
      if (newText.length > MAX_TEXT_LENGTH) {
        await ctx.reply(
          `⚠️ Слишком длинный текст (максимум ${MAX_TEXT_LENGTH} символов, у вас ${newText.length}). Отправьте покороче.`
        );
        return;
      }

      await saveReminder({ ...reminder, text: newText });
      await clearPendingAction(userId);

      const due = new Date(reminder.dueDate);
      await ctx.reply(
        `✅ <b>Текст изменён</b>\n\n` +
          `📌 ${esc(newText)}\n` +
          `⏰ ${esc(formatFullRussianDate(due, reminder.timezone || userTz))}\n` +
          `⏳ <i>${esc(formatTimeUntil(due))}</i>`,
        { ...HTML, reply_markup: reminderKeyboard(reminder.id, false) }
      );
      return;
    }

    const parsed = parseReminderInput(text, userTz);
    if (!parsed) {
      await ctx.reply(
        `🤔 Не удалось распознать время.\n\n` +
          `Попробуйте так:\n` +
          `• <code>через 30 минут</code>\n` +
          `• <code>завтра в 12:00</code>\n` +
          `• <code>в понедельник в 10:00</code>\n\n` +
          `Или /cancel для отмены.`,
        HTML
      );
      return;
    }

    const newText = parsed.text.trim() || reminder.text;
    const updated: Reminder = {
      ...reminder,
      text: newText,
      dueDate: parsed.dueDate.toISOString(),
      timezone: userTz,
      recurrence: parsed.recurrence !== 'none' ? parsed.recurrence : reminder.recurrence,
      recurrenceRule: parsed.recurrenceRule ?? reminder.recurrenceRule,
    };

    await saveReminder(updated);
    await clearPendingAction(userId);

    await ctx.reply(
      `✅ <b>Перенесено</b>\n\n` +
        `📌 ${esc(newText)}\n` +
        `⏰ ${esc(formatFullRussianDate(parsed.dueDate, userTz))}\n` +
        `⏳ <i>${esc(formatTimeUntil(parsed.dueDate))}</i>`,
      { ...HTML, reply_markup: reminderKeyboard(reminder.id) }
    );
    return;
  }

  // --- Creating a new reminder ---
  const parsed = parseReminderInput(text, userTz);

  if (!parsed) {
    await ctx.reply(
      `🤔 Не нашёл дату или время в сообщении.\n\n` +
        `Попробуйте так:\n` +
        `• <code>напомни полить цветы через минуту</code>\n` +
        `• <code>через 30 минут проверить духовку</code>\n` +
        `• <code>завтра в 15:00 забрать посылку</code>\n` +
        `• <code>каждый день в 09:00 зарядка</code>\n\n` +
        `Подробнее: /help`,
      { ...HTML, reply_markup: mainKeyboard }
    );
    return;
  }

  if (parsed.text.length > MAX_TEXT_LENGTH) {
    await ctx.reply(
      `⚠️ Слишком длинный текст напоминания (максимум ${MAX_TEXT_LENGTH} символов, ` +
        `у вас ${parsed.text.length}). Сократите и отправьте ещё раз.`
    );
    return;
  }

  if (!parsed.text) {
    await ctx.reply(
      `⚠️ Время понял (<b>${esc(formatFullRussianDate(parsed.dueDate, userTz))}</b>), ` +
        `но не понял задачу.\n\n` +
        `Напишите её вместе со временем:\n` +
        `• <code>завтра в 15:00 полить цветы</code>\n` +
        `• <code>позвонить коллеге через 2 часа</code>`,
      HTML
    );
    return;
  }

  const reminderId = `rem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const reminder: Reminder = {
    id: reminderId,
    userId,
    chatId,
    text: parsed.text,
    dueDate: parsed.dueDate.toISOString(),
    timezone: userTz,
    recurrence: parsed.recurrence,
    recurrenceRule: parsed.recurrenceRule,
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  await saveReminder(reminder);

  const recurLabel = RECURRENCE_LABELS[parsed.recurrence];
  const recurText = recurLabel ? `\n🔄 Повтор: <b>${esc(recurLabel)}</b>` : '';

  await ctx.reply(
    `✅ <b>Напоминание создано</b>\n\n` +
      `📌 ${esc(parsed.text)}\n` +
      `⏰ ${esc(formatFullRussianDate(parsed.dueDate, userTz))}\n` +
      `⏳ <i>${esc(formatTimeUntil(parsed.dueDate))}</i>${recurText}`,
    { ...HTML, reply_markup: reminderKeyboard(reminderId, false) }
  );
});

export { mainKeyboard, reminderKeyboard, BOT_COMMANDS };
