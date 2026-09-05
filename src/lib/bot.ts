import { Bot, InlineKeyboard } from 'grammy';
import { parseReminderInput } from './parser';
import { getUserTimezone, setUserTimezone, saveReminder, getUserReminders, deleteReminder, getReminder } from './db';
import { Reminder } from './types';
import { format, addMinutes, addHours, addDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

const token = process.env.TELEGRAM_BOT_TOKEN || 'dummy_token_for_build';
export const bot = new Bot(token);

// Middleware: Check allowed users if TELEGRAM_ALLOWED_USER_IDS is set
bot.use(async (ctx, next) => {
  const allowedIdsStr = process.env.TELEGRAM_ALLOWED_USER_IDS;
  if (allowedIdsStr && ctx.from) {
    const allowedIds = allowedIdsStr.split(',').map((id) => parseInt(id.trim(), 10));
    if (!allowedIds.includes(ctx.from.id)) {
      await ctx.reply('⛔ Доступ ограничен. Вы не авторизованы для использования этого бота.');
      return;
    }
  }
  await next();
});

// /start command
bot.command('start', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const tz = await getUserTimezone(userId);

  const welcomeText =
    `👋 *Привет! Я ваш приватный бот-напоминатель.*\n\n` +
    `🌍 Ваш текущий часовой пояс: \`${tz}\`\n` +
    `Для изменения часового пояса отправьте команду:\n\`/tz Europe/Moscow\` или \`/tz UTC\`\n\n` +
    `📌 *Примеры создания напоминаний:*\n` +
    `• \`через 15 минут проверить духовку\`\n` +
    `• \`завтра в 15:00 полить цветы\`\n` +
    `• \`сегодня в 18:30 купить хлеб\`\n` +
    `• \`в понедельник в 10:00 совещание\`\n` +
    `• \`каждый день в 09:00 зарядка\`\n` +
    `• \`каждую пятницу в 18:00 отчет\`\n` +
    `• \`15.10 в 12:00 забрать документ\`\n\n` +
    `📋 Посмотреть список всех активных задач: /list`;

  await ctx.reply(welcomeText, { parse_mode: 'Markdown' });
});

// /help command
bot.command('help', async (ctx) => {
  const text =
    `📖 *Справка по командам:*\n\n` +
    `/list — Список всех активных напоминаний\n` +
    `/tz [ЧасовойПояс] — Установить ваш часовой пояс (например: \`/tz Europe/Moscow\`)\n\n` +
    `💬 *Форматы естественного текста:*\n` +
    `1️⃣ *Относительное время:*\n` +
    `   • через 20 минут ...\n` +
    `   • через 2 часа ...\n` +
    `   • через 3 дня ...\n\n` +
    `2️⃣ *Точное время:*\n` +
    `   • сегодня в 19:00 ...\n` +
    `   • завтра в 10:30 ...\n` +
    `   • послезавтра в 14:00 ...\n` +
    `   • в пятницу в 18:00 ...\n` +
    `   • 25.12 в 12:00 ...\n\n` +
    `3️⃣ *Повторяющиеся напоминания:*\n` +
    `   • каждый день в 09:00 ...\n` +
    `   • по будням в 09:00 ...\n` +
    `   • каждый понедельник в 10:00 ...`;

  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// /tz command
bot.command('tz', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const arg = ctx.match?.trim();
  if (!arg) {
    const currentTz = await getUserTimezone(userId);
    await ctx.reply(`🌍 Ваш текущий часовой пояс: \`${currentTz}\`.\nУкажите новый: например, \`/tz Europe/Moscow\` или \`/tz Asia/Tashkent\``, {
      parse_mode: 'Markdown',
    });
    return;
  }

  // Validate timezone string
  try {
    Intl.DateTimeFormat(undefined, { timeZone: arg });
    await setUserTimezone(userId, arg);
    await ctx.reply(`✅ Часовой пояс успешно изменен на \`${arg}\`!`, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ Некорректный часовой пояс \`${arg}\`.\nИспользуйте имя из базы IANA, например: \`Europe/Moscow\`, \`Europe/Kyiv\`, \`Asia/Almaty\`, \`UTC\`.`, {
      parse_mode: 'Markdown',
    });
  }
});

// /list command
bot.command('list', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const reminders = await getUserReminders(userId);
  const userTz = await getUserTimezone(userId);

  if (reminders.length === 0) {
    await ctx.reply('📭 У вас пока нет активных напоминаний.');
    return;
  }

  let text = `📋 *Ваши активные напоминания (${reminders.length}):*\n\n`;

  const keyboard = new InlineKeyboard();

  reminders.forEach((r, idx) => {
    const zonedDueDate = toZonedTime(new Date(r.dueDate), userTz);
    const dateFormatted = format(zonedDueDate, 'dd.MM.yyyy HH:mm');
    const recurText = r.recurrence !== 'none' ? ` 🔄 (${r.recurrence})` : '';

    text += `${idx + 1}. ⏰ *${dateFormatted}*${recurText}\n    📝 ${r.text}\n\n`;
    keyboard.text(`❌ Удалить №${idx + 1}`, `del:${r.id}`).row();
  });

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
});

// Callback queries handler (Delete / Snooze)
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from?.id;
  if (!userId) return;

  if (data.startsWith('del:')) {
    const reminderId = data.replace('del:', '');
    await deleteReminder(reminderId, userId);
    await ctx.answerCallbackQuery({ text: '🗑️ Напоминание удалено!' });
    try {
      await ctx.editMessageText('🗑️ Напоминание успешно удалено.');
    } catch (_) {}
  } else if (data.startsWith('snz:')) {
    // Format: snz:<id>:<minutes>
    const [, reminderId, minsStr] = data.split(':');
    const mins = parseInt(minsStr, 10);
    const reminder = await getReminder(reminderId);

    if (reminder) {
      const newDueDate = addMinutes(new Date(), mins).toISOString();
      const updatedReminder: Reminder = {
        ...reminder,
        dueDate: newDueDate,
      };
      await saveReminder(updatedReminder);
      await ctx.answerCallbackQuery({ text: `⏰ Отложено на ${mins} минут!` });
      try {
        await ctx.editMessageText(`⏰ Напоминание «${reminder.text}» отложено на ${mins} минут.`);
      } catch (_) {}
    } else {
      await ctx.answerCallbackQuery({ text: '❌ Напоминание не найдено.' });
    }
  }
});

// Text message handler - Natural Language Parsing
bot.on('message:text', async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  if (!userId || text.startsWith('/')) return;

  const userTz = await getUserTimezone(userId);
  const parsed = parseReminderInput(text, userTz);

  if (!parsed) {
    await ctx.reply(
      `🤔 Не удалось распознать дату в сообщении.\n\n` +
        `Попробуйте написать, например:\n` +
        `• \`через 30 минут проверить духовку\`\n` +
        `• \`завтра в 15:00 полить цветы\`\n` +
        `• \`каждый день в 09:00 зарядка\`\n\n` +
        `Подробная справка: /help`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const reminderId = `rem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const reminder: Reminder = {
    id: reminderId,
    userId,
    chatId,
    text: parsed.text,
    dueDate: parsed.dueDate.toISOString(),
    timezone: userTz,
    recurrence: parsed.recurrence,
    recurrenceRule: parsed.recurrenceRule,
    createdAt: new Date().toISOString(),
  };

  await saveReminder(reminder);

  const zonedDueDate = toZonedTime(parsed.dueDate, userTz);
  const formattedDate = format(zonedDueDate, 'dd.MM.yyyy HH:mm');
  const recurText = parsed.recurrence !== 'none' ? `\n🔄 Повтор: ${parsed.recurrence}` : '';

  const keyboard = new InlineKeyboard()
    .text('❌ Удалить', `del:${reminderId}`)
    .text('⏰ +10 мин', `snz:${reminderId}:10`)
    .text('⏰ +1 час', `snz:${reminderId}:60`);

  await ctx.reply(
    `✅ *Напоминание создано!*\n\n` +
      `📌 *Задача:* ${parsed.text}\n` +
      `⏰ *Дата и время:* ${formattedDate} (${userTz})${recurText}`,
    { parse_mode: 'Markdown', reply_markup: keyboard }
  );
});
