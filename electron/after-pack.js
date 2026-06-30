// electron-builder strips `node_modules` out of directories copied via
// extraResources. The standalone Next.js server needs its bundled node_modules
// (it `require`s "next" at runtime), so copy them into the packaged app here,
// after the bundle is assembled - this bypasses that filter.
const fs = require("fs");
const path = require("path");

exports.default = async function afterPack(context) {
  const src = path.join(__dirname, "..", ".next", "standalone", "node_modules");
  if (!fs.existsSync(src)) throw new Error(`Missing ${src} - run the build/prepare step first.`);

  const productName = context.packager.appInfo.productFilename;
  const isMac = context.electronPlatformName === "darwin";
  const resources = isMac
    ? path.join(context.appOutDir, `${productName}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");

  const dest = path.join(resources, "app", "node_modules");
  fs.cpSync(src, dest, { recursive: true });
  console.log(`afterPack: copied standalone node_modules → ${path.relative(process.cwd(), dest)}`);
};
