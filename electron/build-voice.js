// Compile the macOS speech-to-text helper (Swift) and ad-hoc sign it so TCC
// treats it consistently. Skipped gracefully if swiftc isn't available.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "voice");
const src = path.join(dir, "transcribe.swift");
const out = path.join(dir, "fuse-transcribe");

function has(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (process.platform !== "darwin" || !has("swiftc")) {
  console.log("build-voice: swiftc not available - skipping (voice helper won't be bundled).");
  process.exit(0);
}

execSync(
  `swiftc -O -swift-version 5 ${JSON.stringify(src)} -o ${JSON.stringify(out)} -framework Speech -framework AVFoundation`,
  { stdio: "inherit" },
);
fs.chmodSync(out, 0o755);
try {
  execSync(`codesign --force --sign - ${JSON.stringify(out)}`, { stdio: "ignore" });
} catch {
  /* ad-hoc signing best-effort */
}
console.log("build-voice: built", path.relative(path.join(__dirname, ".."), out));
