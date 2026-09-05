export type RecurrenceType = 'none' | 'daily' | 'weekly' | 'monthly' | 'weekdays';

export interface Reminder {
  id: string;
  userId: number;
  chatId: number;
  text: string;
  dueDate: string; // ISO 8601 string
  timezone: string; // e.g. "Europe/Moscow"
  recurrence: RecurrenceType;
  recurrenceRule?: {
    timeStr?: string; // HH:mm
    dayOfWeek?: number; // 0-6 (Sunday - Saturday)
    dayOfMonth?: number; // 1-31
  };
  createdAt: string;
}

export interface UserSettings {
  userId: number;
  timezone: string; // e.g. "Europe/Moscow" or "UTC"
  updatedAt: string;
}

export interface ParsedReminderResult {
  text: string;
  dueDate: Date;
  recurrence: RecurrenceType;
  recurrenceRule?: Reminder['recurrenceRule'];
  matchedPattern?: string;
}
