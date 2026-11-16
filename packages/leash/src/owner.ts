import { encodeFunctionData, getAbiItem, parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { getLogsChunked } from "@aevum-kit/aevum";
import { spendLeashAbi } from "./abi";

export interface OwnerOptions { publicClient: PublicClient; walletClient: WalletClient; leash: Address; }
export interface SessionLimits { perPaymentCap: bigint; dailyCap: bigint; totalCap: bigint; validUntil: number; }
async function write(options: OwnerOptions, data: Hex) {
  const { publicClient, walletClient, leash } = options;
  if (!walletClient.account) throw new Error("An owner account is required");
  const request = { to: leash, account: walletClient.account, data, type: "legacy" } as const;
  await publicClient.call(request);
  const hash = await walletClient.sendTransaction({ ...request, chain: walletClient.chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`SpendLeash transaction reverted: ${receipt.transactionHash}`);
  return receipt;
}

/** Approve the token allowance first, or use depositWithPermit instead. */
export const deposit = (options: OwnerOptions, amount: bigint) => write(options, encodeFunctionData({ abi: spendLeashAbi, functionName: "deposit", args: [amount] }));
export const depositWithPermit = (options: OwnerOptions, amount: bigint, permit: { deadline: bigint; v: number; r: Hex; s: Hex }) =>
  write(options, encodeFunctionData({ abi: spendLeashAbi, functionName: "depositWithPermit", args: [amount, permit.deadline, permit.v, permit.r, permit.s] }));
export async function openSession(options: OwnerOptions, agent: Address, limits: SessionLimits, merchants: Address[]) {
  const receipt = await write(options, encodeFunctionData({ abi: spendLeashAbi, functionName: "openSession", args: [agent, limits, merchants] }));
  const logs = parseEventLogs({ abi: spendLeashAbi, eventName: "SessionOpened", logs: receipt.logs.filter((log) => log.address.toLowerCase() === options.leash.toLowerCase()) });
  const sessionId = logs[0]?.args.sessionId;
  if (!sessionId) throw new Error("SessionOpened was missing from the successful receipt");
  return { sessionId, receipt };
}
export const revoke = (options: OwnerOptions, sessionId: Hex) => write(options, encodeFunctionData({ abi: spendLeashAbi, functionName: "revoke", args: [sessionId] }));
export const setMerchants = (options: OwnerOptions, sessionId: Hex, merchants: Address[], allowed: boolean) =>
  write(options, encodeFunctionData({ abi: spendLeashAbi, functionName: "setMerchants", args: [sessionId, merchants, allowed] }));
export const getSession = (client: PublicClient, leash: Address, sessionId: Hex) =>
  client.readContract({ address: leash, abi: spendLeashAbi, functionName: "getSession", args: [sessionId] });
export const remaining = (client: PublicClient, leash: Address, sessionId: Hex) =>
  client.readContract({ address: leash, abi: spendLeashAbi, functionName: "remaining", args: [sessionId] });

/** Both payment and kill-switch history, using Aevum-safe <=1,000-block log requests. */
export async function readPayments(client: PublicClient, leash: Address, fromBlock: bigint, toBlock?: bigint) {
  const end = toBlock ?? await client.getBlockNumber();
  const paid = await getLogsChunked(client, { address: leash, event: getAbiItem({ abi: spendLeashAbi, name: "Paid" }), fromBlock, toBlock: end });
  const revoked = await getLogsChunked(client, { address: leash, event: getAbiItem({ abi: spendLeashAbi, name: "SessionRevoked" }), fromBlock, toBlock: end });
  return [...paid, ...revoked].sort((a, b) => a.blockNumber! < b.blockNumber! ? -1 : a.blockNumber! > b.blockNumber! ? 1 : (a.logIndex ?? 0) - (b.logIndex ?? 0));
}
