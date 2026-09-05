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
  setPendingReschedule,
  getPendingReschedule,
  clearPendingReschedule,
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
    `/list — список напоминаний\n` +
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

async function sendList(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const [reminders, userTz] = await Promise.all([getUserReminders(userId), getUserTimezone(userId)]);

  if (reminders.length === 0) {
    await ctx.reply(
      '📭 Активных напоминаний нет.\n\nНапишите, например: <code>через 10 минут проверить духовку</code>',
      { ...HTML, reply_markup: mainKeyboard }
    );
    return;
  }

  // Telegram rejects messages over 4096 characters and inline keyboards over
  // 100 buttons, so the list is delivered in pages.
  const PAGE_SIZE = 20;
  const pages = Math.ceil(reminders.length / PAGE_SIZE);

  for (let page = 0; page < pages; page++) {
    const slice = reminders.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const keyboard = new InlineKeyboard();

    let text =
      pages > 1
        ? `📋 <b>Активные напоминания (${reminders.length})</b> — часть ${page + 1} из ${pages}\n\n`
        : `📋 <b>Активные напоминания (${reminders.length})</b>\n\n`;

    slice.forEach((r, i) => {
      const number = page * PAGE_SIZE + i + 1;
      const due = new Date(r.dueDate);
      const recur = RECURRENCE_LABELS[r.recurrence];
      const recurText = recur ? ` 🔄 ${recur}` : '';
      const pausedText = r.status === 'paused' ? '\n    ⏸ <i>приостановлено — доставка не прошла</i>' : '';

      text +=
        `<b>${number}.</b> ${esc(r.text)}\n` +
        `    ⏰ ${esc(formatFullRussianDate(due, userTz))}${recurText}\n` +
        `    ⏳ <i>${esc(formatTimeUntil(due))}</i>${pausedText}\n\n`;

      keyboard.text(`🗑 ${number}`, `del:${r.id}`);
      if (i % 4 === 3) keyboard.row();
    });

    if (page === pages - 1) keyboard.row().text('🗑 Удалить все', 'clearall');

    await ctx.reply(text, { ...HTML, reply_markup: keyboard });
  }
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

  const pending = await getPendingReschedule(userId);
  if (pending) {
    await clearPendingReschedule(userId);
    await ctx.reply('❌ Перенос напоминания отменён.', { reply_markup: mainKeyboard });
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

  // --- Delete all ---
  if (data === 'clearall' || data === 'clearall:confirm') {
    if (data === 'clearall') {
      await ctx.answerCallbackQuery();
      await ctx.reply('⚠️ Удалить <b>все</b> напоминания? Это необратимо.', {
        ...HTML,
        reply_markup: new InlineKeyboard()
          .text('🗑 Да, удалить все', 'clearall:confirm')
          .text('↩️ Отмена', 'clearall:cancel'),
      });
      return;
    }
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

  // --- Mark done / delete one ---
  // Callback data round-trips through the client, so ownership is re-checked in
  // storage: a reminder id from another user's chat must not match anything.
  if (data.startsWith('del:')) {
    const reminderId = data.slice(4);
    const deleted = await deleteReminder(reminderId, userId);

    if (!deleted) {
      await ctx.answerCallbackQuery({ text: '❌ Напоминание не найдено' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '✅ Готово!' });
    await ctx.editMessageText('✅ Напоминание выполнено и удалено.').catch(() => {});
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

    await setPendingReschedule(userId, reminderId);
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

  // Persistent keyboard buttons arrive as ordinary text messages.
  if (text === BTN_LIST) return sendList(ctx);
  if (text === BTN_HELP) return sendHelp(ctx);
  if (text === BTN_TIMEZONE) return sendTimezoneMenu(ctx);

  const userTz = await getUserTimezone(userId);

  // --- Answering a "✍️ Другое время" prompt ---
  const pendingReminderId = await getPendingReschedule(userId);
  if (pendingReminderId) {
    const reminder = await getOwnedReminder(pendingReminderId, userId);
    if (!reminder) {
      await clearPendingReschedule(userId);
      await ctx.reply('❌ Исходное напоминание не найдено или уже удалено.');
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
    await clearPendingReschedule(userId);

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
