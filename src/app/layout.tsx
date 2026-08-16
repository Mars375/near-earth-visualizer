import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const telemetryMono = JetBrains_Mono({
  variable: "--font-telemetry-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Near Earth Visualizer",
  description: "WebGL visualization of near-Earth objects tracked by NASA.",
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
