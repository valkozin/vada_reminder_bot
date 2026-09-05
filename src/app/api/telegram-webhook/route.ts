import { NextRequest, NextResponse } from 'next/server';
import { webhookCallback } from 'grammy';
import { bot } from '@/lib/bot';

export const dynamic = 'force-dynamic';

const handleWebhook = webhookCallback(bot, 'std/http');

export async function POST(req: NextRequest) {
  try {
    return await handleWebhook(req);
  } catch (error) {
    console.error('Error handling Telegram webhook:', error);
    return NextResponse.json({ ok: false, error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: 'Telegram Webhook Endpoint is active.' });
}
