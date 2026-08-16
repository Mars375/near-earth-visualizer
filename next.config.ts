import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev server is reached over Tailscale (phone browser) and locally
  // (Playwright, for visual checks) — Next 16 blocks cross-origin
  // dev-resource requests by default.
  allowedDevOrigins: ['cortex', '100.115.193.55', 'localhost', '127.0.0.1'],
};

export default nextConfig;
