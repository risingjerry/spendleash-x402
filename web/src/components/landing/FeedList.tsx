"use client";

import { addressUrl, txUrl } from "@aevum-kit/aevum";
import { useRef } from "react";
import { ago, fmtUnits, shortHex, useFeed } from "./useFeed";

const LABEL = { paid: "Paid", opened: "Leash", revoked: "Revoked", deposit: "Deposit" } as const;

/** Every SpendLeash event on Aevum testnet, newest first. No wallet needed. */
export function FeedList() {
  const { data, error, isLoading } = useFeed();
  const seen = useRef<Set<string> | null>(null);
  const events = data?.events ?? [];
  const firstLoad = seen.current === null;
  const fresh = new Set(firstLoad ? [] : events.map((e) => e.tx + e.type).filter((k) => !seen.current!.has(k)));
  if (data) seen.current = new Set(events.map((e) => e.tx + e.type));

  return (
    <div className="feed">
      <div className="feed-row head">
        <span>Event</span>
        <span>When</span>
        <span>Detail</span>
        <span style={{ textAlign: "right" }}>Amount</span>
        <span>Tx</span>
      </div>
      {isLoading && <div className="empty">Reading Aevum…</div>}
      {error && !data && <div className="empty">The explorer isn&apos;t answering right now. The contract is still there: try again in a moment.</div>}
      {data && events.length === 0 && <div className="empty">No activity yet.</div>}
      {events.slice(0, 14).map((e) => (
        <div className={`feed-row${fresh.has(e.tx + e.type) ? " fresh" : ""}`} key={e.tx + e.type + e.block}>
          <span className={`evt ${e.type}`}>{LABEL[e.type]}</span>
          <span className="when">{ago(e.time) || `#${e.block}`}</span>
          <span className="what">
            {e.type === "paid" && (
              <>
                agent <a href={addressUrl(e.agent)} target="_blank" rel="noreferrer">{shortHex(e.agent)}</a> → merchant {shortHex(e.merchant)}
              </>
            )}
            {e.type === "opened" && (
              <>
                agent {shortHex(e.agent)} · {fmtUnits(e.perPaymentCap)}/call · {fmtUnits(e.dailyCap)}/day · {e.merchants} merchant{e.merchants === 1 ? "" : "s"}
              </>
            )}
            {e.type === "revoked" && <>session {shortHex(e.sessionId, 10, 6)} killed by owner</>}
            {e.type === "deposit" && <>owner {shortHex(e.owner)} funded the agent budget</>}
          </span>
          <span className="amt num">{e.type === "paid" || e.type === "deposit" ? `${fmtUnits(e.amount)} tUSD8` : "—"}</span>
          <span className="tx mono">
            <a href={txUrl(e.tx)} target="_blank" rel="noreferrer">
              {shortHex(e.tx)} ↗
            </a>
          </span>
        </div>
      ))}
    </div>
  );
}
