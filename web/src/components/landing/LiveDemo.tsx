"use client";

import { txUrl } from "@aevum-kit/aevum";
import { useEffect, useRef, useState } from "react";
import type { DemoEvent } from "@/app/api/demo/route";
import replay from "./replay.json";
import { fmtUnits, shortHex } from "./useFeed";

type Mode = "idle" | "replay" | "live" | "done" | "error";

const DAILY = 100_000n; // 0.10 tUSD8, the demo leash's daily cap

const CHECKS: { id: string; label: string; when: (e: DemoEvent[]) => boolean; bad?: boolean }[] = [
  { id: "paid", label: "Agent pays for APIs on its own, with 0 gas", when: (e) => e.some((x) => x.kind === "ok" && x.id === "pay2") },
  { id: "inject", label: "Prompt-injected payment refused", when: (e) => e.some((x) => x.kind === "blocked" && x.id === "direct"), bad: true },
  { id: "cap", label: "Per-call cap held", when: (e) => e.some((x) => x.kind === "blocked" && x.id === "overcap"), bad: true },
  { id: "daily", label: "Daily budget held", when: (e) => e.some((x) => x.kind === "blocked" && x.id === "daily"), bad: true },
  { id: "revoke", label: "Revoke took effect immediately", when: (e) => e.some((x) => x.kind === "blocked" && x.id === "after"), bad: true },
];

export function LiveDemo() {
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [mode, setMode] = useState<Mode>("idle");
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [source, setSource] = useState<"replay" | "live">("replay");
  const body = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const started = useRef(false);

  useEffect(() => {
    fetch("/api/demo")
      .then((r) => r.json())
      .then((d: { enabled: boolean }) => setEnabled(d.enabled))
      .catch(() => setEnabled(false));
  }, []);

  // Start the recorded replay the first time the terminal scrolls into view.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting && !started.current) {
        started.current = true;
        playReplay();
      }
    }, { threshold: 0.35 });
    io.observe(el);
    return () => {
      io.disconnect();
      timers.current.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [events]);

  function playReplay() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setEvents([]);
    setError(null);
    setSource("replay");
    setMode("replay");
    let t = 300;
    const script = replay as DemoEvent[];
    if (!script.length) {
      setMode("idle");
      return;
    }
    script.forEach((e, i, all) => {
      t += e.kind === "step" ? 650 : Math.min(1400, ("ms" in e ? e.ms : 600) / 2 + 300);
      timers.current.push(
        setTimeout(() => {
          setEvents((prev) => [...prev, e]);
          if (i === all.length - 1) setMode("done");
        }, t),
      );
    });
  }

  async function runLive() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setEvents([]);
    setError(null);
    setSource("live");
    setMode("live");
    try {
      const res = await fetch("/api/demo", { method: "POST" });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `The demo server answered ${res.status}.`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const e = JSON.parse(line) as DemoEvent;
          setEvents((prev) => [...prev, e]);
          if (e.kind === "error") throw new Error(e.text);
        }
      }
      setMode("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setMode("error");
    }
  }

  const spent = events.reduce((s, e) => (e.kind === "ok" && e.amount ? s + BigInt(e.amount) : s), 0n);
  const blocked = events.filter((e) => e.kind === "blocked").length;
  const pct = Number((spent * 1000n) / DAILY) / 10;
  const isLive = mode === "live";
  const done = events.find((e): e is Extract<DemoEvent, { kind: "done" }> => e.kind === "done");

  return (
    <div className="demo-grid" ref={root}>
      <div className="term">
        <div className="term-bar">
          <span className="term-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="term-title">spendleash@aevum-44005 ~ x402 agent session</span>
          <span className={`live-dot${isLive ? " on" : ""}`}>{isLive ? "live on chain" : mode === "replay" ? "replay" : mode === "done" ? "finished" : "idle"}</span>
        </div>
        <div className="term-body" ref={body} aria-live="polite">
          {events.length === 0 && <p className="term-empty">$ waiting for an agent…</p>}
          {events.map((e, i) => {
            if (e.kind === "step") {
              return (
                <div className="tl step" key={i}>
                  <span className="g">›</span>
                  <span className="msg">
                    <span className={`who ${e.actor}`}>{e.actor}</span>
                    {e.title}
                  </span>
                  <span />
                </div>
              );
            }
            if (e.kind === "ok") {
              return (
                <div className="tl ok" key={i}>
                  <span className="g">✓</span>
                  <span className="msg">{e.text}</span>
                  <span className="ms">{(e.ms / 1000).toFixed(1)}s</span>
                  {e.tx && (
                    <span className="txl">
                      tx{" "}
                      <a href={txUrl(e.tx)} target="_blank" rel="noreferrer">
                        {shortHex(e.tx, 10, 8)} ↗
                      </a>
                    </span>
                  )}
                </div>
              );
            }
            if (e.kind === "blocked") {
              return (
                <div className="tl blocked" key={i}>
                  <span className="g">✕</span>
                  <span className="msg">
                    <span className="code">{e.code}</span> · {e.text}
                  </span>
                  <span className="ms">{(e.ms / 1000).toFixed(1)}s</span>
                </div>
              );
            }
            if (e.kind === "done") {
              return (
                <div className={`tl ${e.ok ? "info" : "blocked"}`} key={i}>
                  <span className="g">■</span>
                  <span className="msg" style={{ color: "var(--text)" }}>
                    {e.text}
                  </span>
                  <span />
                </div>
              );
            }
            return (
              <div className={`tl ${e.kind === "error" ? "blocked" : "info"}`} key={i}>
                <span className="g">{e.kind === "error" ? "!" : "·"}</span>
                <span className="msg">{e.text}</span>
                <span />
              </div>
            );
          })}
          {(mode === "live" || mode === "replay") && (
            <div className="tl">
              <span className="g" />
              <span className="msg">
                <span className="cursor" />
              </span>
              <span />
            </div>
          )}
        </div>
        <div className="term-foot">
          <span className="note">
            {error
              ? error
              : isLive
                ? "Running on Aevum testnet now. Each ✓ is a confirmed transaction."
                : mode === "done" && source === "live"
                  ? "Finished live on Aevum testnet. Click any tx to verify it."
                  : mode === "replay" || mode === "done"
                    ? "Replaying a recorded testnet run. Every tx link is real."
                    : "One click runs the whole story on Aevum testnet (~20 s)."}
          </span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn line small" onClick={playReplay} disabled={isLive}>
              Replay
            </button>
            <button type="button" className="btn small" onClick={runLive} disabled={isLive || enabled === false}>
              {isLive ? "Running…" : "Run live on Aevum"} <span className="arrow">→</span>
            </button>
          </div>
        </div>
      </div>

      <div className="card card-glow side-stats">
        <div className="stat">
          <span className="k">Spent today / daily cap</span>
          <span className="big">
            {fmtUnits(spent)}
            <small>/ 0.10 tUSD8</small>
          </span>
        </div>
        <div className="meter">
          <div className={`progress ${pct >= 100 ? "full" : pct >= 80 ? "high" : ""}`}>
            <span style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
        </div>
        <div className="line">
          <div className="stat">
            <span className="k">Refused by chain</span>
            <span className="big bad">{blocked}</span>
          </div>
          <div className="stat" style={{ alignItems: "flex-end" }}>
            <span className="k">Attacker received</span>
            <span className="big">
              0<small>tUSD8</small>
            </span>
          </div>
        </div>
        <ul className="checklist">
          {CHECKS.map((c) => {
            const ok = c.when(events);
            return (
              <li key={c.id} className={ok ? "done" : ""}>
                {c.label}
              </li>
            );
          })}
        </ul>
        {done?.sessionId && (
          <p className="fine">
            Session <span className="mono">{shortHex(done.sessionId, 10, 6)}</span> · revoked · funds never left the leash
          </p>
        )}
      </div>
    </div>
  );
}
