import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const telemetryMono = JetBrains_Mono({
  variable: "--font-telemetry-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Near Earth Visualizer",
  description: "WebGL visualization of near-Earth objects tracked by NASA.",
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
