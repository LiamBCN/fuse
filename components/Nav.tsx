"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clearActiveId } from "@/lib/conversations";
import ThemeToggle from "./ThemeToggle";
import Logo from "./Logo";
import { NavLimitMeter } from "./LimitMeter";

const LINKS = [
  { href: "/", label: "Chat" },
  { href: "/history", label: "History" },
  { href: "/pipeline", label: "How it works" },
  { href: "/stats", label: "Stats" },
  { href: "/benchmarks", label: "Benchmarks" },
];

export default function Nav() {
  const path = usePathname();
  // Opening Chat from the nav (or the logo) always starts a fresh conversation:
  // drop the active pointer so the chat page loads empty instead of restoring
  // the last one. Resuming a past chat goes through History, which sets the
  // pointer directly and never hits this handler.
  const startFresh = () => {
    try {
      clearActiveId();
    } catch {}
  };
  return (
    <nav className="flex items-center justify-between border-b border-border px-8 py-4">
      <Link href="/" onClick={startFresh} className="flex items-center gap-2.5">
        <Logo className="h-7 w-7" />
        <span className="text-2xl font-semibold tracking-tight">Fuse</span>
      </Link>

      <div className="flex items-center gap-1">
        {LINKS.map((l) => {
          const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              onClick={l.href === "/" ? startFresh : undefined}
              className={`rounded-full px-5 py-2.5 text-base font-medium transition ${
                active ? "bg-fg text-bg" : "text-muted hover:bg-subtle hover:text-fg"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
        <div className="ml-3">
          <NavLimitMeter />
        </div>
        <div className="ml-3 flex items-center gap-2">
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className={`flex h-10 w-10 items-center justify-center rounded-full border transition ${
              path.startsWith("/settings")
                ? "border-fg bg-fg text-bg"
                : "border-border text-muted hover:bg-subtle hover:text-fg"
            }`}
          >
            <SettingsIcon />
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}

function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
