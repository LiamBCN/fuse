"use client";
import { useEffect, useState } from "react";
import Onboarding from "./Onboarding";
import Logo from "./Logo";

// First-run gate: until the user has completed the setup check once, show the
// onboarding screen instead of the app. The flag lives in localStorage (the app
// uses a stable port, so the origin - and thus this flag - persists).
export default function SetupGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      setReady(localStorage.getItem("fuse.setupComplete.v1") === "1");
    } catch {
      setReady(true); // if localStorage is unavailable, don't lock the user out
    }
  }, []);

  if (ready === null) {
    return (
      <div className="flex h-full flex-1 items-center justify-center">
        <Logo className="h-10 w-10 animate-pulse" />
      </div>
    );
  }
  if (!ready) return <Onboarding onDone={() => setReady(true)} />;
  return <>{children}</>;
}
