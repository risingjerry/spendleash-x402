"use client";

import { getLogsChunked } from "@aevum-kit/aevum";
import { spendLeashAbi } from "@spendleash/sdk";
import { useQuery } from "@tanstack/react-query";
import { getAbiItem, type Address, type Hash, type Hex, type PublicClient } from "viem";
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

/**
 * Everything the owner console shows: the owner's sessions (from SessionOpened logs + live state),
 * and every Paid event for them. Polls over HTTPS (Aevum has no WebSocket RPC).
 */
export function useOwnerLeash() {
  const { net } = useNetwork();
  const { address } = useAccount();
  const client = usePublicClient({ chainId: net.chain.id }) as PublicClient | undefined;
  const leash = net.leash;

  const query = useQuery({
    queryKey: ["leash-owner", net.chain.id, leash, address],
    enabled: Boolean(client && leash && address),
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const from = net.leashDeployBlock ?? (head > 20_000n ? head - 20_000n : 0n);
      const opened = await getLogsChunked(client!, {
        address: leash!,
        event: getAbiItem({ abi: spendLeashAbi, name: "SessionOpened" }),
        args: { owner: address },
        fromBlock: from,
        toBlock: head,
      });
      const ids = opened.map((l) => l.args.sessionId as Hex);
      const states = ids.length
        ? await client!.multicall({
            contracts: ids.map((id) => ({ address: leash!, abi: spendLeashAbi, functionName: "getSession", args: [id] }) as const),
            allowFailure: false,
          })
        : [];
      const paid = ids.length
        ? await getLogsChunked(client!, {
            address: leash!,
            event: getAbiItem({ abi: spendLeashAbi, name: "Paid" }),
            fromBlock: from,
            toBlock: head,
          })
        : [];
      const mine = new Set(ids);
      const payments: PaymentView[] = paid
        .filter((l) => mine.has(l.args.sessionId as Hex))
        .map((l) => ({
          sessionId: l.args.sessionId as Hex,
          merchant: l.args.merchant as Address,
          agent: l.args.agent as Address,
          amount: l.args.amount as bigint,
          ref: l.args.ref as Hex,
          block: l.blockNumber!,
          tx: l.transactionHash!,
        }))
        .reverse();

      // Block timestamps for the feed and for the daily-cap display.
      const blocks = [...new Set(payments.map((p) => p.block))].slice(0, 60);
      const times = new Map<bigint, number>();
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
