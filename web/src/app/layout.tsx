import type { Metadata } from "next";
import { Inter, Inter_Tight, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Reveal } from "@/components/Reveal";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const interTight = Inter_Tight({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-inter-tight", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: { default: "SpendLeash · spending limits for AI agents", template: "%s · SpendLeash" },
  description: "Give your AI agent a budget, not your wallet. On-chain per-payment, daily and lifetime caps, merchant allowlist and instant revoke for x402 agent payments on QDay Aevum.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${interTight.variable} ${jetbrains.variable}`}>
      <body>
        <div className="grain" aria-hidden="true" />
        <Providers>
          <Header />
          {children}
          <Reveal />
        </Providers>
      </body>
    </html>
  );
}
