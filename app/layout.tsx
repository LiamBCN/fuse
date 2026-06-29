import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "Fuse — Mixture of Agents",
  description: "Ask multiple AI models, fuse their answers into one.",
};

// Set the theme class before first paint to avoid a flash. Respects a saved
// choice, otherwise follows the OS preference.
const themeInit = `(function(){try{var t=localStorage.getItem('fuse.theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.classList.toggle('dark',t==='dark');}catch(e){document.documentElement.classList.add('dark');}try{if(navigator.userAgent.indexOf('Electron')>-1){document.documentElement.classList.add('electron');}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="flex h-screen flex-col bg-bg text-fg antialiased">
        <Nav />
        <main className="flex-1 overflow-hidden">{children}</main>
      </body>
    </html>
  );
}
