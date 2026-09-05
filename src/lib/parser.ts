import { addMinutes, addHours, addDays, setHours, setMinutes, setSeconds, setMilliseconds, addWeeks, setDate, setMonth } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { ParsedReminderResult, RecurrenceType } from './types';

// Month names in Russian (genitive case & nominative)
const MONTHS_RU: Record<string, number> = {
  января: 0, янв: 0, январь: 0,
  февраля: 1, фев: 1, февраль: 1,
  марта: 2, мар: 2, март: 2,
  апреля: 3, апр: 3, апрель: 3,
  мая: 4, май: 4,
  июня: 5, июн: 5, июнь: 5,
  июля: 6, июл: 6, июль: 6,
  августа: 7, авг: 7, август: 7,
  сентября: 8, сен: 8, сентябрь: 8,
  октября: 9, окт: 9, октябрь: 9,
  ноября: 10, ноя: 10, ноябрь: 10,
  декабря: 11, дек: 11, декабрь: 11,
};

// Days of week mapping (0 = Sunday, 1 = Monday, ...)
const DAYS_OF_WEEK_RU: Record<string, number> = {
  воскресенье: 0, вс: 0,
  понедельник: 1, пн: 1,
  вторник: 2, вт: 2,
  среда: 3, среду: 3, ср: 3,
  четверг: 4, чт: 4,
  пятница: 5, пятницу: 5, пт: 5,
  суббота: 6, субботу: 6, сб: 6,
};

/**
 * Parses user input string and extracts scheduled date, recurrence, and clean reminder text.
 * @param input Raw text typed by user (e.g. "завтра в 15:00 Купить продукты")
 * @param timezone User timezone (e.g. "Europe/Moscow" or "UTC")
 * @param nowUtc Current UTC date
 */
export function parseReminderInput(
  input: string,
  timezone: string = 'UTC',
  nowUtc: Date = new Date()
): ParsedReminderResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Convert current UTC time to user's zoned local time
  const userNow = toZonedTime(nowUtc, timezone);

  // 1. RECURRING: "каждый день в 09:00 [текст]", "ежедневно в 09:00", "по будням в 9:00"
  const recurringDailyMatch = trimmed.match(/^(?:каждый\s+день|ежедневно)\s+(?:в\s+)?(\d{1,2})[:.-](\d{2})\s+(.+)$/i);
  if (recurringDailyMatch) {
    const hours = parseInt(recurringDailyMatch[1], 10);
    const minutes = parseInt(recurringDailyMatch[2], 10);
    const reminderText = recurringDailyMatch[3].trim();
    const targetDate = calculateNextOccurrenceTime(userNow, hours, minutes);
    return {
      text: reminderText,
      dueDate: fromZonedTime(targetDate, timezone),
      recurrence: 'daily',
      recurrenceRule: { timeStr: `${pad(hours)}:${pad(minutes)}` },
      matchedPattern: 'recurring_daily',
    };
  }

  // RECURRING WEEKDAYS: "по будням в 09:00 [текст]", "каждый будний день в 09:00"
  const recurringWeekdaysMatch = trimmed.match(/^(?:по\s+будням|каждый\s+будний\s+день)\s+(?:в\s+)?(\d{1,2})[:.-](\d{2})\s+(.+)$/i);
  if (recurringWeekdaysMatch) {
    const hours = parseInt(recurringWeekdaysMatch[1], 10);
    const minutes = parseInt(recurringWeekdaysMatch[2], 10);
    const reminderText = recurringWeekdaysMatch[3].trim();
    let targetDate = calculateNextOccurrenceTime(userNow, hours, minutes);
    // If weekend, skip to Monday
    while (targetDate.getDay() === 0 || targetDate.getDay() === 6) {
      targetDate = addDays(targetDate, 1);
    }
    return {
      text: reminderText,
      dueDate: fromZonedTime(targetDate, timezone),
      recurrence: 'weekdays',
      recurrenceRule: { timeStr: `${pad(hours)}:${pad(minutes)}` },
      matchedPattern: 'recurring_weekdays',
    };
  }

  // RECURRING WEEKLY: "каждый понедельник в 10:00 [текст]", "каждую пятницу в 18:00 [текст]"
  const recurringWeeklyMatch = trimmed.match(/^(?:каждый|каждую)\s+(понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье|пн|вт|ср|чт|пт|сб|вс)\s+(?:в\s+)?(\d{1,2})[:.-](\d{2})\s+(.+)$/i);
  if (recurringWeeklyMatch) {
    const dayStr = recurringWeeklyMatch[1].toLowerCase();
    const hours = parseInt(recurringWeeklyMatch[2], 10);
    const minutes = parseInt(recurringWeeklyMatch[3], 10);
    const reminderText = recurringWeeklyMatch[4].trim();
    const targetDayOfWeek = DAYS_OF_WEEK_RU[dayStr];
    if (targetDayOfWeek !== undefined) {
      const targetDate = calculateNextDayOfWeekTime(userNow, targetDayOfWeek, hours, minutes);
      return {
        text: reminderText,
        dueDate: fromZonedTime(targetDate, timezone),
        recurrence: 'weekly',
        recurrenceRule: { dayOfWeek: targetDayOfWeek, timeStr: `${pad(hours)}:${pad(minutes)}` },
        matchedPattern: 'recurring_weekly',
      };
    }
  }

  // 2. RELATIVE TIME: "через 15 минут [текст]", "через 2 часа [текст]", "через 3 дня [текст]"
  const relativeMatch = trimmed.match(/^(?:через|in)\s+(\d+)\s+(минут|минуту|минуты|мин|min|minutes|час|часа|часов|ч|hours|hour|h|день|дня|дней|д|days|day)\s+(.+)$/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unitStr = relativeMatch[2].toLowerCase();
    const reminderText = relativeMatch[3].trim();
    let targetDate = new Date(userNow);

    if (unitStr.startsWith('мин') || unitStr.startsWith('min') || unitStr === 'м') {
      targetDate = addMinutes(targetDate, amount);
    } else if (unitStr.startsWith('час') || unitStr.startsWith('hour') || unitStr === 'ч' || unitStr === 'h') {
      targetDate = addHours(targetDate, amount);
    } else if (unitStr.startsWith('ден') || unitStr.startsWith('дн') || unitStr.startsWith('day') || unitStr === 'д') {
      targetDate = addDays(targetDate, amount);
    }

    return {
      text: reminderText,
      dueDate: fromZonedTime(targetDate, timezone),
      recurrence: 'none',
      matchedPattern: 'relative_offset',
    };
  }

  // 3. SPECIFIC DAY PHRASES: "сегодня в 18:30 [текст]", "завтра в 09:00 [текст]", "послезавтра в 14:00 [текст]"
  const dayPhraseMatch = trimmed.match(/^(сегодня|завтра|послезавтра|today|tomorrow)\s+(?:в\s+|at\s+)?(\d{1,2})[:.-](\d{2})\s+(.+)$/i);
  if (dayPhraseMatch) {
    const dayWord = dayPhraseMatch[1].toLowerCase();
    const hours = parseInt(dayPhraseMatch[2], 10);
    const minutes = parseInt(dayPhraseMatch[3], 10);
    const reminderText = dayPhraseMatch[4].trim();

    let targetDate = new Date(userNow);
    if (dayWord === 'завтра' || dayWord === 'tomorrow') {
      targetDate = addDays(targetDate, 1);
    } else if (dayWord === 'послезавтра') {
      targetDate = addDays(targetDate, 2);
    }
    targetDate = setHours(setMinutes(setSeconds(setMilliseconds(targetDate, 0), 0), minutes), hours);

    return {
      text: reminderText,
      dueDate: fromZonedTime(targetDate, timezone),
      recurrence: 'none',
      matchedPattern: 'day_phrase',
    };
  }

  // 4. DAY OF WEEK PHRASES: "в понедельник в 10:00 [текст]", "во вторник в 15:00 [текст]"
  const dayOfWeekMatch = trimmed.match(/^(?:в|во)\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|пн|вт|ср|чт|пт|сб|вс)\s+(?:в\s+)?(\d{1,2})[:.-](\d{2})\s+(.+)$/i);
  if (dayOfWeekMatch) {
    const dayStr = dayOfWeekMatch[1].toLowerCase();
    const hours = parseInt(dayOfWeekMatch[2], 10);
    const minutes = parseInt(dayOfWeekMatch[3], 10);
    const reminderText = dayOfWeekMatch[4].trim();

    const targetDayOfWeek = DAYS_OF_WEEK_RU[dayStr];
    if (targetDayOfWeek !== undefined) {
      const targetDate = calculateNextDayOfWeekTime(userNow, targetDayOfWeek, hours, minutes);
      return {
        text: reminderText,
        dueDate: fromZonedTime(targetDate, timezone),
        recurrence: 'none',
        matchedPattern: 'day_of_week',
      };
    }
  }

  // 5. NUMERIC DATE: "15.09 в 12:00 [текст]", "15.09.2026 12:00 [текст]"
  const numericDateMatch = trimmed.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s+(?:в\s+)?(\d{1,2})[:.-](\d{2})\s+(.+)$/i);
  if (numericDateMatch) {
    const day = parseInt(numericDateMatch[1], 10);
    const month = parseInt(numericDateMatch[2], 10) - 1; // 0-indexed
    let year = numericDateMatch[3] ? parseInt(numericDateMatch[3], 10) : userNow.getFullYear();
    if (year < 100) year += 2000;
    const hours = parseInt(numericDateMatch[4], 10);
    const minutes = parseInt(numericDateMatch[5], 10);
    const reminderText = numericDateMatch[6].trim();

    let targetDate = new Date(year, month, day, hours, minutes, 0, 0);
    // If date passed without specified year, move to next year
    if (!numericDateMatch[3] && targetDate < userNow) {
      targetDate = new Date(year + 1, month, day, hours, minutes, 0, 0);
    }

    return {
      text: reminderText,
      dueDate: fromZonedTime(targetDate, timezone),
      recurrence: 'none',
      matchedPattern: 'numeric_date',
    };
  }

  // 6. TEXT MONTH: "15 сентября в 10:00 [текст]"
  const textMonthMatch = trimmed.match(/^(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|янв|фев|мар|апр|май|июн|июл|авг|сен|окт|ноя|дек)\s+(?:в\s+)?(\d{1,2})[:.-](\d{2})\s+(.+)$/i);
  if (textMonthMatch) {
    const day = parseInt(textMonthMatch[1], 10);
    const monthStr = textMonthMatch[2].toLowerCase();
    const month = MONTHS_RU[monthStr];
    const hours = parseInt(textMonthMatch[3], 10);
    const minutes = parseInt(textMonthMatch[4], 10);
    const reminderText = textMonthMatch[5].trim();

    if (month !== undefined) {
      let year = userNow.getFullYear();
      let targetDate = new Date(year, month, day, hours, minutes, 0, 0);
      if (targetDate < userNow) {
        targetDate = new Date(year + 1, month, day, hours, minutes, 0, 0);
      }
      return {
        text: reminderText,
        dueDate: fromZonedTime(targetDate, timezone),
        recurrence: 'none',
        matchedPattern: 'text_month_date',
      };
    }
  }

  // 7. TIME ONLY: "в 19:00 [текст]" or "19:00 [текст]"
  const timeOnlyMatch = trimmed.match(/^(?:в\s+|at\s+)?(\d{1,2})[:.-](\d{2})\s+(.+)$/i);
  if (timeOnlyMatch) {
    const hours = parseInt(timeOnlyMatch[1], 10);
    const minutes = parseInt(timeOnlyMatch[2], 10);
    const reminderText = timeOnlyMatch[3].trim();

    const targetDate = calculateNextOccurrenceTime(userNow, hours, minutes);
    return {
      text: reminderText,
      dueDate: fromZonedTime(targetDate, timezone),
      recurrence: 'none',
      matchedPattern: 'time_only',
    };
  }

  return null;
}

/** Helper: Calculate next time occurrence (today if in future, tomorrow if passed) */
function calculateNextOccurrenceTime(now: Date, hours: number, minutes: number): Date {
  let target = setHours(setMinutes(setSeconds(setMilliseconds(now, 0), 0), minutes), hours);
  if (target <= now) {
    target = addDays(target, 1);
  }
  return target;
}

/** Helper: Calculate next specific day of week occurrence */
function calculateNextDayOfWeekTime(now: Date, targetDayOfWeek: number, hours: number, minutes: number): Date {
  let target = setHours(setMinutes(setSeconds(setMilliseconds(now, 0), 0), minutes), hours);
  let currentDayOfWeek = now.getDay();
  let daysToAdd = (targetDayOfWeek - currentDayOfWeek + 7) % 7;
  
  if (daysToAdd === 0 && target <= now) {
    daysToAdd = 7;
  }
  return addDays(target, daysToAdd);
}

function pad(num: number): string {
  return num.toString().padStart(2, '0');
}
