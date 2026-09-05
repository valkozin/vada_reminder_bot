import {
  addMinutes,
  addHours,
  addDays,
  addWeeks,
  addMonths,
  setHours,
  setMinutes,
  setSeconds,
  setMilliseconds,
} from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { ParsedReminderResult } from './types';
import { DEFAULT_TIMEZONE } from './timezones';

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------

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
  сентября: 8, сен: 8, сент: 8, сентябрь: 8,
  октября: 9, окт: 9, октябрь: 9,
  ноября: 10, ноя: 10, нояб: 10, ноябрь: 10,
  декабря: 11, дек: 11, декабрь: 11,
};

// Days of week mapping (0 = Sunday, 1 = Monday, ...)
const DAYS_OF_WEEK_RU: Record<string, number> = {
  воскресенье: 0, воскресенья: 0, вс: 0,
  понедельник: 1, понедельника: 1, пн: 1,
  вторник: 2, вторника: 2, вт: 2,
  среда: 3, среду: 3, среды: 3, ср: 3,
  четверг: 4, четверга: 4, чт: 4,
  пятница: 5, пятницу: 5, пятницы: 5, пт: 5,
  суббота: 6, субботу: 6, субботы: 6, сб: 6,
};

// Numerals written as words ("через пять минут")
const NUMBER_WORDS_RU: Record<string, number> = {
  один: 1, одну: 1, одна: 1, одного: 1,
  два: 2, две: 2, двух: 2, пару: 2, пара: 2,
  три: 3, трех: 3, трёх: 3,
  четыре: 4, четырех: 4, четырёх: 4,
  пять: 5, пяти: 5,
  шесть: 6, шести: 6,
  семь: 7, семи: 7,
  восемь: 8, восьми: 8,
  девять: 9, девяти: 9,
  десять: 10, десяти: 10,
  одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14,
  пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18,
  девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
};

// Parts of the day mapped to a concrete hour
const DAY_PARTS_RU: Record<string, number> = {
  утром: 9, утра: 9,
  днем: 13, днём: 13, дня: 13, обед: 13,
  вечером: 19, вечера: 19,
  ночью: 23, ночи: 23,
};

/** Default hour used when a date is given without a time ("завтра купить хлеб"). */
const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;

// ---------------------------------------------------------------------------
// Regex building blocks
// ---------------------------------------------------------------------------

/** Sorts alternatives longest-first so "тридцать" wins over "три". */
function alt(words: string[]): string {
  return [...words].sort((a, b) => b.length - a.length).join('|');
}

const NUM_WORDS = alt(Object.keys(NUMBER_WORDS_RU));
const DAYS = alt(Object.keys(DAYS_OF_WEEK_RU));
const MONTHS = alt(Object.keys(MONTHS_RU));
const DAY_PARTS = alt(Object.keys(DAY_PARTS_RU));

const MINUTE_UNITS = ['минут', 'минуту', 'минуты', 'минутки', 'минутку', 'мин', 'м'];
const HOUR_UNITS = ['час', 'часа', 'часов', 'часика', 'часик', 'ч'];
const DAY_UNITS = ['день', 'дня', 'дней', 'сутки', 'суток', 'д'];
const WEEK_UNITS = ['неделю', 'недели', 'недель', 'неделя', 'нед'];
const ALL_UNITS = alt([...MINUTE_UNITS, ...HOUR_UNITS, ...DAY_UNITS, ...WEEK_UNITS]);
const DAY_UNITS_ALT = alt(DAY_UNITS);

/** A count: either digits or a Russian numeral word. */
const COUNT = `(\\d{1,4}|${NUM_WORDS})`;

/** Word boundaries that also work for Cyrillic (\b only knows ASCII). */
const LB = '(?<![0-9a-zа-яё])';
const RB = '(?![0-9a-zа-яё])';

/** Clock time: "15:30", "15.30", "15-30". */
const CLOCK = '(\\d{1,2})[:.\\-](\\d{2})';

// ---------------------------------------------------------------------------
// Text cleanup
// ---------------------------------------------------------------------------

/**
 * Removes command-like filler that carries no meaning for the reminder text:
 * "напомни мне что ...", "поставь напоминание ...", "не забыть ...".
 * Applied both before parsing and to whatever is left after the date is cut out,
 * so "через минуту напомни съесть" and "напомни съесть через минуту" behave alike.
 */
function stripFillers(input: string): string {
  // Reminder verbs that carry no task meaning on their own.
  const VERBS = new RegExp(
    `^(?:напомни(?:ть|шь|те)?|напоминай|напоминание|напоминалка|разбуди|нужно|надо|не\\s+забыть|не\\s+забудь)${RB}`,
    'i'
  );
  // "поставь"/"создай" only count as filler together with their object, so
  // "поставь чайник через 5 минут" keeps the word "поставь".
  const VERBS_WITH_OBJECT = new RegExp(
    `^(?:поставь|постав(?:ить)?|создай|создать|добавь|добавить|запланируй|запиши)\\s+` +
      `(?:напоминание|напоминалку|задачу|задание|таск)${RB}`,
    'i'
  );
  const PRONOUNS = new RegExp(`^\\s*(?:мне|нам|пожалуйста|плз|плиз)${RB}`, 'i');
  const CONNECTIVES = new RegExp(`^\\s*(?:что\\s+бы|чтобы|что|про|о)${RB}`, 'i');

  let text = input.trim();
  let changed = true;

  while (changed) {
    const before = text;
    text = text
      .replace(/^[\s,.\-–—:;!]+/, '')
      .replace(VERBS_WITH_OBJECT, '')
      .replace(VERBS, '')
      .replace(PRONOUNS, '')
      .replace(/^\s*о\s+том\s*,?\s*/i, '')
      .replace(CONNECTIVES, '')
      .trim();
    changed = text !== before;
  }

  return text.replace(/[\s,.\-–—:;]+$/, '').trim();
}

/** Uppercases the first letter, leaving the rest of the user's casing intact. */
function capitalize(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Finds `re` anywhere in `text` and returns the match together with the text
 * that remains once the matched span is cut out.
 */
function findAndCut(text: string, re: RegExp): { m: RegExpMatchArray; rest: string } | null {
  const m = text.match(re);
  if (!m || m.index === undefined) return null;
  const rest = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { m, rest };
}

/** Resolves a count group that may be digits, a word, or absent (meaning 1). */
function toCount(raw: string | undefined): number {
  if (!raw) return 1;
  const digits = parseInt(raw, 10);
  if (!Number.isNaN(digits)) return digits;
  return NUMBER_WORDS_RU[raw.toLowerCase()] ?? 1;
}

function isValidClock(hours: number, minutes: number): boolean {
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function atTime(date: Date, hours: number, minutes: number): Date {
  return setHours(setMinutes(setSeconds(setMilliseconds(date, 0), 0), minutes), hours);
}

function unitToMinutes(unitRaw: string, amount: number): number {
  const unit = unitRaw.toLowerCase();
  if (MINUTE_UNITS.includes(unit)) return amount;
  if (HOUR_UNITS.includes(unit)) return amount * 60;
  if (DAY_UNITS.includes(unit)) return amount * 60 * 24;
  if (WEEK_UNITS.includes(unit)) return amount * 60 * 24 * 7;
  return 0;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parses user input and extracts the scheduled date, recurrence and clean text.
 *
 * The date expression may appear anywhere in the sentence — at the start
 * ("через минуту полить цветок"), at the end ("полить цветок через минуту")
 * or after filler words ("напомни полить цветок через минуту").
 *
 * @param input Raw text typed by the user
 * @param timezone User timezone (e.g. "Europe/Zurich")
 * @param nowUtc Current UTC date (injectable for tests)
 */
export function parseReminderInput(
  input: string,
  timezone: string = DEFAULT_TIMEZONE,
  nowUtc: Date = new Date()
): ParsedReminderResult | null {
  const trimmed = stripFillers(input);
  if (!trimmed) return null;

  // Wall-clock "now" in the user's timezone. All arithmetic happens in this
  // zoned space and is converted back to a real UTC instant at the very end,
  // which keeps results correct across DST transitions.
  const userNow = toZonedTime(nowUtc, timezone);

  const finish = (
    zonedDate: Date,
    rest: string,
    recurrence: ParsedReminderResult['recurrence'],
    matchedPattern: string,
    recurrenceRule?: ParsedReminderResult['recurrenceRule']
  ): ParsedReminderResult => ({
    text: capitalize(stripFillers(rest)),
    dueDate: fromZonedTime(zonedDate, timezone),
    recurrence,
    recurrenceRule,
    matchedPattern,
  });

  // --- 1. RECURRING DAILY: "каждый день в 09:00", "ежедневно в 9:00" ---------
  const daily = findAndCut(
    trimmed,
    new RegExp(`${LB}(?:кажд(?:ый|ое)\\s+(?:день|сутки)|ежедневно)\\s*(?:в\\s+)?${CLOCK}${RB}`, 'i')
  );
  if (daily && isValidClock(+daily.m[1], +daily.m[2])) {
    const hours = +daily.m[1];
    const minutes = +daily.m[2];
    return finish(nextOccurrence(userNow, hours, minutes), daily.rest, 'daily', 'recurring_daily', {
      timeStr: `${pad(hours)}:${pad(minutes)}`,
    });
  }

  // --- 2. RECURRING WEEKDAYS: "по будням в 09:00" ---------------------------
  const weekdays = findAndCut(
    trimmed,
    new RegExp(
      `${LB}(?:по\\s+будням|кажд(?:ый|ые)\\s+будни(?:й\\s+день)?|по\\s+рабочим\\s+дням)\\s*(?:в\\s+)?${CLOCK}${RB}`,
      'i'
    )
  );
  if (weekdays && isValidClock(+weekdays.m[1], +weekdays.m[2])) {
    const hours = +weekdays.m[1];
    const minutes = +weekdays.m[2];
    let target = nextOccurrence(userNow, hours, minutes);
    while (target.getDay() === 0 || target.getDay() === 6) {
      target = addDays(target, 1);
    }
    return finish(target, weekdays.rest, 'weekdays', 'recurring_weekdays', {
      timeStr: `${pad(hours)}:${pad(minutes)}`,
    });
  }

  // --- 3. RECURRING WEEKLY: "каждую пятницу в 18:00" ------------------------
  const weekly = findAndCut(
    trimmed,
    new RegExp(`${LB}кажд(?:ый|ую|ое)\\s+(${DAYS})${RB}\\s*(?:в\\s+)?${CLOCK}${RB}`, 'i')
  );
  if (weekly && isValidClock(+weekly.m[2], +weekly.m[3])) {
    const dayOfWeek = DAYS_OF_WEEK_RU[weekly.m[1].toLowerCase()];
    const hours = +weekly.m[2];
    const minutes = +weekly.m[3];
    if (dayOfWeek !== undefined) {
      return finish(
        nextDayOfWeek(userNow, dayOfWeek, hours, minutes),
        weekly.rest,
        'weekly',
        'recurring_weekly',
        { dayOfWeek, timeStr: `${pad(hours)}:${pad(minutes)}` }
      );
    }
  }

  // --- 4. RECURRING MONTHLY: "каждое 15 число в 10:00" ----------------------
  const monthly = findAndCut(
    trimmed,
    new RegExp(`${LB}кажд(?:ый|ое|ого)\\s+(\\d{1,2})\\s*числ[оаеу]?${RB}\\s*(?:в\\s+)?${CLOCK}${RB}`, 'i')
  );
  if (monthly && isValidClock(+monthly.m[2], +monthly.m[3])) {
    const dayOfMonth = +monthly.m[1];
    const hours = +monthly.m[2];
    const minutes = +monthly.m[3];
    if (dayOfMonth >= 1 && dayOfMonth <= 31) {
      let target = atTime(new Date(userNow.getFullYear(), userNow.getMonth(), dayOfMonth), hours, minutes);
      if (target <= userNow) target = addMonths(target, 1);
      return finish(target, monthly.rest, 'monthly', 'recurring_monthly', {
        dayOfMonth,
        timeStr: `${pad(hours)}:${pad(minutes)}`,
      });
    }
  }

  // --- 5. RELATIVE DAYS WITH TIME: "через 2 дня в 15:00" --------------------
  const relDaysAtTime = findAndCut(
    trimmed,
    new RegExp(`${LB}через\\s+(?:${COUNT}\\s+)?(${DAY_UNITS_ALT})${RB}\\s+(?:в\\s+)?${CLOCK}${RB}`, 'i')
  );
  if (relDaysAtTime && isValidClock(+relDaysAtTime.m[3], +relDaysAtTime.m[4])) {
    const days = toCount(relDaysAtTime.m[1]);
    const target = atTime(addDays(userNow, days), +relDaysAtTime.m[3], +relDaysAtTime.m[4]);
    return finish(target, relDaysAtTime.rest, 'none', 'relative_days_with_time');
  }

  // --- 6. RELATIVE OFFSET: "через минуту", "через 5 минут", "через 1 час 30 минут" ---
  const half = findAndCut(trimmed, new RegExp(`${LB}через\\s+пол\\s?часа${RB}`, 'i'));
  if (half) {
    return finish(addMinutes(userNow, 30), half.rest, 'none', 'relative_offset');
  }

  const relative = findAndCut(
    trimmed,
    new RegExp(
      `${LB}через\\s+(?:${COUNT}\\s+)?(${ALL_UNITS})${RB}` +
        `(?:\\s+(?:${COUNT}\\s+)?(${ALL_UNITS})${RB})?`,
      'i'
    )
  );
  if (relative) {
    let offsetMinutes = unitToMinutes(relative.m[2], toCount(relative.m[1]));
    if (relative.m[4]) {
      offsetMinutes += unitToMinutes(relative.m[4], toCount(relative.m[3]));
    }
    if (offsetMinutes > 0) {
      // Whole days/weeks keep the current wall-clock time; minutes/hours add up.
      const target = addMinutes(setSeconds(setMilliseconds(userNow, 0), 0), offsetMinutes);
      return finish(target, relative.rest, 'none', 'relative_offset');
    }
  }

  // --- 7. DAY PHRASE WITH TIME: "завтра в 15:00", "сегодня вечером" ---------
  const dayPhraseAtTime = findAndCut(
    trimmed,
    new RegExp(`${LB}(сегодня|завтра|послезавтра)${RB}\\s+(?:в\\s+)?${CLOCK}${RB}`, 'i')
  );
  if (dayPhraseAtTime && isValidClock(+dayPhraseAtTime.m[2], +dayPhraseAtTime.m[3])) {
    const target = atTime(
      shiftByDayWord(userNow, dayPhraseAtTime.m[1]),
      +dayPhraseAtTime.m[2],
      +dayPhraseAtTime.m[3]
    );
    return finish(target, dayPhraseAtTime.rest, 'none', 'day_phrase');
  }

  const dayPhraseAtPart = findAndCut(
    trimmed,
    new RegExp(`${LB}(сегодня|завтра|послезавтра)${RB}\\s+(?:в\\s+)?(${DAY_PARTS})${RB}`, 'i')
  );
  if (dayPhraseAtPart) {
    const hour = DAY_PARTS_RU[dayPhraseAtPart.m[2].toLowerCase()];
    const target = atTime(shiftByDayWord(userNow, dayPhraseAtPart.m[1]), hour, 0);
    return finish(target, dayPhraseAtPart.rest, 'none', 'day_phrase_part');
  }

  // --- 8. DAY OF WEEK: "в понедельник в 10:00", "в пятницу вечером" ---------
  const dowAtTime = findAndCut(
    trimmed,
    new RegExp(`${LB}(?:в|во)\\s+(${DAYS})${RB}\\s+(?:в\\s+)?${CLOCK}${RB}`, 'i')
  );
  if (dowAtTime && isValidClock(+dowAtTime.m[2], +dowAtTime.m[3])) {
    const dayOfWeek = DAYS_OF_WEEK_RU[dowAtTime.m[1].toLowerCase()];
    if (dayOfWeek !== undefined) {
      return finish(
        nextDayOfWeek(userNow, dayOfWeek, +dowAtTime.m[2], +dowAtTime.m[3]),
        dowAtTime.rest,
        'none',
        'day_of_week'
      );
    }
  }

  const dowAtPart = findAndCut(
    trimmed,
    new RegExp(`${LB}(?:в|во)\\s+(${DAYS})${RB}(?:\\s+(${DAY_PARTS})${RB})?`, 'i')
  );
  if (dowAtPart) {
    const dayOfWeek = DAYS_OF_WEEK_RU[dowAtPart.m[1].toLowerCase()];
    if (dayOfWeek !== undefined) {
      const hour = dowAtPart.m[2] ? DAY_PARTS_RU[dowAtPart.m[2].toLowerCase()] : DEFAULT_HOUR;
      return finish(
        nextDayOfWeek(userNow, dayOfWeek, hour, 0),
        dowAtPart.rest,
        'none',
        'day_of_week'
      );
    }
  }

  // --- 9. NUMERIC DATE: "15.09 в 12:00", "25.12.2026 12:00", "15.09" -------
  const numericDate = findAndCut(
    trimmed,
    new RegExp(`${LB}(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?(?:\\s+(?:в\\s+)?${CLOCK})?${RB}`, 'i')
  );
  if (numericDate) {
    const day = +numericDate.m[1];
    const month = +numericDate.m[2] - 1;
    const hasTime = numericDate.m[4] !== undefined;
    const hours = hasTime ? +numericDate.m[4] : DEFAULT_HOUR;
    const minutes = hasTime ? +numericDate.m[5] : DEFAULT_MINUTE;

    if (day >= 1 && day <= 31 && month >= 0 && month <= 11 && isValidClock(hours, minutes)) {
      let year = numericDate.m[3] ? +numericDate.m[3] : userNow.getFullYear();
      if (year < 100) year += 2000;
      let target = atTime(new Date(year, month, day), hours, minutes);
      // A bare "15.09" that already passed means next year.
      if (!numericDate.m[3] && target <= userNow) {
        target = atTime(new Date(year + 1, month, day), hours, minutes);
      }
      return finish(target, numericDate.rest, 'none', 'numeric_date');
    }
  }

  // --- 10. TEXT MONTH: "15 сентября в 10:00", "15 сентября" ----------------
  const textMonth = findAndCut(
    trimmed,
    new RegExp(`${LB}(\\d{1,2})\\s+(${MONTHS})${RB}(?:\\s+(\\d{4}))?(?:\\s+(?:в\\s+)?${CLOCK})?${RB}`, 'i')
  );
  if (textMonth) {
    const day = +textMonth.m[1];
    const month = MONTHS_RU[textMonth.m[2].toLowerCase()];
    const hasTime = textMonth.m[4] !== undefined;
    const hours = hasTime ? +textMonth.m[4] : DEFAULT_HOUR;
    const minutes = hasTime ? +textMonth.m[5] : DEFAULT_MINUTE;

    if (month !== undefined && day >= 1 && day <= 31 && isValidClock(hours, minutes)) {
      const year = textMonth.m[3] ? +textMonth.m[3] : userNow.getFullYear();
      let target = atTime(new Date(year, month, day), hours, minutes);
      if (!textMonth.m[3] && target <= userNow) {
        target = atTime(new Date(year + 1, month, day), hours, minutes);
      }
      return finish(target, textMonth.rest, 'none', 'text_month_date');
    }
  }

  // --- 11. CLOCK TIME ANYWHERE: "в 19:00", "19:00" -------------------------
  const timeOnly = findAndCut(trimmed, new RegExp(`${LB}(?:в\\s+)?${CLOCK}${RB}`, 'i'));
  if (timeOnly && isValidClock(+timeOnly.m[1], +timeOnly.m[2])) {
    return finish(
      nextOccurrence(userNow, +timeOnly.m[1], +timeOnly.m[2]),
      timeOnly.rest,
      'none',
      'time_only'
    );
  }

  // --- 12. HOUR IN WORDS: "в 9 утра", "в 5 часов", "в 7 вечера" ------------
  const hourWords = findAndCut(
    trimmed,
    new RegExp(`${LB}в\\s+(\\d{1,2})\\s*(?:час(?:ов|а)?)?(?:\\s*(${DAY_PARTS}))?${RB}`, 'i')
  );
  if (hourWords) {
    let hours = +hourWords.m[1];
    const part = hourWords.m[2]?.toLowerCase();
    // "в 7 вечера" -> 19:00, "в 9 утра" -> 09:00
    if (part && DAY_PARTS_RU[part] >= 13 && hours < 12) hours += 12;
    if (hours >= 0 && hours <= 23) {
      return finish(nextOccurrence(userNow, hours, 0), hourWords.rest, 'none', 'hour_words');
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Date helpers (all operate on zoned wall-clock Dates)
// ---------------------------------------------------------------------------

function shiftByDayWord(now: Date, word: string): Date {
  const w = word.toLowerCase();
  if (w === 'завтра') return addDays(now, 1);
  if (w === 'послезавтра') return addDays(now, 2);
  return new Date(now);
}

/** Next occurrence of HH:mm — today if still ahead, otherwise tomorrow. */
function nextOccurrence(now: Date, hours: number, minutes: number): Date {
  let target = atTime(now, hours, minutes);
  if (target <= now) target = addDays(target, 1);
  return target;
}

/** Next occurrence of a weekday at HH:mm. */
function nextDayOfWeek(now: Date, targetDayOfWeek: number, hours: number, minutes: number): Date {
  const target = atTime(now, hours, minutes);
  let daysToAdd = (targetDayOfWeek - now.getDay() + 7) % 7;
  if (daysToAdd === 0 && target <= now) daysToAdd = 7;
  return addDays(target, daysToAdd);
}

function pad(num: number): string {
  return num.toString().padStart(2, '0');
}

/**
 * Advances a recurring reminder to its next due instant, skipping any
 * occurrences already in the past (e.g. after cron downtime).
 * Arithmetic is done on wall-clock time in the reminder's own timezone so the
 * local hour stays stable across DST changes.
 */
export function calculateNextRecurrence(
  currentDueUtc: Date,
  recurrence: string,
  timezone: string,
  nowUtc: Date = new Date(),
  rule?: { dayOfWeek?: number; dayOfMonth?: number; timeStr?: string }
): Date {
  let zoned = toZonedTime(currentDueUtc, timezone);
  let guard = 0;

  do {
    if (recurrence === 'daily') {
      zoned = addDays(zoned, 1);
    } else if (recurrence === 'weekly') {
      zoned = addWeeks(zoned, 1);
    } else if (recurrence === 'weekdays') {
      do {
        zoned = addDays(zoned, 1);
      } while (zoned.getDay() === 0 || zoned.getDay() === 6);
    } else if (recurrence === 'monthly') {
      zoned = addMonths(zoned, 1);
      if (rule?.dayOfMonth) {
        // addMonths clamps 31 -> 30/28; restore the intended day when possible.
        const clamped = new Date(zoned.getFullYear(), zoned.getMonth(), rule.dayOfMonth);
        if (clamped.getMonth() === zoned.getMonth()) {
          zoned = atTime(clamped, zoned.getHours(), zoned.getMinutes());
        }
      }
    } else {
      break;
    }
    guard++;
  } while (fromZonedTime(zoned, timezone) <= nowUtc && guard < 500);

  return fromZonedTime(zoned, timezone);
}

/**
 * Formats a Date into a human-friendly Russian string with the day of week:
 * e.g. "Воскресенье, 15 января в 15:00" or "Четверг, 7 сентября 2026 г. в 10:30"
 */
export function formatFullRussianDate(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  const zoned = toZonedTime(date, timezone);
  const weekday = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, weekday: 'long' }).format(date);
  const dateStr = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
  }).format(date);
  const timeStr = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);

  const capitalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  const currentYear = toZonedTime(new Date(), timezone).getFullYear();
  const yearStr = zoned.getFullYear() !== currentYear ? ` ${zoned.getFullYear()} г.` : '';

  return `${capitalizedWeekday}, ${dateStr}${yearStr} в ${timeStr}`;
}

/** Human-readable "через 2 ч 15 мин" style countdown used in /list. */
export function formatTimeUntil(target: Date, from: Date = new Date()): string {
  const diffMs = target.getTime() - from.getTime();
  if (diffMs <= 0) return 'уже наступило';

  const totalMinutes = Math.round(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `через ${days} дн. ${hours} ч`;
  if (hours > 0) return `через ${hours} ч ${minutes} мин`;
  return `через ${minutes} мин`;
}
