import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authentication for the Mini App.
 *
 * Telegram hands the page an `initData` string signed with a key derived from
 * the bot token. Only Telegram and we can produce that signature, so a valid
 * `initData` proves both that the request came from inside Telegram and which
 * user sent it. There is no separate login, password or session cookie.
 *
 * Everything the page sends is otherwise untrusted: the user id is taken from
 * the verified payload, never from the request body.
 */

export interface WebAppUser {
  id: number;
  firstName?: string;
  username?: string;
}

/** How long a launch stays valid. Telegram signs `auth_date` at launch time. */
const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function buildCheckString(params: URLSearchParams, exclude: string[]): string {
  return [...params.entries()]
    .filter(([key]) => !exclude.includes(key))
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
}

function matches(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Verifies an `initData` string and returns the user it belongs to,
 * or `null` if the signature, the payload or the age does not check out.
 */
export function verifyInitData(
  initData: string,
  maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS,
  now: Date = new Date()
): WebAppUser | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === 'dummy_token_for_build' || !initData) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const providedHash = params.get('hash');
  if (!providedHash || !/^[0-9a-f]{64}$/i.test(providedHash)) return null;

  // secret_key = HMAC_SHA256(key="WebAppData", data=<bot token>)
  const secretKey = hmac('WebAppData', token);

  // Newer clients add a `signature` field used for third-party Ed25519
  // validation. Whether it belongs in the HMAC check string has varied, so
  // accept either reading rather than rejecting a legitimate launch.
  const candidates = [
    buildCheckString(params, ['hash']),
    buildCheckString(params, ['hash', 'signature']),
  ];

  const signatureOk = candidates.some((checkString) =>
    matches(hmac(secretKey, checkString).toString('hex'), providedHash)
  );
  if (!signatureOk) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return null;

  const ageSeconds = now.getTime() / 1000 - authDate;
  // A small negative age is just clock skew; a large one is a forged future date.
  if (ageSeconds > maxAgeSeconds || ageSeconds < -300) return null;

  const rawUser = params.get('user');
  if (!rawUser) return null;

  try {
    const user = JSON.parse(rawUser) as { id?: unknown; first_name?: unknown; username?: unknown };
    if (typeof user.id !== 'number' || !Number.isFinite(user.id)) return null;

    return {
      id: user.id,
      firstName: typeof user.first_name === 'string' ? user.first_name : undefined,
      username: typeof user.username === 'string' ? user.username : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Applies the same allow-list the bot uses, so the Mini App cannot become a
 * way around TELEGRAM_ALLOWED_USER_IDS.
 */
export function isUserAllowed(userId: number): boolean {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS;
  if (!raw) return true;

  const allowed = raw
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => Number.isFinite(id));

  return allowed.length === 0 || allowed.includes(userId);
}

/** Reads and verifies the launch data a Mini App request carries. */
export function authorizeWebAppRequest(request: Request): WebAppUser | null {
  const initData = request.headers.get('x-telegram-init-data');
  if (!initData) return null;

  const user = verifyInitData(initData);
  if (!user || !isUserAllowed(user.id)) return null;

  return user;
}

/**
 * Public URL the Mini App is served from. Telegram needs an absolute HTTPS
 * address to open it, and that address is not known from inside a chat update.
 */
export function getAppUrl(): string | null {
  const explicit = process.env.APP_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;

  return null;
}
