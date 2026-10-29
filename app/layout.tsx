import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Trader Inversion",
  description: "Five LLM paper-trading bots on EUR/USD, measured for consistent directional error.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">AI Trader Inversion</Link>
          <span className="muted">EUR/USD · paper only</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
