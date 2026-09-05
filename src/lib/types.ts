export type RecurrenceType = 'none' | 'daily' | 'weekly' | 'monthly' | 'weekdays';

/**
 * `active`  — waiting to fire (present in the `active_reminders` set)
 * `fired`   — already sent; kept only so snooze/reschedule buttons still work
 * `paused`  — delivery failed because the user blocked or removed the bot;
 *             kept indefinitely and restored automatically on the next /start
 */
export type ReminderStatus = 'active' | 'fired' | 'paused';

export interface Reminder {
  id: string;
  userId: number;
  chatId: number;
  text: string;
  dueDate: string; // ISO 8601 string
  timezone: string; // e.g. "Europe/Zurich"
  recurrence: RecurrenceType;
  recurrenceRule?: {
    timeStr?: string; // HH:mm
    dayOfWeek?: number; // 0-6 (Sunday - Saturday)
    dayOfMonth?: number; // 1-31
  };
  status?: ReminderStatus; // absent on legacy records => treated as 'active'
  createdAt: string;
  firedAt?: string;
  pausedAt?: string;
  pauseReason?: string;
}

export interface UserSettings {
  userId: number;
  timezone: string; // e.g. "Europe/Zurich" or "UTC"
  updatedAt: string;
}

export interface ParsedReminderResult {
  text: string;
  dueDate: Date;
  recurrence: RecurrenceType;
  recurrenceRule?: Reminder['recurrenceRule'];
  matchedPattern?: string;
}
