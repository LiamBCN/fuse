"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";
import Logo from "./Logo";

const LINKS = [
  { href: "/", label: "Chat" },
  { href: "/history", label: "History" },
  { href: "/pipeline", label: "How it works" },
  { href: "/stats", label: "Stats" },
  { href: "/settings", label: "Settings" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="flex items-center justify-between border-b border-border px-8 py-4">
      <Link href="/" className="flex items-center gap-2.5">
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
              className={`rounded-full px-5 py-2.5 text-base font-medium transition ${
                active ? "bg-fg text-bg" : "text-muted hover:bg-subtle hover:text-fg"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
        <div className="ml-3">
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
