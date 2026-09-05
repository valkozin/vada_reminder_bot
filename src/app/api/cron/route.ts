import { NextRequest, NextResponse } from 'next/server';
import { getAllActiveReminders, deleteReminder, saveReminder } from '@/lib/db';
import { bot } from '@/lib/bot';
import { Reminder } from '@/lib/types';
import { addDays, addWeeks } from 'date-fns';
import { InlineKeyboard } from 'grammy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Verify Cron Secret if set in environment
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers.get('authorization');
    const querySecret = req.nextUrl.searchParams.get('secret');
    const token = authHeader ? authHeader.replace('Bearer ', '').trim() : querySecret;

    if (token !== expectedSecret) {
      return NextResponse.json({ ok: false, error: 'Unauthorized Cron Trigger' }, { status: 401 });
    }
  }

  const now = new Date();
  const allReminders = await getAllActiveReminders();
  const dueReminders = allReminders.filter((r) => new Date(r.dueDate) <= now);

  let processedCount = 0;
  const errors: string[] = [];

  for (const reminder of dueReminders) {
    try {
      // Send Telegram notification
      const keyboard = new InlineKeyboard()
        .text('⏰ +10 мин', `snz:${reminder.id}:10`)
        .text('⏰ +1 час', `snz:${reminder.id}:60`)
        .text('✅ Удалить', `del:${reminder.id}`);

      await bot.api.sendMessage(
        reminder.chatId,
        `🔔 *НАПОМИНАНИЕ!*\n\n📌 ${reminder.text}\n\n⏰ _Назначено на: ${new Date(reminder.dueDate).toLocaleString('ru-RU')}_`,
        {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        }
      );

      // Handle recurrence or deletion
      if (reminder.recurrence === 'none') {
        await deleteReminder(reminder.id, reminder.userId);
      } else {
        const nextDueDate = calculateNextRecurrenceDate(reminder);
        const updatedReminder: Reminder = {
          ...reminder,
          dueDate: nextDueDate.toISOString(),
        };
        await saveReminder(updatedReminder);
      }

      processedCount++;
    } catch (err: any) {
      console.error(`Failed to process reminder ${reminder.id}:`, err);
      errors.push(`ID ${reminder.id}: ${err?.message || err}`);
    }
  }

  return NextResponse.json({
    ok: true,
    processed: processedCount,
    totalDue: dueReminders.length,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: now.toISOString(),
  });
}

function calculateNextRecurrenceDate(reminder: Reminder): Date {
  const currentDue = new Date(reminder.dueDate);
  let nextDate = new Date(currentDue);

  if (reminder.recurrence === 'daily') {
    nextDate = addDays(nextDate, 1);
  } else if (reminder.recurrence === 'weekly') {
    nextDate = addWeeks(nextDate, 1);
  } else if (reminder.recurrence === 'weekdays') {
    do {
      nextDate = addDays(nextDate, 1);
    } while (nextDate.getDay() === 0 || nextDate.getDay() === 6);
  }

  return nextDate;
}
