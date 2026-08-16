import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev server is reached over Tailscale (phone browser) and locally
  // (Playwright, for visual checks) — Next 16 blocks cross-origin
  // dev-resource requests by default.
  allowedDevOrigins: ['cortex', '100.115.193.55', 'localhost', '127.0.0.1'],
  // sharp is a native addon (platform-specific .node binary) — used directly
  // in src/app/api/earth-imagery/route.ts, not through next/image, so Next
  // doesn't externalize it automatically. Bundling it (the default) hung the
  // production build indefinitely, locally and on Vercel, with no error
  // output. This tells Next to require() it at runtime instead of bundling.
  serverExternalPackages: ['sharp'],
};

export default nextConfig;
