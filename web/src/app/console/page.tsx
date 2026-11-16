"use client";

import { erc20Abi, txUrl, addressUrl } from "@aevum-kit/aevum";
import { decodeLeashError } from "@spendleash/sdk";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, isAddress, parseUnits, type Address, type Hash, type Hex } from "viem";
import { useAccount, useConfig, useReadContract } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useToken } from "@/components/useToken";
import { explain } from "@/lib/errors";
import { spendLeashAbi, spentTodayNow, statusOf, useOwnerLeash, type PaymentView, type SessionView } from "@/lib/leash";
import { short } from "@/lib/order";

type Busy = null | "deposit" | "withdraw" | "open" | `revoke:${string}`;

/** The live demo's owner wallet: what visitors see before connecting their own. */
const DEMO_OWNER = "0x09a94Bb336308b4E892A4e1106960b2Fe96De3D8" as const;

const EXPIRY = [
  { label: "1 hour", seconds: 3600 },
  { label: "24 hours", seconds: 86400 },
  { label: "7 days", seconds: 7 * 86400 },
  { label: "30 days", seconds: 30 * 86400 },
];

const PRESETS = [
  { name: "API agent", per: "0.05", day: "1", total: "5", expiry: 7 * 86400 },
  { name: "Research run", per: "0.25", day: "2", total: "2", expiry: 86400 },
  { name: "Tight trial", per: "0.01", day: "0.1", total: "0.1", expiry: 3600 },
];

/** Explain a revert from SpendLeash in plain words, falling back to the generic wallet explainer. */
function explainLeash(e: unknown): string {
  const decoded = decodeLeashError(e);
  return decoded ? decoded.message : explain(e);
}

export default function ConsolePage() {
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const token = useToken();
  const readOnly = !isConnected;
  const viewing: Address = address ?? DEMO_OWNER;
  const { leash, net, data, isLoading, error: loadError, refetch } = useOwnerLeash(viewing);
  const onChain = isConnected && chainId === net.chain.id;
  const fmt = (v: bigint) => formatUnits(v, token.decimals);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);

  const vault = useReadContract({
    address: leash,
    abi: spendLeashAbi,
    functionName: "balanceOf",
    args: [viewing],
    chainId: net.chain.id,
    query: { enabled: Boolean(leash), refetchInterval: 5000 },
  });
  const wallet = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: net.chain.id,
    query: { enabled: Boolean(token.address && address), refetchInterval: 5000 },
  });

  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<{ kind: "good" | "bad"; text: string; tx?: Hash } | null>(null);

  async function send(kind: Busy, fn: () => Promise<Hash>, ok: string) {
    setBusy(kind);
    setNotice(null);
    try {
      const hash = await fn();
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: net.chain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
      setNotice({ kind: "good", text: ok, tx: hash });
      await Promise.all([refetch(), vault.refetch(), wallet.refetch()]);
      return receipt;
    } catch (e) {
      console.error("[console]", kind, e);
      setNotice({ kind: "bad", text: explainLeash(e) });
      return null;
    } finally {
      setBusy(null);
    }
  }

  // ───── funds ─────
  const [amount, setAmount] = useState("1");
  const amountUnits = safeUnits(amount, token.decimals);

  async function deposit() {
    if (!leash || !token.address || !address || !amountUnits) return;
    setBusy("deposit");
    try {
      const allowance = await readAllowance();
      if (allowance < amountUnits) {
        const approveHash = await writeContract(config, {
          address: token.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [leash, amountUnits],
          chainId: net.chain.id,
        });
        await waitForTransactionReceipt(config, { hash: approveHash, chainId: net.chain.id });
      }
    } catch (e) {
      setBusy(null);
      setNotice({ kind: "bad", text: explainLeash(e) });
      return;
    }
    await send(
      "deposit",
      async () => {
        const { request } = await simulateContract(config, {
          account: address,
          address: leash,
          abi: spendLeashAbi,
          functionName: "deposit",
          args: [amountUnits],
          chainId: net.chain.id,
        });
        return writeContract(config, request);
      },
      `Deposited ${amount} ${token.symbol}. Your agents can now spend from it, within their leash.`,
    );
  }

  async function readAllowance(): Promise<bigint> {
    const { readContract } = await import("wagmi/actions");
    return readContract(config, {
      address: token.address!,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address!, leash!],
      chainId: net.chain.id,
    });
  }

  async function withdraw() {
    if (!leash || !address || !amountUnits) return;
    await send(
      "withdraw",
      async () => {
        const { request } = await simulateContract(config, {
          account: address,
          address: leash,
          abi: spendLeashAbi,
          functionName: "withdraw",
          args: [amountUnits],
          chainId: net.chain.id,
        });
        return writeContract(config, request);
      },
      `Withdrew ${amount} ${token.symbol} back to your wallet.`,
    );
  }

  // ───── new session ─────
  const [agent, setAgent] = useState("");
  const [per, setPer] = useState(PRESETS[0]!.per);
  const [day, setDay] = useState(PRESETS[0]!.day);
  const [total, setTotal] = useState(PRESETS[0]!.total);
  const [expiry, setExpiry] = useState(PRESETS[0]!.expiry);
  const [merchantsText, setMerchantsText] = useState("");

  const merchants = useMemo(
    () =>
      merchantsText
        .split(/[\s,]+/)
        .map((m) => m.trim())
        .filter(Boolean),
    [merchantsText],
  );
  const badMerchant = merchants.find((m) => !isAddress(m));
  const perU = safeUnits(per, token.decimals);
  const dayU = safeUnits(day, token.decimals);
  const totalU = safeUnits(total, token.decimals);
  const formError = !agent
    ? "Paste the agent's session key address."
    : !isAddress(agent)
      ? "The agent address doesn't look right."
      : !perU || !dayU || !totalU
        ? "Every limit needs a positive amount."
        : perU > dayU
          ? "The per-payment cap can't be above the daily cap."
          : dayU > totalU
            ? "The daily cap can't be above the lifetime cap."
            : merchants.length === 0
              ? "Add at least one merchant the agent may pay."
              : badMerchant
                ? `"${short(badMerchant)}" is not an address.`
                : null;

  async function openSession() {
    if (formError || !leash || !address) return;
    const validUntil = Math.floor(Date.now() / 1000) + expiry;
    await send(
      "open",
      async () => {
        const { request } = await simulateContract(config, {
          account: address,
          address: leash,
          abi: spendLeashAbi,
          functionName: "openSession",
          args: [agent as Address, { perPaymentCap: perU!, dailyCap: dayU!, totalCap: totalU!, validUntil }, merchants as Address[]],
          chainId: net.chain.id,
        });
        return writeContract(config, request);
      },
      "Leash created. Give the session id to your agent; it never needs your wallet.",
    );
  }

  async function revoke(id: Hex) {
    if (!leash || !address) return;
    await send(
      `revoke:${id}`,
      async () => {
        const { request } = await simulateContract(config, {
          account: address,
          address: leash,
          abi: spendLeashAbi,
          functionName: "revoke",
          args: [id],
          chainId: net.chain.id,
        });
        return writeContract(config, request);
      },
      "Revoked. Every payment this agent signs from now on is refused on chain.",
    );
  }

  const sessions = data?.sessions ?? [];
  const payments = data?.payments ?? [];
  const active = sessions.filter((s) => statusOf(s, now) === "active");
  const spentAll = sessions.reduce((sum, s) => sum + s.spentTotal, 0n);

  return (
    <main className="shell page">
      <div className="page-glow" aria-hidden="true" />
      <div className="page-head">
        <div>
          <span className="eyebrow">
            <span className="bar" />
            Owner console · Aevum testnet
          </span>
          <h1>Your agents. Your rules. On chain.</h1>
          <p className="lede">
            Your AI agent pays for APIs in {token.symbol} on its own, but only inside limits the chain enforces: per payment, per day, in total, before an
            expiry, and only to merchants you list. Even if the agent is tricked into signing something else, the payment is refused.
          </p>
        </div>
        <div className="score">
          <span className="fine">Active leashes</span>
          <span className="score-num num">{active.length}</span>
          <span className="fine num">
            {fmt(spentAll)} {token.symbol} spent by agents
          </span>
        </div>
      </div>

      {!leash && (
        <div className="notice warn">
          <strong>SpendLeash isn&apos;t configured for {net.label}.</strong>
          <span>
            Set <code>NEXT_PUBLIC_LEASH_{net.key.toUpperCase()}</code> to the deployed address.
          </span>
        </div>
      )}

      {notice && (
        <div className={`notice ${notice.kind}`} role={notice.kind === "bad" ? "alert" : "status"}>
          <div className="row-between">
            <span>{notice.text}</span>
            {notice.tx && net.hasExplorer && (
              <a href={txUrl(notice.tx)} target="_blank" rel="noreferrer" className="mono">
                {short(notice.tx)} ↗
              </a>
            )}
          </div>
        </div>
      )}

      <div className="console-grid">
        <div className="stack">
          {readOnly ? (
            <section className="card card-glow" aria-labelledby="connect-h">
              <span className="eyebrow">
                <span className="bar" />
                Read-only preview
              </span>
              <h2 id="connect-h" style={{ marginTop: 14, fontSize: 26, letterSpacing: "-0.02em" }}>
                Connect the owner wallet
              </h2>
              <p className="sub" style={{ marginBottom: 20 }}>
                You&apos;re looking at the live demo owner&apos;s leashes, straight from Aevum. Connect a wallet to fund your own agent budget, open leashes and
                revoke them.
              </p>
              <ConnectButton />
              <ul className="bullets" style={{ marginTop: 24 }}>
                <li>The wallet holds the money and sets the limits. Agents never get its key.</li>
                <li>Needs a little tQDAY for gas and tUSD8 to fund the budget (QDay Discord /faucet).</li>
                <li>Network: Aevum testnet, chain 44005. The wallet is prompted to add it.</li>
              </ul>
              <div className="balance-row" style={{ marginTop: 24, borderTop: "1px solid var(--line)", paddingTop: 18 }}>
                <div>
                  <span className="fine">Demo owner&apos;s agent budget</span>
                  <div className="total num">
                    {vault.data !== undefined ? fmt(vault.data) : "–"} <small>{token.symbol}</small>
                  </div>
                </div>
              </div>
            </section>
          ) : (
            <>
              <section className="card" aria-labelledby="funds-h">
                <h2 id="funds-h">Agent budget</h2>
                <p className="sub">Money your agents may draw from. Withdraw any time; payments stop when it runs out.</p>
                <div className="balance-row">
                  <div>
                    <span className="fine">In SpendLeash</span>
                    <div className="total num">
                      {vault.data !== undefined ? fmt(vault.data) : "–"} <small>{token.symbol}</small>
                    </div>
                  </div>
                  <div className="right">
                    <span className="fine">In your wallet</span>
                    <div className="num mono">
                      {wallet.data !== undefined ? fmt(wallet.data) : "–"} {token.symbol}
                    </div>
                  </div>
                </div>
                <label className="field-label" htmlFor="amount">
                  Amount
                </label>
                <div className="inline-form">
                  <input id="amount" className="field" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  <button type="button" className="btn" disabled={!onChain || !amountUnits || busy !== null} onClick={deposit}>
                    {busy === "deposit" ? "Depositing…" : "Deposit"}
                  </button>
                  <button
                    type="button"
                    className="btn line"
                    disabled={!onChain || !amountUnits || busy !== null || (vault.data ?? 0n) === 0n}
                    onClick={withdraw}
                  >
                    {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
                  </button>
                </div>
              </section>

              <section className="card" aria-labelledby="new-h">
                <h2 id="new-h">New leash</h2>
                <p className="sub">One leash per agent key. The limits are checked by the contract on every payment.</p>
                <div className="presets" role="group" aria-label="Presets">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      className="btn line small"
                      onClick={() => {
                        setPer(p.per);
                        setDay(p.day);
                        setTotal(p.total);
                        setExpiry(p.expiry);
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="form">
                  <label className="field-label" htmlFor="agent">
                    Agent session key
                  </label>
                  <input id="agent" className="field" placeholder="0x…" value={agent} onChange={(e) => setAgent(e.target.value.trim())} />
                  <div className="limits">
                    <div>
                      <label className="field-label" htmlFor="per">
                        Per payment
                      </label>
                      <input id="per" className="field" inputMode="decimal" value={per} onChange={(e) => setPer(e.target.value)} />
                    </div>
                    <div>
                      <label className="field-label" htmlFor="day">
                        Per day
                      </label>
                      <input id="day" className="field" inputMode="decimal" value={day} onChange={(e) => setDay(e.target.value)} />
                    </div>
                    <div>
                      <label className="field-label" htmlFor="total">
                        Lifetime
                      </label>
                      <input id="total" className="field" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
                    </div>
                  </div>
                  <span className="field-label">Expires after</span>
                  <div className="seg" role="radiogroup" aria-label="Expires after">
                    {EXPIRY.map((x) => (
                      <button key={x.seconds} type="button" role="radio" aria-checked={expiry === x.seconds} onClick={() => setExpiry(x.seconds)}>
                        {x.label}
                      </button>
                    ))}
                  </div>
                  <label className="field-label" htmlFor="merchants">
                    Merchants it may pay
                  </label>
                  <textarea
                    id="merchants"
                    className="field"
                    rows={3}
                    placeholder="One address per line"
                    value={merchantsText}
                    onChange={(e) => setMerchantsText(e.target.value)}
                  />
                  {formError && (agent || merchantsText) && <p className="field-error">{formError}</p>}
                  <button type="button" className="btn block" disabled={!onChain || Boolean(formError) || busy !== null} onClick={openSession}>
                    {busy === "open" ? "Creating leash…" : "Create leash"}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>

        <div className="stack">
          <section aria-labelledby="sessions-h" className="stack">
            <div className="row-head">
              <h2 id="sessions-h">{readOnly ? "Demo owner’s leashes" : "Your leashes"}</h2>
              <span className="fine">{isLoading ? "Loading…" : `Refreshes every 5 s · block ${data?.head ?? "–"}`}</span>
            </div>
            {loadError && <div className="notice bad">Couldn&apos;t read the chain: {explain(loadError)}</div>}
            {!isLoading && sessions.length === 0 && (
              <div className="card empty">No leashes yet. Create one on the left, then point your agent at its session id.</div>
            )}
            {sessions.map((s) => (
              <SessionCard
                key={s.id}
                s={s}
                now={now}
                lastPaymentDay={data?.lastPaymentDay.get(s.id)}
                fmt={fmt}
                symbol={token.symbol}
                hasExplorer={net.hasExplorer}
                busy={busy === `revoke:${s.id}`}
                disabled={!onChain || busy !== null}
                onRevoke={() => revoke(s.id)}
                readOnly={readOnly}
              />
            ))}
          </section>
        </div>
      </div>

      <PaymentsFeed payments={payments} times={data?.times} fmt={fmt} symbol={token.symbol} hasExplorer={net.hasExplorer} />
    </main>
  );
}

function SessionCard(props: {
  s: SessionView;
  now: number;
  lastPaymentDay: number | undefined;
  fmt: (v: bigint) => string;
  symbol: string;
  hasExplorer: boolean;
  busy: boolean;
  disabled: boolean;
  onRevoke: () => void;
  readOnly?: boolean;
}) {
  const { s, now, fmt, symbol } = props;
  const [confirming, setConfirming] = useState(false);
  const status = statusOf(s, now);
  const today = spentTodayNow(s, props.lastPaymentDay, now);
  return (
    <article className={`card session ${status}`}>
      <div className="session-top">
        <div>
          <div className="session-agent">
            Agent <span className="mono">{short(s.agent)}</span>
          </div>
          <div className="fine mono" title={s.id}>
            session {short(s.id)}
          </div>
        </div>
        <span className={`status-pill ${status === "active" ? "good" : status === "revoked" ? "bad" : "warn"}`}>
          {status === "active" ? `Active · ${left(s.validUntil - now)} left` : status === "revoked" ? "Revoked" : "Expired"}
        </span>
      </div>

      <Meter label="Today" used={today} cap={s.dailyCap} fmt={fmt} symbol={symbol} />
      <Meter label="Lifetime" used={s.spentTotal} cap={s.totalCap} fmt={fmt} symbol={symbol} />
      <div className="line muted small">
        <span>Max per payment</span>
        <span className="mono num">
          {fmt(s.perPaymentCap)} {symbol}
        </span>
      </div>

      <div className="merchants">
        <span className="fine">May pay</span>
        <div className="merchant-chips">
          {s.merchants.map((m) =>
            props.hasExplorer ? (
              <a key={m} className="pill mono" href={addressUrl(m)} target="_blank" rel="noreferrer">
                {short(m)}
              </a>
            ) : (
              <span key={m} className="pill mono">
                {short(m)}
              </span>
            ),
          )}
        </div>
      </div>

      {status === "active" && !props.readOnly && (
        <div className="session-actions">
          {confirming ? (
            <>
              <span className="fine">Stop this agent from paying anyone?</span>
              <button type="button" className="btn line small" onClick={() => setConfirming(false)} disabled={props.busy}>
                Keep
              </button>
              <button type="button" className="btn danger small" onClick={props.onRevoke} disabled={props.disabled}>
                {props.busy ? "Revoking…" : "Yes, revoke now"}
              </button>
            </>
          ) : (
            <button type="button" className="btn danger-outline small" onClick={() => setConfirming(true)} disabled={props.disabled}>
              Revoke
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function Meter({ label, used, cap, fmt, symbol }: { label: string; used: bigint; cap: bigint; fmt: (v: bigint) => string; symbol: string }) {
  const pct = cap > 0n ? Number((used * 1000n) / cap) / 10 : 0;
  const tone = pct >= 100 ? "full" : pct >= 80 ? "high" : "";
  return (
    <div className="meter">
      <div className="line small">
        <span>{label}</span>
        <span className="mono num">
          {fmt(used)} / {fmt(cap)} {symbol}
        </span>
      </div>
      <div
        className={`progress ${tone}`}
        role="progressbar"
        aria-label={`${label} spending`}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function PaymentsFeed(props: {
  payments: PaymentView[];
  times: Map<bigint, number> | undefined;
  fmt: (v: bigint) => string;
  symbol: string;
  hasExplorer: boolean;
}) {
  return (
    <section className="card flush" aria-labelledby="feed-h">
      <div className="feed-head">
        <h2 id="feed-h">Agent payments</h2>
        <span className="fine">Every payment your agents made, read from Paid events on chain.</span>
      </div>
      {props.payments.length === 0 ? (
        <div className="empty">No payments yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th>Merchant</th>
                <th className="right">Amount</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {props.payments.slice(0, 50).map((p) => {
                const t = props.times?.get(p.block);
                return (
                  <tr key={p.tx}>
                    <td>{t ? new Date(t * 1000).toLocaleTimeString() : `#${p.block}`}</td>
                    <td className="mono">{short(p.agent)}</td>
                    <td className="mono">{short(p.merchant)}</td>
                    <td className="right mono num">
                      {props.fmt(p.amount)} {props.symbol}
                    </td>
                    <td className="mono">
                      {props.hasExplorer ? (
                        <a href={txUrl(p.tx)} target="_blank" rel="noreferrer">
                          {short(p.tx)} ↗
                        </a>
                      ) : (
                        short(p.tx)
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function safeUnits(v: string, decimals: number): bigint | null {
  try {
    const u = parseUnits(v.trim() || "0", decimals);
    return u > 0n ? u : null;
  } catch {
    return null;
  }
}

function left(seconds: number): string {
  if (seconds <= 0) return "0 s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} m`;
  return `${m} m ${Math.floor(seconds % 60)} s`;
}
