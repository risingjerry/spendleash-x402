"use client";

import { getLogsChunked } from "@aevum-kit/aevum";
import { spendLeashAbi } from "@spendleash/sdk";
import { useQuery } from "@tanstack/react-query";
import { decodeEventLog, getAbiItem, type AbiEvent, pad, toEventSelector, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { useNetwork } from "./network";

export { spendLeashAbi };

export interface SessionView {
  id: Hex;
  agent: Address;
  owner: Address;
  perPaymentCap: bigint;
  dailyCap: bigint;
  totalCap: bigint;
  spentTotal: bigint;
  spentToday: bigint;
  validUntil: number;
  revoked: boolean;
  merchants: Address[];
  openedAt: bigint;
  openTx: Hash;
}

export interface PaymentView {
  sessionId: Hex;
  merchant: Address;
  agent: Address;
  amount: bigint;
  ref: Hex;
  block: bigint;
  tx: Hash;
}

export type SessionStatus = "active" | "revoked" | "expired";

export function statusOf(s: Pick<SessionView, "revoked" | "validUntil">, nowSec = Date.now() / 1000): SessionStatus {
  if (s.revoked) return "revoked";
  if (nowSec > s.validUntil) return "expired";
  return "active";
}

/** spentToday on chain only resets when the next payment lands; mirror the contract's day logic for display. */
export function spentTodayNow(s: SessionView, lastPaymentDay: number | undefined, nowSec = Date.now() / 1000): bigint {
  if (lastPaymentDay === undefined) return s.spentToday;
  return Math.floor(nowSec / 86400) === lastPaymentDay ? s.spentToday : 0n;
}

const POLL_MS = 5_000;
const EXPLORER_API = "https://explorer-test.qday.info/api";

interface ExplorerLog {
  topics: (Hex | null)[];
  data: Hex;
  blockNumber: string;
  timeStamp: string;
  transactionHash: Hash;
}

/**
 * Everything the owner console shows: the owner's sessions (from SessionOpened logs + live state),
 * and every Paid event for them. Polls over HTTPS (Aevum has no WebSocket RPC).
 */
export function useOwnerLeash(owner?: Address) {
  const { net } = useNetwork();
  const { address: connected } = useAccount();
  const address = owner ?? connected;
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const leash = net.leash;

  const query = useQuery({
    queryKey: ["leash-owner", net.chain.id, leash, address],
    enabled: Boolean(client && leash && address),
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const from = net.leashDeployBlock ?? (head > 20_000n ? head - 20_000n : 0n);
      const known = new Map<bigint, number>();

      /**
       * Aevum testnet: ask the explorer's indexed getLogs (filtered by topic, with timestamps) instead of
       * scanning every block over RPC; Aevum makes ~86k blocks a day. Local chains: chunked RPC scan.
       */
      async function logs(name: "SessionOpened" | "Paid", owner?: Address) {
        const event = getAbiItem({ abi: spendLeashAbi, name }) as AbiEvent;
        if (net.hasExplorer) {
          const topic0 = toEventSelector(event);
          const q = new URLSearchParams({ module: "logs", action: "getLogs", address: leash!, fromBlock: from.toString(), toBlock: "latest", topic0 });
          if (owner) {
            q.set("topic2", pad(owner.toLowerCase() as Hex));
            q.set("topic0_2_opr", "and");
          }
          const res = await fetch(`${EXPLORER_API}?${q}`);
          const body = (await res.json()) as { status: string; result: ExplorerLog[] | null };
          return (body.result ?? []).map((l) => {
            const block = BigInt(l.blockNumber);
            known.set(block, Number(l.timeStamp));
            const d = decodeEventLog({ abi: [event], topics: l.topics.filter(Boolean) as [Hex, ...Hex[]], data: l.data });
            return { args: d.args as Record<string, unknown>, blockNumber: block, transactionHash: l.transactionHash };
          });
        }
        const raw = await getLogsChunked(client!, { address: leash!, event, args: owner ? { owner } : undefined, fromBlock: from, toBlock: head });
        return raw.map((l) => ({ args: l.args as Record<string, unknown>, blockNumber: l.blockNumber!, transactionHash: l.transactionHash! }));
      }

      const opened = await logs("SessionOpened", address);
      const ids = opened.map((l) => l.args.sessionId as Hex);
      const states = ids.length
        ? await client!.multicall({
            contracts: ids.map((id) => ({ address: leash!, abi: spendLeashAbi, functionName: "getSession", args: [id] }) as const),
            allowFailure: false,
          })
        : [];
      const paid = ids.length ? await logs("Paid") : [];
      const mine = new Set(ids);
      const payments: PaymentView[] = paid
        .filter((l) => mine.has(l.args.sessionId as Hex))
        .map((l) => ({
          sessionId: l.args.sessionId as Hex,
          merchant: l.args.merchant as Address,
          agent: l.args.agent as Address,
          amount: l.args.amount as bigint,
          ref: l.args.ref as Hex,
          block: l.blockNumber,
          tx: l.transactionHash,
        }))
        .reverse();

      // Block timestamps for the feed and for the daily-cap display.
      const times = new Map<bigint, number>(known);
      const blocks = [...new Set(payments.map((p) => p.block))].filter((b) => !times.has(b)).slice(0, 60);
      await Promise.all(
        blocks.map(async (b) => {
          const blk = await client!.getBlock({ blockNumber: b });
          times.set(b, Number(blk.timestamp));
        }),
      );

      const sessions: SessionView[] = opened
        .map((l, i) => {
          const s = states[i] as unknown as {
            owner: Address;
            agent: Address;
            perPaymentCap: bigint;
            dailyCap: bigint;
            totalCap: bigint;
            spentTotal: bigint;
            spentToday: bigint;
            validUntil: number;
            revoked: boolean;
          };
          return {
            id: ids[i]!,
            agent: s.agent,
            owner: s.owner,
            perPaymentCap: s.perPaymentCap,
            dailyCap: s.dailyCap,
            totalCap: s.totalCap,
            spentTotal: s.spentTotal,
            spentToday: s.spentToday,
            validUntil: Number(s.validUntil),
            revoked: s.revoked,
            merchants: [...(l.args.merchants as readonly Address[])],
            openedAt: l.blockNumber!,
            openTx: l.transactionHash!,
          };
        })
        .reverse();

      const lastPaymentDay = new Map<Hex, number>();
      for (const p of payments) {
        const t = times.get(p.block);
        if (t !== undefined && !lastPaymentDay.has(p.sessionId)) lastPaymentDay.set(p.sessionId, Math.floor(t / 86400));
      }

      return { head, sessions, payments, times, lastPaymentDay };
    },
  });

  return { leash, net, address, client, ...query };
}
