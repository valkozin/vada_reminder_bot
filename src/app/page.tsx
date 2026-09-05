'use client';

import { useState } from 'react';
import { Bell, CheckCircle2, Clock, Cpu, Database, Key, Server, Terminal, Zap } from 'lucide-react';
import { parseReminderInput } from '@/lib/parser';

export default function Dashboard() {
  const [testInput, setTestInput] = useState('завтра в 15:30 полить цветы');
  const [testTz, setTestTz] = useState('Europe/Moscow');
  const [parseResult, setParseResult] = useState<any>(null);

  const handleTestParse = () => {
    const res = parseReminderInput(testInput, testTz);
    setParseResult(res);
  };

  return (
    <main className="max-w-6xl mx-auto px-4 py-12">
      {/* Header */}
      <header className="text-center mb-12">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-4">
          <Zap size={14} /> 100% Free & Private • No AI Required
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4 gradient-text">
          Telegram Reminder Bot Dashboard
        </h1>
        <p className="text-slate-400 text-lg max-w-2xl mx-auto">
          Персональный бот-напоминатель (аналог Skeddy). Работает 24/7 на Vercel Serverless без серверов и сторонних ИИ.
        </p>
      </header>

      {/* Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-12">
        {/* Interactive Parser Sandbox */}
        <div className="lg:col-span-2 glass-card p-6 border border-slate-800">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
              <Cpu size={22} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-100">Тестирование парсера дат (без ИИ)</h2>
              <p className="text-sm text-slate-400">Проверьте распознавание фраз на русском языке в реальном времени</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs text-slate-400 uppercase font-semibold mb-1">Текст сообщения</label>
              <input
                type="text"
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder="Например: через 20 минут проверить духовку"
                className="w-full px-4 py-2.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-100 focus:outline-none focus:border-indigo-500 transition"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-400 uppercase font-semibold mb-1">Часовой пояс</label>
                <select
                  value={testTz}
                  onChange={(e) => setTestTz(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-100 focus:outline-none focus:border-indigo-500 transition"
                >
                  <option value="Europe/Moscow">Europe/Moscow (UTC+3)</option>
                  <option value="Europe/Kyiv">Europe/Kyiv (UTC+2/3)</option>
                  <option value="Asia/Tashkent">Asia/Tashkent (UTC+5)</option>
                  <option value="Asia/Almaty">Asia/Almaty (UTC+5)</option>
                  <option value="UTC">UTC</option>
                </select>
              </div>

              <div className="flex items-end">
                <button
                  onClick={handleTestParse}
                  className="w-full px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 font-semibold text-white transition flex items-center justify-center gap-2"
                >
                  <Terminal size={18} /> Проверить парсер
                </button>
              </div>
            </div>

            {/* Parse Output */}
            {parseResult !== null && (
              <div className="mt-4 p-4 rounded-lg bg-slate-900/90 border border-slate-800 font-mono text-sm space-y-2">
                <div className="flex justify-between items-center text-xs text-indigo-400 font-bold border-b border-slate-800 pb-1 mb-2">
                  <span>РЕЗУЛЬТАТ РАСПОЗНАВАНИЯ</span>
                  <span className="uppercase">{parseResult?.matchedPattern || 'Matched'}</span>
                </div>
                <div><span className="text-slate-500">Текст задачи:</span> <span className="text-emerald-400 font-semibold">{parseResult?.text}</span></div>
                <div><span className="text-slate-500">Дата отправки (UTC):</span> <span className="text-sky-300">{parseResult?.dueDate?.toISOString()}</span></div>
                <div><span className="text-slate-500">Повторение:</span> <span className="text-purple-300 font-bold">{parseResult?.recurrence}</span></div>
              </div>
            )}
          </div>
        </div>

        {/* System Overview Card */}
        <div className="glass-card p-6 border border-slate-800 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
                <Server size={22} />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-100">Статус системы</h2>
                <p className="text-sm text-slate-400">Vercel Serverless Architecture</p>
              </div>
            </div>

            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between p-3 rounded-lg bg-slate-900/60 border border-slate-800">
                <span className="flex items-center gap-2 text-slate-300"><Zap size={16} className="text-amber-400"/> Webhook Engine</span>
                <span className="text-xs font-semibold text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded">Active</span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-slate-900/60 border border-slate-800">
                <span className="flex items-center gap-2 text-slate-300"><Database size={16} className="text-sky-400"/> Storage</span>
                <span className="text-xs font-semibold text-sky-400 bg-sky-400/10 px-2 py-0.5 rounded">Upstash Redis</span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-slate-900/60 border border-slate-800">
                <span className="flex items-center gap-2 text-slate-300"><Clock size={16} className="text-indigo-400"/> Scheduler</span>
                <span className="text-xs font-semibold text-indigo-400 bg-indigo-400/10 px-2 py-0.5 rounded">1-Min Cron</span>
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-800 text-xs text-slate-500 text-center">
            Zero Running Server Costs • 100% Free Tier
          </div>
        </div>
      </div>

      {/* Complete Vercel Setup Instructions */}
      <section className="glass-card p-8 border border-slate-800 mb-12">
        <h2 className="text-2xl font-extrabold text-slate-100 mb-6 flex items-center gap-3">
          <Key className="text-indigo-400" /> Подробная инструкция: Как развернуть проект в Vercel
        </h2>

        <div className="space-y-6 text-sm text-slate-300">
          <div className="p-4 rounded-lg bg-slate-900/80 border border-slate-800">
            <h3 className="font-bold text-slate-100 mb-2 flex items-center gap-2 text-base">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-extrabold">1</span>
              Создание Telegram Бота
            </h3>
            <p className="mb-2">1. Откройте Telegram и найдите бота <code className="text-indigo-300 bg-slate-800 px-1.5 py-0.5 rounded">@BotFather</code>.</p>
            <p className="mb-2">2. Отправьте команду <code className="text-indigo-300 bg-slate-800 px-1.5 py-0.5 rounded">/newbot</code> и укажите название и username (например: <code className="text-slate-400">MyReminder_bot</code>).</p>
            <p>3. Скопируйте полученный **API Token** (вида <code className="text-emerald-400">7123456789:AAFg...</code>).</p>
          </div>

          <div className="p-4 rounded-lg bg-slate-900/80 border border-slate-800">
            <h3 className="font-bold text-slate-100 mb-2 flex items-center gap-2 text-base">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-extrabold">2</span>
              Создание бесплатной базы данных Upstash Redis
            </h3>
            <p className="mb-2">1. Зарегистрируйтесь на сайте <a href="https://upstash.com" target="_blank" rel="noreferrer" className="text-indigo-400 underline">upstash.com</a> (можно через GitHub).</p>
            <p className="mb-2">2. Нажмите **Create Database** → Название: <code className="text-slate-300">reminder-db</code>, тип **Redis**, регион **eu-west-1**.</p>
            <p>3. В разделе **REST API** скопируйте значения двух переменных: <code className="text-sky-300">UPSTASH_REDIS_REST_URL</code> и <code className="text-sky-300">UPSTASH_REDIS_REST_TOKEN</code>.</p>
          </div>

          <div className="p-4 rounded-lg bg-slate-900/80 border border-slate-800">
            <h3 className="font-bold text-slate-100 mb-2 flex items-center gap-2 text-base">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-extrabold">3</span>
              Деплой репозитория на Vercel
            </h3>
            <p className="mb-2">1. Опубликуйте этот проект на ваш **GitHub**.</p>
            <p className="mb-2">2. Зайдите на <a href="https://vercel.com" target="_blank" rel="noreferrer" className="text-indigo-400 underline">vercel.com</a> &rarr; Нажмите **Add New &rarr; Project** &rarr; Импортируйте ваш репозиторий.</p>
            <p className="mb-2">3. В разделе **Environment Variables** (Переменные окружения) добавьте:</p>
            <ul className="list-disc list-inside space-y-1 font-mono text-xs text-slate-400 ml-4 mb-3">
              <li><b className="text-slate-200">TELEGRAM_BOT_TOKEN</b> = ваш токен от BotFather</li>
              <li><b className="text-slate-200">UPSTASH_REDIS_REST_URL</b> = URL из Upstash</li>
              <li><b className="text-slate-200">UPSTASH_REDIS_REST_TOKEN</b> = Token из Upstash</li>
              <li><b className="text-slate-200">CRON_SECRET</b> = произвольный пароль для защиты крон-запросов (например: <code className="text-amber-300">my_secret_cron_123</code>)</li>
              <li><b className="text-slate-200">TELEGRAM_ALLOWED_USER_IDS</b> = ваш Telegram ID (необязательно, для защиты от сторонних юзеров)</li>
            </ul>
            <p>4. Нажмите **Deploy**. Через 1 минуту Vercel выдаст ссылку вида: <code className="text-emerald-400 font-mono">https://reminder-bot-xyz.vercel.app</code>.</p>
          </div>

          <div className="p-4 rounded-lg bg-slate-900/80 border border-slate-800">
            <h3 className="font-bold text-slate-100 mb-2 flex items-center gap-2 text-base">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-extrabold">4</span>
              Регистрация Webhook в Telegram
            </h3>
            <p className="mb-2">Откройте ваш браузер и выполните следующую ссылку (подставив ваши значения):</p>
            <div className="p-3 bg-slate-950 rounded border border-slate-800 font-mono text-xs text-emerald-400 overflow-x-auto">
              https://api.telegram.org/bot<span className="text-amber-300">&lt;ВАШ_TELEGRAM_BOT_TOKEN&gt;</span>/setWebhook?url=https://<span className="text-amber-300">&lt;ВАШ_САЙТ_НА_VERCEL&gt;</span>.vercel.app/api/telegram-webhook
            </div>
            <p className="mt-2 text-xs text-slate-400">В ответе браузера должно быть: <code className="text-emerald-400 font-mono">&#123;"ok":true,"result":true,"description":"Webhook was set"&#125;</code></p>
          </div>

          <div className="p-4 rounded-lg bg-slate-900/80 border border-slate-800">
            <h3 className="font-bold text-slate-100 mb-2 flex items-center gap-2 text-base">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-extrabold">5</span>
              Настройка Cron (Отправка каждые 60 секунд)
            </h3>
            <p className="mb-2">Для вызова отправки напоминаний раз в минуту используйте бесплатный сервис <a href="https://cron-job.org" target="_blank" rel="noreferrer" className="text-indigo-400 underline">cron-job.org</a>:</p>
            <ul className="list-disc list-inside space-y-1 text-xs text-slate-300 ml-4">
              <li>Создайте новый Cron Job с адресом: <code className="text-indigo-300 font-mono">https://ВАШ_САЙТ.vercel.app/api/cron</code></li>
              <li>Интервал: **Every 1 minute** (Каждую минуту).</li>
              <li>В разделе **Headers** укажите заголовок: <code className="text-indigo-300 font-mono">Authorization: Bearer ВАШ_CRON_SECRET</code>.</li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}
