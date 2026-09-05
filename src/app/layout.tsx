import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Telegram Reminder Bot | Vercel Self-Hosted',
  description: 'Private, deterministic Telegram Reminder Bot running on Vercel without AI.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className="antialiased bg-slate-950 text-slate-100">{children}</body>
    </html>
  );
}
