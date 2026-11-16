"use client";

import { fmtUnits, useFeed } from "./useFeed";

/** Marquee of live network numbers, read from the chain via /api/feed. */
export function Ticker() {
  const { data } = useFeed();
  const s = data?.stats;
  const items: [string, string, string][] = [
    ["Aevum testnet", `block #${data ? data.head.toLocaleString("en-US") : "…"}`, "live"],
    ["Agent payments", s ? String(s.payments) : "…", "settled"],
    ["Volume", s ? `${fmtUnits(s.volume)} tUSD8` : "…", "on-chain"],
    ["Leashes opened", s ? String(s.leashes) : "…", "online"],
    ["Kill switch", s ? `${s.revoked} revoked` : "…", "ready"],
    ["Prompt injections paid", "0", "enforced"],
    ["Agent gas spent", "0 tQDAY", "gasless"],
    ["Policy", "per-call · daily · lifetime · allowlist · expiry", "on-chain"],
  ];
  const row = (copy: string) => items.map(([k, v, st]) => (
    <span className="tick" key={copy + k} aria-hidden={copy === "b" || undefined}>
      <span className="k">{k}</span>
      <span className="v num">{v}</span>
      <span className="s">{st}</span>
    </span>
  ));
  return (
    <div className="ticker" aria-label="Live network stats">
      <div className="ticker-track">
        {row("a")}
        {row("b")}
      </div>
    </div>
  );
}
