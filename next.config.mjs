/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Produce a self-contained server (.next/standalone/server.js) that the
  // packaged Electron app can run without the full node_modules tree.
  output: "standalone",
};

export default nextConfig;
