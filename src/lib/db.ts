import { Redis } from '@upstash/redis';
import { Reminder } from './types';
import { DEFAULT_TIMEZONE } from './timezones';
import { encryptForUser, decryptForUser, isEncryptionEnabled } from './crypto';

/** Shown instead of the reminder text when a record cannot be decrypted. */
export const UNDECRYPTABLE_TEXT = '🔒 не удалось расшифровать';

// In-memory fallback if Upstash environment variables are missing during local dev
const memoryStore = {
  timezones: new Map<number, string>(),
  pending: new Map<number, string>(),
  reminders: new Map<string, Reminder>(),
  active: new Set<string>(),
  locks: new Map<string, number>(), // key -> expiry timestamp
};

let cachedClient: Redis | null = null;

function getRedisClient(): Redis | null {
  if (cachedClient) return cachedClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token && url.startsWith('http')) {
    cachedClient = new Redis({ url, token, retry: { retries: 3, backoff: (n) => 2 ** n * 50 } });
    return cachedClient;
  }
  return null;
}

/** True when reminders are only kept in process memory (no Upstash configured). */
export function isUsingMemoryFallback(): boolean {
  return getRedisClient() === null;
}

// ---------------------------------------------------------------------------
// Encryption boundary
//
// Reminder text is encrypted on the way into storage and decrypted on the way
// out, keyed to the owning user. Scheduling metadata (due date, chat id,
// recurrence) stays in the clear because the cron worker needs it.
// ---------------------------------------------------------------------------

function toStorage(reminder: Reminder): Reminder {
  return { ...reminder, text: encryptForUser(reminder.userId, reminder.text, reminder.id) };
}

function fromStorage(reminder: Reminder): Reminder {
  const text = decryptForUser(reminder.userId, reminder.text, reminder.id);
  if (text === null) {
    console.error(
      `Failed to decrypt reminder ${reminder.id} for user ${reminder.userId} ` +
        '(wrong ENCRYPTION_KEY, tampered record, or a record written for another user)'
    );
    return { ...reminder, text: UNDECRYPTABLE_TEXT };
  }
  return { ...reminder, text };
}

// ---------------------------------------------------------------------------
// User timezone
// ---------------------------------------------------------------------------

export async function getUserTimezone(userId: number): Promise<string> {
  const redis = getRedisClient();
  if (redis) {
    const tz = await redis.get<string>(`user:${userId}:tz`);
    return tz || DEFAULT_TIMEZONE;
  }
  return memoryStore.timezones.get(userId) || DEFAULT_TIMEZONE;
}

export async function setUserTimezone(userId: number, timezone: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.set(`user:${userId}:tz`, timezone);
  } else {
    memoryStore.timezones.set(userId, timezone);
  }
}

// ---------------------------------------------------------------------------
// Locks / idempotency
//
// Both the cron worker and the webhook can be invoked concurrently by their
// callers. These helpers turn "set if absent" into a claim only one caller wins.
// ---------------------------------------------------------------------------

/** Atomically claims `key` for `ttlSeconds`. Returns true only for the winner. */
export async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const redis = getRedisClient();

  if (redis) {
    const result = await redis.set(key, '1', { nx: true, ex: ttlSeconds });
    return result === 'OK';
  }

  const now = Date.now();
  const expiry = memoryStore.locks.get(key);
  if (expiry && expiry > now) return false;
  memoryStore.locks.set(key, now + ttlSeconds * 1000);
  return true;
}

/** Releases a claim so the operation can be retried immediately. */
export async function releaseLock(key: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.del(key);
  } else {
    memoryStore.locks.delete(key);
  }
}

/**
 * Guards against Telegram redelivering the same update (which would otherwise
 * create a duplicate reminder). Returns false when the update is already being
 * processed or has been processed.
 */
export function claimUpdate(updateId: number): Promise<boolean> {
  return acquireLock(`update:${updateId}`, 3600);
}

export function releaseUpdate(updateId: number): Promise<void> {
  return releaseLock(`update:${updateId}`);
}

/**
 * Guards against two overlapping cron runs delivering the same reminder twice.
 * The claim is scoped to the exact due date, so a rescheduled or snoozed
 * reminder can be claimed again for its next occurrence.
 */
export function claimDelivery(reminderId: string, dueDate: string): Promise<boolean> {
  return acquireLock(`delivery:${reminderId}:${dueDate}`, 600);
}

export function releaseDelivery(reminderId: string, dueDate: string): Promise<void> {
  return releaseLock(`delivery:${reminderId}:${dueDate}`);
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/** Creates or updates a reminder and puts it back into the active queue. */
export async function saveReminder(reminder: Reminder): Promise<void> {
  const record = toStorage({ ...reminder, status: 'active', firedAt: undefined, pausedAt: undefined });
  const redis = getRedisClient();

  if (redis) {
    // The reminder object must exist before anything points at it, otherwise a
    // concurrent cron run could read a dangling index entry.
    await redis.set(`reminder:${record.id}`, JSON.stringify(record));
    await Promise.all([
      redis.sadd(`user_reminders:${record.userId}`, record.id),
      redis.sadd('active_reminders', record.id),
    ]);
  } else {
    memoryStore.reminders.set(record.id, record);
    memoryStore.active.add(record.id);
  }
}

/**
 * Marks a reminder as fired: it leaves the active queue so cron never
 * re-triggers it, but stays readable for 30 days so the snooze / reschedule
 * buttons on the delivered message keep working.
 */
export async function markReminderFired(reminderId: string): Promise<void> {
  const redis = getRedisClient();

  if (redis) {
    const stored = await readRaw(reminderId);
    await redis.srem('active_reminders', reminderId);
    if (stored) {
      const fired: Reminder = { ...stored, status: 'fired', firedAt: new Date().toISOString() };
      await redis.set(`reminder:${reminderId}`, JSON.stringify(fired), { ex: 60 * 60 * 24 * 30 });
    }
  } else {
    const stored = memoryStore.reminders.get(reminderId);
    if (stored) {
      memoryStore.reminders.set(reminderId, {
        ...stored,
        status: 'fired',
        firedAt: new Date().toISOString(),
      });
    }
    memoryStore.active.delete(reminderId);
  }
}

/**
 * Parks a reminder that could not be delivered (bot blocked, chat deleted).
 * Unlike a fired reminder it never expires and is restored on the next /start,
 * so nothing is lost when the user comes back.
 */
export async function pauseReminder(reminderId: string, reason: string): Promise<void> {
  const redis = getRedisClient();
  const stored = redis ? await readRaw(reminderId) : memoryStore.reminders.get(reminderId);
  if (!stored) return;

  const paused: Reminder = {
    ...stored,
    status: 'paused',
    pausedAt: new Date().toISOString(),
    pauseReason: reason,
  };

  if (redis) {
    await redis.set(`reminder:${reminderId}`, JSON.stringify(paused));
    await redis.srem('active_reminders', reminderId);
  } else {
    memoryStore.reminders.set(reminderId, paused);
    memoryStore.active.delete(reminderId);
  }
}

/**
 * Puts every paused reminder of a user back into the delivery queue.
 * Overdue ones keep their past due date, so the next cron run delivers them
 * immediately. Returns how many were restored and how many are already overdue.
 */
export async function resumeUserReminders(userId: number): Promise<{ restored: number; overdue: number }> {
  const redis = getRedisClient();
  const paused = (await getUserReminders(userId)).filter((r) => r.status === 'paused');
  const now = Date.now();

  let overdue = 0;
  for (const reminder of paused) {
    if (new Date(reminder.dueDate).getTime() <= now) overdue++;

    const restored: Reminder = {
      ...reminder,
      status: 'active',
      pausedAt: undefined,
      pauseReason: undefined,
    };

    if (redis) {
      await redis.set(`reminder:${reminder.id}`, JSON.stringify(toStorage(restored)));
      await redis.sadd('active_reminders', reminder.id);
    } else {
      memoryStore.reminders.set(reminder.id, toStorage(restored));
      memoryStore.active.add(reminder.id);
    }
  }

  return { restored: paused.length, overdue };
}

function deserialize(data: Reminder | string | null): Reminder | null {
  if (!data) return null;
  if (typeof data === 'string') {
    try {
      return JSON.parse(data) as Reminder;
    } catch {
      return null;
    }
  }
  return data;
}

/** Reads the stored record without decrypting it (for status-only rewrites). */
async function readRaw(reminderId: string): Promise<Reminder | null> {
  const redis = getRedisClient();
  if (!redis) return memoryStore.reminders.get(reminderId) || null;
  return deserialize(await redis.get<Reminder | string>(`reminder:${reminderId}`));
}

export async function getReminder(reminderId: string): Promise<Reminder | null> {
  const stored = await readRaw(reminderId);
  return stored ? fromStorage(stored) : null;
}

/**
 * Reads a reminder only if it belongs to `userId`.
 *
 * Callback data travels through the client, so a reminder id can be replayed by
 * anyone. Every button handler must go through this, otherwise one user could
 * read, snooze or delete another user's reminders.
 */
export async function getOwnedReminder(reminderId: string, userId: number): Promise<Reminder | null> {
  const stored = await readRaw(reminderId);
  if (!stored || stored.userId !== userId) return null;
  return fromStorage(stored);
}

/** Fetches many reminders in batched MGET calls instead of one request each. */
async function getRemindersByIds(ids: string[]): Promise<Reminder[]> {
  const redis = getRedisClient();
  if (!redis) {
    return ids
      .map((id) => memoryStore.reminders.get(id))
      .filter((r): r is Reminder => !!r)
      .map(fromStorage);
  }

  const result: Reminder[] = [];
  const CHUNK = 100;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const values = await redis.mget<(Reminder | string | null)[]>(...chunk.map((id) => `reminder:${id}`));

    values.forEach((value, idx) => {
      const stored = deserialize(value);
      if (stored) {
        result.push(fromStorage(stored));
      } else {
        // The reminder key expired or was removed — drop the dangling index entry.
        void redis.srem('active_reminders', chunk[idx]);
      }
    });
  }

  return result;
}

export async function deleteReminder(reminderId: string, userId: number): Promise<boolean> {
  const stored = await readRaw(reminderId);
  if (!stored || stored.userId !== userId) return false;

  const redis = getRedisClient();
  if (redis) {
    await Promise.all([
      redis.del(`reminder:${reminderId}`),
      redis.srem('active_reminders', reminderId),
      redis.srem(`user_reminders:${userId}`, reminderId),
    ]);
  } else {
    memoryStore.reminders.delete(reminderId);
    memoryStore.active.delete(reminderId);
  }
  return true;
}

/**
 * Every reminder of one user that has not been delivered yet, earliest first.
 * Includes paused ones so they stay visible in /list rather than disappearing.
 */
export async function getUserReminders(userId: number): Promise<Reminder[]> {
  const redis = getRedisClient();
  let reminders: Reminder[];

  if (redis) {
    const ids = await redis.smembers<string[]>(`user_reminders:${userId}`);
    if (!ids || ids.length === 0) return [];

    reminders = await getRemindersByIds(ids);

    // Drop index entries whose reminder object is gone (expired fired records).
    const alive = new Set(reminders.map((r) => r.id));
    const stale = ids.filter((id) => !alive.has(id));
    if (stale.length > 0) {
      void redis.srem(`user_reminders:${userId}`, ...stale);
    }
  } else {
    reminders = Array.from(memoryStore.reminders.values())
      .filter((r) => r.userId === userId)
      .map(fromStorage);
  }

  return reminders
    .filter((r) => r.userId === userId) // defence in depth against index corruption
    .filter((r) => r.status !== 'fired')
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
}

/** Every reminder waiting to fire, across all users — used by the cron worker. */
export async function getAllActiveReminders(): Promise<Reminder[]> {
  const redis = getRedisClient();

  if (redis) {
    const ids = await redis.smembers<string[]>('active_reminders');
    if (!ids || ids.length === 0) return [];
    return getRemindersByIds(ids);
  }

  return Array.from(memoryStore.active)
    .map((id) => memoryStore.reminders.get(id))
    .filter((r): r is Reminder => !!r)
    .map(fromStorage);
}

/** Removes every reminder belonging to a user. Returns how many were deleted. */
export async function deleteAllUserReminders(userId: number): Promise<number> {
  const reminders = await getUserReminders(userId);
  let deleted = 0;
  for (const reminder of reminders) {
    if (await deleteReminder(reminder.id, userId)) deleted++;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Pending reschedule state ("✍️ Другое время")
// ---------------------------------------------------------------------------

export async function setPendingReschedule(userId: number, reminderId: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.set(`user:${userId}:pending_reschedule`, reminderId, { ex: 900 });
  } else {
    memoryStore.pending.set(userId, reminderId);
  }
}

export async function getPendingReschedule(userId: number): Promise<string | null> {
  const redis = getRedisClient();
  if (redis) {
    return await redis.get<string>(`user:${userId}:pending_reschedule`);
  }
  return memoryStore.pending.get(userId) || null;
}

export async function clearPendingReschedule(userId: number): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.del(`user:${userId}:pending_reschedule`);
  } else {
    memoryStore.pending.delete(userId);
  }
}

export { isEncryptionEnabled };
