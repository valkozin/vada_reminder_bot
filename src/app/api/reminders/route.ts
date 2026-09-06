import { NextRequest, NextResponse } from 'next/server';
import { fromZonedTime } from 'date-fns-tz';
import { getUserReminders, getOwnedReminder, saveReminder, deleteReminder, getUserTimezone } from '@/lib/db';
import { authorizeWebAppRequest } from '@/lib/webapp-auth';
import { formatFullRussianDate, formatTimeUntil } from '@/lib/parser';
import { DEFAULT_TIMEZONE } from '@/lib/timezones';
import { Reminder } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_TEXT_LENGTH = 500;

/** Everything the Mini App needs to render one row. */
function serialize(reminder: Reminder, timezone: string) {
  const due = new Date(reminder.dueDate);
  return {
    id: reminder.id,
    text: reminder.text,
    dueDate: reminder.dueDate,
    dueLabel: formatFullRussianDate(due, timezone),
    timeUntil: formatTimeUntil(due),
    recurrence: reminder.recurrence,
    status: reminder.status ?? 'active',
    overdue: due.getTime() <= Date.now(),
  };
}

/** "YYYY-MM-DDTHH:mm" from the page, read as wall-clock time in the user's zone. */
function parseLocalDateTime(value: unknown, timezone: string): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;

  const instant = fromZonedTime(`${value}:00`, timezone);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

export async function GET(req: NextRequest) {
  const user = authorizeWebAppRequest(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const [reminders, timezone] = await Promise.all([
    getUserReminders(user.id),
    getUserTimezone(user.id),
  ]);

  return NextResponse.json({
    ok: true,
    timezone,
    firstName: user.firstName ?? null,
    reminders: reminders.map((r) => serialize(r, timezone)),
  });
}

export async function PATCH(req: NextRequest) {
  const user = authorizeWebAppRequest(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let body: { id?: unknown; text?: unknown; dueLocal?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed body' }, { status: 400 });
  }

  if (typeof body.id !== 'string') {
    return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
  }

  // Ownership is re-checked in storage: an id from the page proves nothing.
  const existing = await getOwnedReminder(body.id, user.id);
  if (!existing) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });

  const timezone = existing.timezone || (await getUserTimezone(user.id)) || DEFAULT_TIMEZONE;
  const updated: Reminder = { ...existing };

  if (body.text !== undefined) {
    if (typeof body.text !== 'string') {
      return NextResponse.json({ ok: false, error: 'text must be a string' }, { status: 400 });
    }
    const text = body.text.trim();
    if (!text) {
      return NextResponse.json({ ok: false, error: 'Текст не может быть пустым' }, { status: 400 });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { ok: false, error: `Текст длиннее ${MAX_TEXT_LENGTH} символов` },
        { status: 400 }
      );
    }
    updated.text = text;
  }

  if (body.dueLocal !== undefined) {
    const due = parseLocalDateTime(body.dueLocal, timezone);
    if (!due) {
      return NextResponse.json({ ok: false, error: 'Некорректные дата или время' }, { status: 400 });
    }
    updated.dueDate = due.toISOString();

    // Keep the recurrence rule in step with the new time of day.
    if (updated.recurrenceRule?.timeStr) {
      const [, hhmm] = String(body.dueLocal).split('T');
      updated.recurrenceRule = { ...updated.recurrenceRule, timeStr: hhmm };
    }
  }

  // saveReminder puts a paused reminder back into the delivery queue, which is
  // what editing it in the app should mean.
  await saveReminder(updated);

  return NextResponse.json({ ok: true, reminder: serialize(updated, timezone) });
}

export async function DELETE(req: NextRequest) {
  const user = authorizeWebAppRequest(req);
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });

  const deleted = await deleteReminder(id, user.id);
  if (!deleted) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
