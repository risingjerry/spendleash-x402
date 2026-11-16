"use client";

import { useState } from "react";

const TABS = {
  merchant: {
    label: "Merchant",
    code: [
      ["c", "// Any API that speaks Request/Response: Next.js, Hono, Bun, Workers"],
      ["", "import { createPaywall } from \"@spendleash/sdk\";"],
      ["", ""],
      ["", "const paywall = createPaywall({"],
      ["", "  publicClient, walletClient: relayer,   // pays gas, never holds funds"],
      ["", "  leash: \"0x516B4ccB43a7875bD2FDe8eB536BBE9C7E083728\","],
      ["", "  payTo: merchant,"],
      ["", "  price: 50_000n,                         // 0.05 tUSD8"],
      ["", "  description: \"QDAY spot quote\","],
      ["", "});"],
      ["", ""],
      ["", "export const GET = (req: Request) =>"],
      ["", "  paywall(req, async () => Response.json({ price: 1.07 }));"],
    ],
  },
  agent: {
    label: "Agent",
    code: [
      ["c", "// A drop-in fetch. 402 → sign → retry. The agent holds no funds, no gas."],
      ["", "import { createLeashFetch } from \"@spendleash/sdk\";"],
      ["", ""],
      ["", "const pay = createLeashFetch({"],
      ["", "  account: sessionKey, sessionId, chainId: 44005, leash, publicClient,"],
      ["", "  policy: { maxPerRequest: 100_000n, allowPayTo: [merchant] },"],
      ["", "});"],
      ["", ""],
      ["", "const res = await pay(\"https://api.quotes.example/v1/quote\");"],
      ["", "res.payment?.transaction  // settlement tx on Aevum"],
      ["c", "// Outside the leash? LeashPaymentRefused { code: \"MerchantNotAllowed\" }"],
    ],
  },
  owner: {
    label: "Owner",
    code: [
      ["", "import { deposit, openSession, revoke } from \"@spendleash/sdk\";"],
      ["", ""],
      ["", "await deposit(owner, 5_000_000n);                  // 5 tUSD8 budget"],
      ["", "const { sessionId } = await openSession(owner, agentKey, {"],
      ["", "  perPaymentCap: 50_000n,      // 0.05 per call"],
      ["", "  dailyCap:      1_000_000n,   // 1.00 per day"],
      ["", "  totalCap:      5_000_000n,   // 5.00 lifetime"],
      ["", "  validUntil:    now + 7 * DAY,"],
      ["", "}, [merchant]);"],
      ["", ""],
      ["", "await revoke(owner, sessionId);                    // kill switch, next block"],
    ],
  },
} as const;

type Tab = keyof typeof TABS;

function paint(line: string) {
  // Tiny highlighter: strings, keywords, calls. Good enough for three snippets.
  const parts = line.split(/(".*?"|\b(?:import|from|const|await|export|async)\b|\b[a-zA-Z]+(?=\())/g);
  return parts.map((p, i) =>
    /^".*"$/.test(p) ? <span key={i} className="s">{p}</span> : /^(import|from|const|await|export|async)$/.test(p) ? <span key={i} className="k">{p}</span> : /^[a-zA-Z]+$/.test(p) && line.includes(`${p}(`) ? <span key={i} className="f">{p}</span> : p,
  );
}

export function CodeTabs() {
  const [tab, setTab] = useState<Tab>("merchant");
  return (
    <div className="code-card">
      <div className="tabs" role="tablist">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}>
            {TABS[t].label}
          </button>
        ))}
      </div>
      <pre className="code">
        <code>
          {TABS[tab].code.map(([kind, line], i) => (
            <div key={i}>{kind === "c" ? <span className="c">{line}</span> : line ? paint(line) : " "}</div>
          ))}
        </code>
      </pre>
    </div>
  );
}
