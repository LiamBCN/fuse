"use client";
// Small client-only notification helpers. Kept out of the page so the chat
// runtime can fire them when a background generation finishes - even if no chat
// page is mounted at the time.

export function playChime() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [
      [880, 0],
      [1320, 0.15],
    ].forEach(([f, t]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f as number;
      g.gain.setValueAtTime(0.0001, now + (t as number));
      g.gain.exponentialRampToValueAtTime(0.16, now + (t as number) + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + (t as number) + 0.2);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(now + (t as number));
      o.stop(now + (t as number) + 0.22);
    });
    setTimeout(() => ctx.close(), 700);
  } catch {}
}

export function notifyUser(title: string, body: string) {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") new Notification(title, { body });
    else if (Notification.permission !== "denied")
      Notification.requestPermission().then((p) => {
        if (p === "granted") new Notification(title, { body });
      });
  } catch {}
}
