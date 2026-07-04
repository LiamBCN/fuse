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
  { href: "/settings", label: "Settings" },
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
        <div className="ml-3">
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
