import { NextRequest, NextResponse } from 'next/server';
import { webhookCallback } from 'grammy';
import { bot, failedUpdates } from '@/lib/bot';
import { claimUpdate, releaseUpdate } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const handleWebhook = webhookCallback(bot, 'std/http');

export async function POST(req: NextRequest) {
  // Optional hardening: when TELEGRAM_WEBHOOK_SECRET is set (and passed to
  // setWebhook as secret_token), reject anything that is not really Telegram.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret && req.headers.get('x-telegram-bot-api-secret-token') !== expectedSecret) {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  // The body is read once and replayed, because we need update_id before
  // handing the request to grammy.
  const rawBody = await req.text();

  let updateId: number | undefined;
  try {
    updateId = JSON.parse(rawBody)?.update_id;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed update' }, { status: 400 });
  }

  // Telegram redelivers an update whenever it is unsure we received it (our
  // function timed out, Vercel was down, the network dropped). Without this
  // guard a single "через час позвонить" could become three reminders.
  if (typeof updateId === 'number' && !(await claimUpdate(updateId))) {
    console.warn(`Duplicate delivery of update ${updateId} ignored`);
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    const response = await handleWebhook(
      new Request(req.url, { method: 'POST', headers: req.headers, body: rawBody })
    );

    // bot.catch swallows handler errors so Telegram is not sent a 5xx, but it
    // records the update id. Releasing the claim means that if Telegram does
    // redeliver, we will genuinely retry instead of discarding it as a dupe.
    if (typeof updateId === 'number' && failedUpdates.has(updateId)) {
      failedUpdates.delete(updateId);
      await releaseUpdate(updateId);
    }

    return response;
  } catch (error) {
    console.error('Error handling Telegram webhook:', error);
    if (typeof updateId === 'number') {
      failedUpdates.delete(updateId);
      await releaseUpdate(updateId);
    }

    // Always answer 2xx: a non-2xx makes Telegram redeliver the same update in
    // a tight loop, which is a worse failure mode than one lost message the
    // user was already told about.
    return NextResponse.json({ ok: true, handled: false });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: 'Telegram Webhook Endpoint is active.',
    hint: 'Point setWebhook at this exact URL (including /api/telegram-webhook).',
  });
}
