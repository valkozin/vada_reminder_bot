import { NextRequest, NextResponse } from 'next/server';
import { bot, ensureBotCommands, BOT_COMMANDS } from '@/lib/bot';
import { isUsingMemoryFallback } from '@/lib/db';
import { getEncryptionStatus, exportMasterKey } from '@/lib/crypto';
import { getAppUrl } from '@/lib/webapp-auth';

export const dynamic = 'force-dynamic';

/**
 * Diagnostics + one-click setup.
 *
 *   GET /api/setup?secret=<CRON_SECRET>              — report current state
 *   GET /api/setup?secret=<CRON_SECRET>&setWebhook=1 — also (re)bind the webhook
 *
 * Reports which environment variables are missing and what Telegram currently
 * thinks the webhook is — the two things that account for almost every
 * "the bot does not answer" situation.
 */
export async function GET(req: NextRequest) {
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers.get('authorization');
    const querySecret = req.nextUrl.searchParams.get('secret');
    const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : querySecret;
    if (token !== expectedSecret) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
  }

  const env = {
    TELEGRAM_BOT_TOKEN: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    UPSTASH_REDIS_REST_URL: Boolean(process.env.UPSTASH_REDIS_REST_URL),
    UPSTASH_REDIS_REST_TOKEN: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    TELEGRAM_WEBHOOK_SECRET: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
    ENCRYPTION_KEY: Boolean(process.env.ENCRYPTION_KEY),
    TELEGRAM_ALLOWED_USER_IDS: process.env.TELEGRAM_ALLOWED_USER_IDS || '(не задано — доступ всем)',
  };

  const warnings: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN) warnings.push('TELEGRAM_BOT_TOKEN не задан — бот не сможет отвечать.');
  if (isUsingMemoryFallback()) {
    warnings.push(
      'Upstash Redis не настроен: напоминания хранятся в памяти процесса и пропадут при следующем запросе.'
    );
  }

  let storage: Record<string, unknown> = { encryptionAtRest: false };
  try {
    const encryption = getEncryptionStatus();
    storage = {
      encryptionAtRest: encryption.enabled,
      keySource: encryption.source,
      keyId: encryption.keyId,
      fallbackKeys: encryption.fallbackKeys,
    };

    if (!encryption.enabled) {
      warnings.push('Ключ шифрования недоступен — тексты напоминаний хранятся в базе открытым текстом.');
    } else if (encryption.source === 'TELEGRAM_BOT_TOKEN') {
      warnings.push(
        'Ключ шифрования выведен из TELEGRAM_BOT_TOKEN. Если сменить или отозвать токен бота в ' +
          'BotFather, тексты существующих напоминаний станут нечитаемыми. Перед сменой токена ' +
          'зафиксируйте текущий ключ: добавьте &exportKey=1 к этому адресу и положите значение в ENCRYPTION_KEY.'
      );
    }

    if (req.nextUrl.searchParams.get('exportKey') === '1') {
      storage.masterKeyBase64 = exportMasterKey();
      storage.masterKeyNote =
        'Положите это значение в переменную ENCRYPTION_KEY на Vercel и сделайте Redeploy. ' +
        'После этого токен бота можно менять свободно. Больше этот адрес с exportKey не открывайте.';
    }
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }

  const expectedWebhookUrl = `${req.nextUrl.origin}/api/telegram-webhook`;
  const result: Record<string, unknown> = { ok: true, env, storage, expectedWebhookUrl };

  if (!env.TELEGRAM_BOT_TOKEN) {
    return NextResponse.json({ ...result, warnings });
  }

  try {
    await ensureBotCommands(true);
    result.commands = BOT_COMMANDS.map((c) => `/${c.command}`);

    // When the public address is known, the ☰ button next to the input opens
    // the Mini App. Commands stay reachable by typing "/".
    const appUrl = getAppUrl() ?? req.nextUrl.origin;
    const miniAppUrl = `${appUrl}/app`;

    if (miniAppUrl.startsWith('https://')) {
      await bot.api.setChatMenuButton({
        menu_button: { type: 'web_app', text: '🗂 Задачи', web_app: { url: miniAppUrl } },
      });
      result.menuButton = miniAppUrl;
    } else {
      // Telegram only accepts HTTPS for Mini Apps, so local dev keeps commands.
      await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
      result.menuButton = 'commands';
    }

    if (!process.env.APP_PUBLIC_URL) {
      warnings.push(
        'APP_PUBLIC_URL не задан — адрес мини-приложения выведен автоматически ' +
          `("${miniAppUrl}"). Если у проекта свой домен, задайте переменную явно.`
      );
    }

    if (req.nextUrl.searchParams.get('setWebhook') === '1') {
      const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET;
      await bot.api.setWebhook(expectedWebhookUrl, {
        drop_pending_updates: true,
        ...(secretToken ? { secret_token: secretToken } : {}),
      });
      result.webhookSet = expectedWebhookUrl;
    }

    const info = await bot.api.getWebhookInfo();
    result.webhookInfo = info;

    if (info.url !== expectedWebhookUrl) {
      warnings.push(
        `Webhook указывает на "${info.url || '(не задан)'}", а должен на "${expectedWebhookUrl}". ` +
          'Добавьте &setWebhook=1 к этому адресу, чтобы исправить.'
      );
    }
    if (info.last_error_message) {
      warnings.push(`Последняя ошибка доставки от Telegram: ${info.last_error_message}`);
    }
  } catch (err) {
    return NextResponse.json(
      { ...result, ok: false, error: err instanceof Error ? err.message : String(err), warnings },
      { status: 500 }
    );
  }

  return NextResponse.json({ ...result, warnings: warnings.length ? warnings : undefined });
}
