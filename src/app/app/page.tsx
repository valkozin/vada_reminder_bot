'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bell, Check, Pencil, RefreshCw, Trash2, X } from 'lucide-react';

interface ReminderView {
  id: string;
  text: string;
  dueDate: string;
  dueLabel: string;
  timeUntil: string;
  recurrence: string;
  status: string;
  overdue: boolean;
}

const RECURRENCE_LABELS: Record<string, string> = {
  none: '',
  daily: 'каждый день',
  weekdays: 'по будням',
  weekly: 'каждую неделю',
  monthly: 'каждый месяц',
};

/** Minimal shape of the bits of the Telegram Mini App API this page uses. */
interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  colorScheme?: string;
  platform?: string;
  HapticFeedback?: { notificationOccurred: (t: 'error' | 'success' | 'warning') => void };
  showConfirm?: (message: string, callback: (confirmed: boolean) => void) => void;
}

function getWebApp(): TelegramWebApp | null {
  return (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp ?? null;
}

/** ISO instant -> "YYYY-MM-DDTHH:mm" in the given IANA zone, for datetime-local. */
function toLocalInputValue(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  // Intl renders midnight as "24" in some engines; datetime-local needs "00".
  const hour = get('hour') === '24' ? '00' : get('hour');

  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

export default function MiniApp() {
  const [initData, setInitData] = useState<string | null>(null);
  const [outsideTelegram, setOutsideTelegram] = useState(false);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [reminders, setReminders] = useState<ReminderView[]>([]);
  const [timezone, setTimezone] = useState('UTC');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftWhen, setDraftWhen] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // Load the Telegram script at runtime: it must not be bundled, and the page
  // has nothing to show until it provides the signed launch data.
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.async = true;

    script.onload = () => {
      const webApp = getWebApp();
      if (!webApp || !webApp.initData) {
        // Distinguish "not in Telegram at all" from "in Telegram, but launched
        // in a way that carries no signature" — the two need different advice.
        setDiagnosis(
          webApp
            ? `Telegram есть (${webApp.platform ?? 'платформа неизвестна'}), но подпись не передана.`
            : 'Похоже, это обычный браузер.'
        );
        setOutsideTelegram(true);
        setLoading(false);
        return;
      }
      webApp.ready();
      webApp.expand();
      setInitData(webApp.initData);
    };
    script.onerror = () => {
      setDiagnosis('Не удалось загрузить скрипт Telegram.');
      setOutsideTelegram(true);
      setLoading(false);
    };

    document.head.appendChild(script);
    return () => script.remove();
  }, []);

  const request = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const response = await fetch(path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': initData ?? '',
          ...(options.headers ?? {}),
        },
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(
          data.error === 'Unauthorized'
            ? 'Сессия устарела. Закройте и откройте приложение заново.'
            : data.error || 'Что-то пошло не так'
        );
      }
      return data;
    },
    [initData]
  );

  const refresh = useCallback(async () => {
    if (!initData) return;
    setLoading(true);
    setError(null);
    try {
      const data = await request('/api/reminders');
      setReminders(data.reminders);
      setTimezone(data.timezone);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [initData, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function startEditing(reminder: ReminderView) {
    setEditingId(reminder.id);
    setDraftText(reminder.text);
    setDraftWhen(toLocalInputValue(reminder.dueDate, timezone));
    setError(null);
  }

  async function saveEdit(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await request('/api/reminders', {
        method: 'PATCH',
        body: JSON.stringify({ id, text: draftText, dueLocal: draftWhen }),
      });
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      getWebApp()?.HapticFeedback?.notificationOccurred('error');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(reminder: ReminderView) {
    const confirmDelete = (proceed: boolean) => {
      if (!proceed) return;
      setBusyId(reminder.id);
      setError(null);
      request(`/api/reminders?id=${encodeURIComponent(reminder.id)}`, { method: 'DELETE' })
        .then(() => refresh())
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusyId(null));
    };

    const webApp = getWebApp();
    const question = `Удалить «${reminder.text}»?`;
    if (webApp?.showConfirm) {
      webApp.showConfirm(question, confirmDelete);
    } else {
      confirmDelete(window.confirm(question));
    }
  }

  if (outsideTelegram) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 text-center">
        <div className="max-w-xs">
          <Bell className="mx-auto mb-4 text-indigo-400" size={40} />
          <h1 className="text-lg font-bold mb-2">Откройте из бота</h1>
          <p className="text-sm text-slate-400 mb-4">
            Страница узнаёт вас по подписи Telegram, а её передают не все способы запуска.
          </p>
          <p className="text-sm text-slate-300 mb-1">Откройте одним из двух способов:</p>
          <ul className="text-sm text-slate-400 text-left inline-block mb-4">
            <li>☰ кнопка рядом с полем ввода</li>
            <li>команда <code className="text-indigo-300">/app</code> → кнопка под сообщением</li>
          </ul>
          {diagnosis && <p className="text-xs text-slate-600">{diagnosis}</p>}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-4 py-5 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold">Мои напоминания</h1>
          <p className="text-xs text-slate-400">
            {timezone} · {reminders.length}
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Обновить"
          className="p-2 rounded-lg bg-slate-800 text-slate-300 disabled:opacity-40"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-rose-950/50 border border-rose-900 text-sm text-rose-200">
          {error}
        </div>
      )}

      {loading && reminders.length === 0 && <p className="text-sm text-slate-400">Загружаю…</p>}

      {!loading && reminders.length === 0 && !error && (
        <div className="text-center py-16">
          <Bell className="mx-auto mb-3 text-slate-600" size={36} />
          <p className="text-slate-400 text-sm">
            Пока пусто. Напишите боту, например
            <br />
            <code className="text-indigo-300">завтра в 10 позвонить врачу</code>
          </p>
        </div>
      )}

      <ul className="space-y-3">
        {reminders.map((reminder) => {
          const isEditing = editingId === reminder.id;
          const isBusy = busyId === reminder.id;
          const recurrence = RECURRENCE_LABELS[reminder.recurrence];

          return (
            <li
              key={reminder.id}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
            >
              {isEditing ? (
                <div className="space-y-3">
                  <input
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm"
                    placeholder="Текст напоминания"
                  />
                  <input
                    type="datetime-local"
                    value={draftWhen}
                    onChange={(e) => setDraftWhen(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => void saveEdit(reminder.id)}
                      disabled={isBusy}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50"
                    >
                      <Check size={16} /> Сохранить
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      disabled={isBusy}
                      className="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm disabled:opacity-50"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="font-medium text-slate-100 mb-1.5 break-words">{reminder.text}</p>
                  <p className="text-xs text-slate-400">⏰ {reminder.dueLabel}</p>
                  <p className={`text-xs ${reminder.overdue ? 'text-amber-400' : 'text-slate-500'}`}>
                    ⏳ {reminder.timeUntil}
                    {recurrence && <span className="text-purple-400"> · 🔄 {recurrence}</span>}
                    {reminder.status === 'paused' && (
                      <span className="text-rose-400"> · ⏸ приостановлено</span>
                    )}
                  </p>

                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => startEditing(reminder)}
                      disabled={isBusy}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs disabled:opacity-50"
                    >
                      <Pencil size={14} /> Изменить
                    </button>
                    <button
                      onClick={() => void remove(reminder)}
                      disabled={isBusy}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-950 text-rose-300 text-xs disabled:opacity-50"
                    >
                      <Trash2 size={14} /> Удалить
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
