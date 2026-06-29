// Stage the standalone Next.js build for packaging.
// `output: "standalone"` emits .next/standalone/server.js but does NOT copy the
// static chunks or the public/ folder — the server expects them next to itself.
// Copy them in so the bundled server can serve the app offline.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const standalone = path.join(root, ".next", "standalone");

if (!fs.existsSync(standalone)) {
  console.error("Missing .next/standalone — run `next build` first.");
  process.exit(1);
}

const copy = (from, to, label) => {
  if (!fs.existsSync(from)) {
    console.log(`(skip) no ${label} at ${from}`);
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`copied ${label} → ${path.relative(root, to)}`);
};

copy(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), ".next/static");
copy(path.join(root, "public"), path.join(standalone, "public"), "public");

console.log("standalone build ready for packaging.");
