import { NextRequest, NextResponse } from 'next/server';
import {
  getAllActiveReminders,
  saveReminder,
  markReminderFired,
  pauseReminder,
  claimDelivery,
  releaseDelivery,
} from '@/lib/db';
import { bot, esc, reminderKeyboard } from '@/lib/bot';
import { Reminder } from '@/lib/types';
import { formatFullRussianDate, calculateNextRecurrence } from '@/lib/parser';
import { DEFAULT_TIMEZONE } from '@/lib/timezones';
import { GrammyError } from 'grammy';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * How many reminders one run may deliver. Keeps the function inside its time
 * budget; anything left over is picked up by the next run a minute later,
 * oldest first, so nothing is starved.
 */
const MAX_PER_RUN = 40;

/** Telegram errors that mean this chat can never receive messages again. */
function isUndeliverable(err: unknown): err is GrammyError {
  return (
    err instanceof GrammyError &&
    (err.error_code === 403 || err.error_code === 400) &&
    /blocked|chat not found|deactivated|kicked|user is deactivated/i.test(err.description)
  );
}

async function handle(req: NextRequest) {
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers.get('authorization');
    const querySecret = req.nextUrl.searchParams.get('secret');
    const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : querySecret;

    if (token !== expectedSecret) {
      return NextResponse.json({ ok: false, error: 'Unauthorized Cron Trigger' }, { status: 401 });
    }
  }

  const now = new Date();
  const allReminders = await getAllActiveReminders();

  // Oldest first: after an outage the most overdue reminders go out first.
  const dueReminders = allReminders
    .filter((r) => new Date(r.dueDate) <= now)
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  const batch = dueReminders.slice(0, MAX_PER_RUN);

  let processed = 0;
  let rescheduled = 0;
  let paused = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const reminder of batch) {
    const timezone = reminder.timezone || DEFAULT_TIMEZONE;

    // Two cron runs can overlap (a slow run plus the next tick). The claim is
    // atomic and scoped to this exact due date, so only one run delivers it.
    if (!(await claimDelivery(reminder.id, reminder.dueDate))) {
      skipped++;
      continue;
    }

    try {
      const scheduledFor = formatFullRussianDate(new Date(reminder.dueDate), timezone);

      await bot.api.sendMessage(
        reminder.chatId,
        `🔔 <b>НАПОМИНАНИЕ</b>\n\n` +
          `📌 <b>${esc(reminder.text)}</b>\n\n` +
          `⏰ <i>Было назначено на:</i> ${esc(scheduledFor)}`,
        { parse_mode: 'HTML', reply_markup: reminderKeyboard(reminder.id) }
      );

      if (reminder.recurrence === 'none') {
        await markReminderFired(reminder.id);
      } else {
        const nextDue = calculateNextRecurrence(
          new Date(reminder.dueDate),
          reminder.recurrence,
          timezone,
          now,
          reminder.recurrenceRule
        );
        const updated: Reminder = { ...reminder, dueDate: nextDue.toISOString() };
        await saveReminder(updated);
        rescheduled++;
      }

      processed++;
    } catch (err: unknown) {
      if (isUndeliverable(err)) {
        // The user blocked the bot or removed the chat. The reminder is parked,
        // never deleted: /start restores everything when they come back.
        await pauseReminder(reminder.id, err.description);
        paused++;
        continue;
      }

      // Transient failure (Telegram 5xx, rate limit, Redis blip): drop the claim
      // so the next run retries this reminder in a minute.
      await releaseDelivery(reminder.id, reminder.dueDate);

      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to process reminder ${reminder.id}:`, err);
      errors.push(`${reminder.id}: ${message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    processed,
    rescheduled,
    paused,
    skipped,
    totalDue: dueReminders.length,
    deferredToNextRun: Math.max(0, dueReminders.length - batch.length),
    totalActive: allReminders.length,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: now.toISOString(),
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

// Some cron services issue POST instead of GET.
export async function POST(req: NextRequest) {
  return handle(req);
}
