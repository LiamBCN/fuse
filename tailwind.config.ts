import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Monochrome only. Every surface references a CSS variable that flips
      // between light and dark in globals.css — no per-component color classes.
      colors: {
        bg: "var(--bg)",
        fg: "var(--fg)",
        subtle: "var(--subtle)",
        muted: "var(--muted)",
        border: "var(--border)",
      },
      borderRadius: {
        xl: "14px",
        "2xl": "18px",
        "3xl": "24px",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};

export default config;
