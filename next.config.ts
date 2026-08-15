import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev server is reached over Tailscale (phone browser, no local screen yet),
  // not localhost — Next 16 blocks cross-origin dev-resource requests by default.
  allowedDevOrigins: ['cortex', '100.115.193.55'],
};

export default nextConfig;
