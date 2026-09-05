/** Default timezone used for new users and as a fallback everywhere. */
export const DEFAULT_TIMEZONE = 'Europe/Zurich';

export interface TimezoneOption {
  /** IANA timezone identifier */
  id: string;
  /** Short human label shown on buttons */
  label: string;
}

/**
 * Main European timezones offered as one-tap buttons.
 * Any other IANA zone can still be set manually via `/tz <Zone>`.
 */
export const EUROPEAN_TIMEZONES: TimezoneOption[] = [
  { id: 'Europe/Zurich', label: '🇨🇭 Цюрих' },
  { id: 'Europe/Berlin', label: '🇩🇪 Берлин' },
  { id: 'Europe/Paris', label: '🇫🇷 Париж' },
  { id: 'Europe/London', label: '🇬🇧 Лондон' },
  { id: 'Europe/Amsterdam', label: '🇳🇱 Амстердам' },
  { id: 'Europe/Brussels', label: '🇧🇪 Брюссель' },
  { id: 'Europe/Vienna', label: '🇦🇹 Вена' },
  { id: 'Europe/Rome', label: '🇮🇹 Рим' },
  { id: 'Europe/Madrid', label: '🇪🇸 Мадрид' },
  { id: 'Europe/Lisbon', label: '🇵🇹 Лиссабон' },
  { id: 'Europe/Dublin', label: '🇮🇪 Дублин' },
  { id: 'Europe/Prague', label: '🇨🇿 Прага' },
  { id: 'Europe/Warsaw', label: '🇵🇱 Варшава' },
  { id: 'Europe/Budapest', label: '🇭🇺 Будапешт' },
  { id: 'Europe/Stockholm', label: '🇸🇪 Стокгольм' },
  { id: 'Europe/Oslo', label: '🇳🇴 Осло' },
  { id: 'Europe/Copenhagen', label: '🇩🇰 Копенгаген' },
  { id: 'Europe/Helsinki', label: '🇫🇮 Хельсинки' },
  { id: 'Europe/Athens', label: '🇬🇷 Афины' },
  { id: 'Europe/Bucharest', label: '🇷🇴 Бухарест' },
  { id: 'Europe/Belgrade', label: '🇷🇸 Белград' },
  { id: 'Europe/Istanbul', label: '🇹🇷 Стамбул' },
  { id: 'Europe/Moscow', label: '🇷🇺 Москва' },
  { id: 'UTC', label: '🌐 UTC' },
];

/** Returns true if the string is a timezone the runtime actually knows. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Current UTC offset of a zone as a short label, e.g. "UTC+2".
 * Computed live, so it is always DST-correct.
 */
export function getUtcOffsetLabel(tz: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    return name.replace('GMT', 'UTC').replace(/^UTC$/, 'UTC+0');
  } catch {
    return '';
  }
}

/** Current local time in a zone, e.g. "14:05". */
export function getLocalTimeLabel(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
  } catch {
    return '';
  }
}
