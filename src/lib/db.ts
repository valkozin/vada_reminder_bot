import { Redis } from '@upstash/redis';
import { Reminder, UserSettings } from './types';

// In-memory fallback if Upstash environment variables are missing during local dev
const memoryStore = {
  users: new Map<number, string>(),
  reminders: new Map<string, Reminder>(),
};

function getRedisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token && url.startsWith('http')) {
    return new Redis({ url, token });
  }
  return null;
}

// User Timezone Settings
export async function getUserTimezone(userId: number): Promise<string> {
  const redis = getRedisClient();
  if (redis) {
    const tz = await redis.get<string>(`user:${userId}:tz`);
    return tz || 'Europe/Moscow';
  }
  return memoryStore.users.get(userId) || 'Europe/Moscow';
}

export async function setUserTimezone(userId: number, timezone: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.set(`user:${userId}:tz`, timezone);
  } else {
    memoryStore.users.set(userId, timezone);
  }
}

// Create Reminder
export async function saveReminder(reminder: Reminder): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.set(`reminder:${reminder.id}`, JSON.stringify(reminder));
    await redis.sadd(`user_reminders:${reminder.userId}`, reminder.id);
    await redis.sadd(`active_reminders`, reminder.id);
  } else {
    memoryStore.reminders.set(reminder.id, reminder);
  }
}

// Get Single Reminder
export async function getReminder(reminderId: string): Promise<Reminder | null> {
  const redis = getRedisClient();
  if (redis) {
    const data = await redis.get<Reminder | string>(`reminder:${reminderId}`);
    if (!data) return null;
    return typeof data === 'string' ? JSON.parse(data) : data;
  }
  return memoryStore.reminders.get(reminderId) || null;
}

// Delete Reminder
export async function deleteReminder(reminderId: string, userId?: number): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    const reminder = await getReminder(reminderId);
    if (reminder) {
      await redis.del(`reminder:${reminderId}`);
      await redis.srem(`active_reminders`, reminderId);
      if (userId || reminder.userId) {
        await redis.srem(`user_reminders:${userId || reminder.userId}`, reminderId);
      }
    }
  } else {
    memoryStore.reminders.delete(reminderId);
  }
}

// Get User's Active Reminders
export async function getUserReminders(userId: number): Promise<Reminder[]> {
  const redis = getRedisClient();
  if (redis) {
    const reminderIds = await redis.smembers<string[]>(`user_reminders:${userId}`);
    if (!reminderIds || reminderIds.length === 0) return [];

    const reminders: Reminder[] = [];
    for (const id of reminderIds) {
      const rem = await getReminder(id);
      if (rem) reminders.push(rem);
    }
    return reminders.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  }

  return Array.from(memoryStore.reminders.values())
    .filter((r) => r.userId === userId)
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
}

// Get All Active Reminders for Cron Worker
export async function getAllActiveReminders(): Promise<Reminder[]> {
  const redis = getRedisClient();
  if (redis) {
    const ids = await redis.smembers<string[]>(`active_reminders`);
    if (!ids || ids.length === 0) return [];

    const reminders: Reminder[] = [];
    for (const id of ids) {
      const rem = await getReminder(id);
      if (rem) reminders.push(rem);
    }
    return reminders;
  }

  return Array.from(memoryStore.reminders.values());
}
