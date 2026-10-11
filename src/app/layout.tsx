import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getPageUser } from "@/server/auth/page-auth";
import { LogoutButton } from "@/components/LogoutButton";

export const metadata: Metadata = {
  title: "AI Fantasy Studio",
  description: "Turn one story into a cinematic fantasy film with professional Pakistani Urdu voice.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getPageUser();
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Inter:wght@400;500;600;700&family=Noto+Nastaliq+Urdu:wght@400;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <header className="sticky top-0 z-30 border-b border-white/5 bg-ink-950/70 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
            <Link href="/" className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-gold-400 to-arcane-500 text-lg text-ink-950 shadow-lg shadow-arcane-500/30">
                ✦
              </span>
              <span className="font-[family-name:var(--font-display)] text-lg tracking-wide text-gold-300">AI Fantasy Studio</span>
            </Link>
            {user ? (
              <nav className="flex items-center gap-2 text-sm">
                <Link href="/" className="rounded-lg px-3 py-2 text-white/70 hover:bg-white/5 hover:text-white">Projects</Link>
                <Link href="/settings/providers" className="rounded-lg px-3 py-2 text-white/70 hover:bg-white/5 hover:text-white">Providers</Link>
                <Link href="/projects/new" className="btn-primary ml-2">Create New Video</Link>
                <LogoutButton />
              </nav>
            ) : (
              <nav className="flex gap-2 text-sm">
                <Link href="/login" className="btn-ghost">Sign in</Link>
                <Link href="/signup" className="btn-primary">Create account</Link>
              </nav>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
