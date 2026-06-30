"use client";
import { useEffect, useState } from "react";
import Logo from "./Logo";

const REPO_URL = "https://github.com/LiamBCN/fuse";

// Fuse answers run through the Claude / Codex CLIs installed on your Mac, so it
// must run as the native desktop app (Electron) - never as a plain web page that
// can't reach those CLIs. The browser is allowed only in development
// (`npm run dev`); end users always get the packaged production build, where the
// only non-Electron way in is a stray browser tab - which we block here.
function nativeAllowed(): boolean {
  if (process.env.NODE_ENV === "development") return true;
  try {
    if (navigator.userAgent.includes("Electron")) return true;
    if (typeof (window as { fuse?: unknown }).fuse !== "undefined") return true;
  } catch {
    /* no window/navigator - treat as blocked */
  }
  return false;
}

// Gate that keeps Fuse out of the browser. Renders a brief logo while it resolves
// the environment client-side (matches SetupGate's pattern, avoids a hydration
// mismatch), then either the app or the "open the native app" screen.
export default function NativeGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "ok" | "blocked">("checking");

  useEffect(() => {
    setState(nativeAllowed() ? "ok" : "blocked");
  }, []);

  if (state === "checking") {
    return (
      <div className="flex h-full flex-1 items-center justify-center">
        <Logo className="h-10 w-10 animate-pulse" />
      </div>
    );
  }
  if (state === "blocked") return <NativeRequired />;
  return <>{children}</>;
}

function NativeRequired() {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center px-6 text-center">
      <Logo className="h-20 w-20" />
      <h1
        className="mt-8 bg-gradient-to-r from-red-600 to-amber-500 bg-clip-text font-bold tracking-tight text-transparent dark:from-red-500 dark:to-amber-400"
        style={{ fontSize: "3.25rem", lineHeight: 1.05 }}
      >
        Open Fuse as a Mac app
      </h1>
      <p className="mt-5 max-w-md text-lg text-muted">
        Fuse runs the Claude and Codex CLIs on your Mac, so it works only as the
        native desktop app - not in a web browser. Install it once and launch it
        from Applications.
      </p>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-10 inline-flex items-center gap-2.5 rounded-full bg-fg px-7 py-3 text-lg font-medium text-bg transition hover:opacity-90"
      >
        <GitHubGlyph />
        Get Fuse on GitHub
      </a>
      <p className="mt-6 max-w-md text-sm text-muted">
        Tip: paste the install prompt from the README into Claude Code or Codex and
        it will set Fuse up and launch it for you.
      </p>
    </div>
  );
}

function GitHubGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
