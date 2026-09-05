import { Bot, InlineKeyboard } from 'grammy';
import { parseReminderInput, formatFullRussianDate } from './parser';
import {
  getUserTimezone,
  setUserTimezone,
  saveReminder,
  getUserReminders,
  deleteReminder,
  getReminder,
  setPendingReschedule,
  getPendingReschedule,
  clearPendingReschedule,
} from './db';
import { Reminder } from './types';
import { addMinutes } from 'date-fns';

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
    `• \`через 2 дня в 12:00 забрать посылку\`\n` +
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
    `/cancel — Отменить текущее действие (например, ввод времени для переноса)\n` +
    `/tz [ЧасовойПояс] — Установить ваш часовой пояс (например: \`/tz Europe/Moscow\`)\n\n` +
    `💬 *Форматы естественного текста:*\n` +
    `1️⃣ *Относительное время:*\n` +
    `   • через 20 минут ...\n` +
    `   • через 2 часа ...\n` +
    `   • через 2 дня в 15:00 ...\n\n` +
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

// /cancel command
bot.command('cancel', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const pending = await getPendingReschedule(userId);
  if (pending) {
    await clearPendingReschedule(userId);
    await ctx.reply('❌ Перенос напоминания отменен.');
  } else {
    await ctx.reply('ℹ️ Нет активных действий для отмены.');
  }
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
    const dateFormatted = formatFullRussianDate(new Date(r.dueDate), userTz);
    const recurText = r.recurrence !== 'none' ? ` 🔄 (${r.recurrence})` : '';

    text += `${idx + 1}. ⏰ *${dateFormatted}*${recurText}\n    📝 ${r.text}\n\n`;
    keyboard.text(`❌ Удалить №${idx + 1}`, `del:${r.id}`).row();
  });

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
});

// Callback queries handler (Delete / Snooze / Reschedule)
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from?.id;
  if (!userId) return;

  if (data.startsWith('del:')) {
    const reminderId = data.replace('del:', '');
    await deleteReminder(reminderId, userId);
    await ctx.answerCallbackQuery({ text: '✅ Выполнено!' });
    try {
      await ctx.editMessageText('✅ Напоминание выполнено и удалено.');
    } catch (_) {}
  } else if (data.startsWith('resched:')) {
    const reminderId = data.replace('resched:', '');
    const reminder = await getReminder(reminderId);

    if (reminder) {
      await setPendingReschedule(userId, reminderId);
      await ctx.answerCallbackQuery({ text: '✍️ Напишите новое время' });
      await ctx.reply(
        `✍️ *Когда напомнить о задаче:*\n📌 «${reminder.text}»?\n\n` +
          `Напишите время словами, например:\n` +
          `• \`через 45 минут\`\n` +
          `• \`сегодня в 21:00\`\n` +
          `• \`завтра в 11:30\`\n` +
          `• \`в понедельник в 10:00\`\n` +
          `• \`через 2 дня в 15:00\`\n\n` +
          `_(или отправьте /cancel для отмены)_`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.answerCallbackQuery({ text: '❌ Напоминание не найдено.' });
    }
  } else if (data.startsWith('snz:')) {
    // Format: snz:<id>:<minutes>
    const [, reminderId, minsStr] = data.split(':');
    const mins = parseInt(minsStr, 10);
    const reminder = await getReminder(reminderId);

    if (reminder) {
      const userTz = await getUserTimezone(userId);
      const newDueDate = addMinutes(new Date(), mins);
      const updatedReminder: Reminder = {
        ...reminder,
        dueDate: newDueDate.toISOString(),
      };
      await saveReminder(updatedReminder);

      const formattedNewDate = formatFullRussianDate(newDueDate, userTz);
      let durationLabel = `${mins} мин`;
      if (mins === 60) durationLabel = '1 час';
      else if (mins === 180) durationLabel = '3 часа';
      else if (mins === 1440) durationLabel = '1 день (завтра)';

      await ctx.answerCallbackQuery({ text: `⏰ Отложено на ${durationLabel}!` });

      const keyboard = new InlineKeyboard()
        .text('⏰ +15 мин', `snz:${reminder.id}:15`)
        .text('⏰ +1 час', `snz:${reminder.id}:60`)
        .row()
        .text('⏰ +3 часа', `snz:${reminder.id}:180`)
        .text('📅 Завтра', `snz:${reminder.id}:1440`)
        .row()
        .text('✍️ Напомнить снова...', `resched:${reminder.id}`)
        .text('✅ Выполнено', `del:${reminder.id}`);

      try {
        await ctx.editMessageText(
          `⏰ Напоминание «*${reminder.text}*» отложено на *${durationLabel}*!\n\n` +
            `⏰ *Новое время:* ${formattedNewDate}`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      } catch (_) {}
    } else {
      await ctx.answerCallbackQuery({ text: '❌ Напоминание не найдено.' });
    }
  }
});

// Text message handler - Natural Language Parsing & Rescheduling
bot.on('message:text', async (ctx) => {
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  if (!userId || text.startsWith('/')) return;

  const userTz = await getUserTimezone(userId);

  // Check if user is currently answering a "✍️ Напомнить снова..." prompt
  const pendingReminderId = await getPendingReschedule(userId);
  if (pendingReminderId) {
    const reminder = await getReminder(pendingReminderId);
    if (!reminder) {
      await clearPendingReschedule(userId);
      await ctx.reply('❌ Исходное напоминание не найдено или уже было удалено.');
      return;
    }

    const parsed = parseReminderInput(text, userTz);
    if (!parsed) {
      await ctx.reply(
        `🤔 Не удалось распознать время.\n\n` +
          `Попробуйте написать, например:\n` +
          `• \`через 30 минут\`\n` +
          `• \`завтра в 12:00\`\n` +
          `• \`в понедельник в 10:00\`\n` +
          `• \`через 2 дня в 15:00\`\n\n` +
          `Отправьте /cancel для отмены.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // If user provided a new task description, update it; otherwise preserve existing task text
    const newText = parsed.text && parsed.text.trim() ? parsed.text.trim() : reminder.text;
    const updatedReminder: Reminder = {
      ...reminder,
      text: newText,
      dueDate: parsed.dueDate.toISOString(),
    };

    await saveReminder(updatedReminder);
    await clearPendingReschedule(userId);

    const formattedDate = formatFullRussianDate(parsed.dueDate, userTz);

    const keyboard = new InlineKeyboard()
      .text('⏰ +15 мин', `snz:${reminder.id}:15`)
      .text('⏰ +1 час', `snz:${reminder.id}:60`)
      .row()
      .text('✍️ Напомнить снова...', `resched:${reminder.id}`)
      .text('✅ Выполнено', `del:${reminder.id}`);

    await ctx.reply(
      `✅ *Напоминание успешно перенесено!*\n\n` +
        `📌 *Задача:* ${newText}\n` +
        `⏰ *Новая дата и время:* ${formattedDate} (${userTz})`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    return;
  }

  // Normal Reminder Creation
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

  if (!parsed.text) {
    const timeFmt = formatFullRussianDate(parsed.dueDate, userTz);
    await ctx.reply(
      `⚠️ Вы указали время: *${timeFmt}*, но не написали текст задачи!\n\n` +
        `Напишите задачу вместе со временем, например:\n` +
        `• \`завтра в 15:00 полить цветы\`\n` +
        `• \`через 2 часа позвонить коллеге\``,
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

  const formattedDate = formatFullRussianDate(parsed.dueDate, userTz);
  const recurText = parsed.recurrence !== 'none' ? `\n🔄 *Повтор:* ${parsed.recurrence}` : '';

  const keyboard = new InlineKeyboard()
    .text('⏰ +15 мин', `snz:${reminderId}:15`)
    .text('⏰ +1 час', `snz:${reminderId}:60`)
    .row()
    .text('✍️ Напомнить снова...', `resched:${reminderId}`)
    .text('❌ Удалить', `del:${reminderId}`);

  await ctx.reply(
    `✅ *Напоминание создано!*\n\n` +
      `📌 *Задача:* ${parsed.text}\n` +
      `⏰ *Дата и время:* ${formattedDate} (${userTz})${recurText}`,
    { parse_mode: 'Markdown', reply_markup: keyboard }
  );
});

