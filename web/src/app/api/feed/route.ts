import { NextResponse } from "next/server";
import { createPublicClient, decodeEventLog, http, type Address, type Hash, type Hex } from "viem";
import { aevumTestnet } from "@aevum-kit/aevum";
import { spendLeashAbi } from "@spendleash/sdk";
import { networkByChainId } from "@/lib/env";

/**
 * Public, read-only feed of everything SpendLeash did on Aevum testnet: leashes opened, payments, revokes.
 * Reads the explorer's indexed logs (Blockscout API) so it doesn't have to scan millions of blocks over RPC,
 * decodes them with the contract ABI, and caches for a few seconds.
 */
export const runtime = "nodejs";

const EXPLORER_API = "https://explorer-test.qday.info/api/v2";
const MAX_PAGES = 6;
const CACHE_MS = 8_000;

export type FeedEvent =
  | { type: "opened"; tx: Hash; block: number; time?: number; sessionId: Hex; owner: Address; agent: Address; perPaymentCap: string; dailyCap: string; totalCap: string; merchants: number }
  | { type: "paid"; tx: Hash; block: number; time?: number; sessionId: Hex; agent: Address; merchant: Address; amount: string }
  | { type: "revoked"; tx: Hash; block: number; time?: number; sessionId: Hex }
  | { type: "deposit"; tx: Hash; block: number; time?: number; owner: Address; amount: string };

export interface Feed {
  leash: Address;
  head: number;
  stats: { payments: number; volume: string; leashes: number; revoked: number; agents: number };
  events: FeedEvent[];
  updatedAt: number;
}

let cache: { at: number; data: Feed } | null = null;
let inflight: Promise<Feed> | null = null;

const client = createPublicClient({ chain: aevumTestnet, transport: http() });

interface ExplorerLog {
  topics: (Hex | null)[];
  data: Hex;
  block_number: number;
  transaction_hash: Hash;
  index: number;
}

async function load(leash: Address): Promise<Feed> {
  const logs: ExplorerLog[] = [];
  let params = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(`${EXPLORER_API}/addresses/${leash}/logs${params}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`explorer ${res.status}`);
    const body = (await res.json()) as { items: ExplorerLog[]; next_page_params: Record<string, string | number> | null };
    logs.push(...body.items);
    if (!body.next_page_params) break;
    params = `?${new URLSearchParams(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)]))}`;
  }

  const events: FeedEvent[] = [];
  for (const log of logs) {
    const topics = log.topics.filter((t): t is Hex => Boolean(t));
    if (!topics.length) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: spendLeashAbi, topics: topics as [Hex, ...Hex[]], data: log.data });
    } catch {
      continue;
    }
    const base = { tx: log.transaction_hash, block: log.block_number };
    const a = decoded.args as Record<string, unknown>;
    switch (decoded.eventName) {
      case "SessionOpened": {
        const limits = a.limits as { perPaymentCap: bigint; dailyCap: bigint; totalCap: bigint };
        events.push({
          type: "opened", ...base, sessionId: a.sessionId as Hex, owner: a.owner as Address, agent: a.agent as Address,
          perPaymentCap: limits.perPaymentCap.toString(), dailyCap: limits.dailyCap.toString(), totalCap: limits.totalCap.toString(),
          merchants: (a.merchants as unknown[]).length,
        });
        break;
      }
      case "Paid":
        events.push({ type: "paid", ...base, sessionId: a.sessionId as Hex, agent: a.agent as Address, merchant: a.merchant as Address, amount: (a.amount as bigint).toString() });
        break;
      case "SessionRevoked":
        events.push({ type: "revoked", ...base, sessionId: a.sessionId as Hex });
        break;
      case "Deposited":
        events.push({ type: "deposit", ...base, owner: a.owner as Address, amount: (a.amount as bigint).toString() });
        break;
    }
  }
  events.sort((x, y) => y.block - x.block);

  // Timestamps for the newest events only (one RPC call per distinct block).
  const recent = [...new Set(events.slice(0, 40).map((e) => e.block))];
  const times = new Map<number, number>();
  await Promise.all(
    recent.map(async (b) => {
      try {
        const blk = await client.getBlock({ blockNumber: BigInt(b) });
        times.set(b, Number(blk.timestamp));
      } catch {
        // A missing timestamp only hides "x min ago".
      }
    }),
  );
  for (const e of events) e.time = times.get(e.block);

  const paid = events.filter((e): e is Extract<FeedEvent, { type: "paid" }> => e.type === "paid");
  const head = Number(await client.getBlockNumber());
  return {
    leash,
    head,
    stats: {
      payments: paid.length,
      volume: paid.reduce((s, e) => s + BigInt(e.amount), 0n).toString(),
      leashes: events.filter((e) => e.type === "opened").length,
      revoked: events.filter((e) => e.type === "revoked").length,
      agents: new Set(events.flatMap((e) => (e.type === "opened" ? [e.agent.toLowerCase()] : []))).size,
    },
    events: events.slice(0, 60),
    updatedAt: Date.now(),
  };
}

export async function GET() {
  const leash = networkByChainId(aevumTestnet.id)?.leash;
  if (!leash) return NextResponse.json({ error: "NEXT_PUBLIC_LEASH_AEVUM is not set" }, { status: 503 });
  if (cache && Date.now() - cache.at < CACHE_MS) return NextResponse.json(cache.data);
  try {
    inflight ??= load(leash).finally(() => (inflight = null));
    const data = await inflight;
    cache = { at: Date.now(), data };
    return NextResponse.json(data, { headers: { "Cache-Control": "s-maxage=8, stale-while-revalidate=30" } });
  } catch (e) {
    console.error("[feed]", e);
    if (cache) return NextResponse.json(cache.data);
    return NextResponse.json({ error: "Couldn't read the explorer right now." }, { status: 502 });
  }
}
