import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

export const SITE_URL = "https://near-earth-visualizer.vercel.app";

const telemetryMono = JetBrains_Mono({
  variable: "--font-telemetry-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Near Earth Visualizer",
  description: "WebGL visualization of near-Earth objects tracked by NASA.",
  openGraph: {
    title: "Near Earth Visualizer",
    description:
      "Real-time WebGL solar system — live NASA orbital data, ISS, Starlink, and near-Earth objects.",
    url: SITE_URL,
    siteName: "Near Earth Visualizer",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Near Earth Visualizer",
    description: "Real-time WebGL solar system — live NASA orbital data, ISS, Starlink, and near-Earth objects.",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "NEO Viz",
  },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#05060a",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${telemetryMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
