"use client";

import { useQuery } from "@tanstack/react-query";
import type { Feed } from "@/app/api/feed/route";

/** Public on-chain feed of SpendLeash activity (server-cached; polls every 10 s). */
export function useFeed() {
  return useQuery({
    queryKey: ["spendleash-feed"],
    queryFn: async () => {
      const res = await fetch("/api/feed");
      if (!res.ok) throw new Error(`feed ${res.status}`);
      return (await res.json()) as Feed;
    },
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

export const fmtUnits = (v: string | bigint, decimals = 6) => {
  const n = Number(BigInt(v)) / 10 ** decimals;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: n > 0 && n < 1 ? 2 : 0 });
};

export const shortHex = (h: string, a = 6, b = 4) => (h.length > a + b + 2 ? `${h.slice(0, a)}…${h.slice(-b)}` : h);

export function ago(time?: number) {
  if (!time) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - time));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
