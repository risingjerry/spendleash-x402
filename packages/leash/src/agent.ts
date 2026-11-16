import type { Address, Hex, LocalAccount, PublicClient } from "viem";
import { spendLeashAbi } from "./abi";
import { decodeLeashError, type LeashErrorInfo } from "./errors";
import { newNonce, refFor, signIntent } from "./intent";
import {
  decodePaymentResponse, encodePayment, isLeashAccept, leashNetwork,
  PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER, X402_VERSION, ZERO_SELECTOR, type PaymentResponse,
} from "./x402";

export class LeashPaymentRefused extends Error {
  readonly code: string;
  constructor(readonly reason: LeashErrorInfo) {
    super(reason.message);
    this.name = "LeashPaymentRefused";
    this.code = reason.code;
  }
}
export interface PaymentInfo extends PaymentResponse { amount: bigint; }
export interface LeashResponse extends Response { payment?: PaymentInfo; }
export interface LeashFetchOptions {
  account: LocalAccount;
  sessionId: Hex;
  chainId: number;
  leash: Address;
  policy: { maxPerRequest: bigint; allowPayTo?: Address[] };
  publicClient?: PublicClient;
  fetch?: typeof globalThis.fetch;
  onPayment?: (payment: PaymentInfo) => void | Promise<void>;
}
export type LeashFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<LeashResponse>;

/** One 402 challenge, at most one signed retry. No automatic retry after uncertain settlement. */
export function createLeashFetch(options: LeashFetchOptions): LeashFetch {
  const { account, sessionId, chainId, leash, policy, publicClient, onPayment } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  const network = leashNetwork(chainId);
  if (policy.maxPerRequest <= 0n) throw new Error("maxPerRequest must be positive");
  const refuse = (code: string, message: string): never => { throw new LeashPaymentRefused({ code, message, retryable: false }); };
  return async (input, init) => {
    // Keep an untouched request to replay bodies, headers, credentials and signals on the retry.
    const request = new Request(input, init);
    if (!request.headers.has("X-Request-Id")) request.headers.set("X-Request-Id", newNonce());
    const first = await fetcher(request.clone());
    if (first.status !== 402 || request.headers.has(PAYMENT_HEADER)) return first;
    let challenge: { x402Version?: unknown; accepts?: unknown };
    try { challenge = await first.clone().json(); } catch { return first; }
    if (!challenge || challenge.x402Version !== X402_VERSION || !Array.isArray(challenge.accepts)) return first;
    const accept = challenge.accepts.find((a) => isLeashAccept(a) && a.extra.chainId === chainId && a.extra.leash.toLowerCase() === leash.toLowerCase() && a.network === network);
    if (!isLeashAccept(accept)) return first;
    // Never sign a challenge obtained by following a redirect to another URL.
    if (accept.resource !== request.url || (first.url && first.url !== request.url)) refuse("ResourceMismatch", "The payment quote does not match the requested resource.");
    const amount = BigInt(accept.maxAmountRequired);
    if (amount > policy.maxPerRequest) refuse("LocalPerRequestCapExceeded", "The resource price exceeds the agent's local per-request limit.");
    if (policy.allowPayTo && !policy.allowPayTo.some((address) => address.toLowerCase() === accept.payTo.toLowerCase())) refuse("LocalMerchantNotAllowed", "This merchant is not on the agent's local allowlist.");
    let now = BigInt(Math.floor(Date.now() / 1000));
    if (publicClient) {
      if (await publicClient.getChainId() !== chainId) refuse("ChainMismatch", "The preflight client is connected to a different chain.");
      const token = await publicClient.readContract({ address: leash, abi: spendLeashAbi, functionName: "token" });
      if (token.toLowerCase() !== accept.asset.toLowerCase()) refuse("AssetMismatch", "The quoted token is not the SpendLeash deposit token.");
      now = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
    }
    const intent = { sessionId, merchant: accept.payTo, amount, ref: refFor(request.method, request.url, request.headers.get("X-Request-Id")!), nonce: newNonce(), deadline: now + BigInt(Math.max(1, Math.floor(Math.min(accept.maxTimeoutSeconds, 300) * 0.8))) };
    const signature = await signIntent(account, chainId, leash, intent);
    if (publicClient) {
      const selector = await publicClient.readContract({ address: leash, abi: spendLeashAbi, functionName: "check", args: [intent, signature] });
      if (selector !== ZERO_SELECTOR) throw new LeashPaymentRefused(decodeLeashError(selector) ?? { code: "PaymentBlocked", message: "The contract blocked this payment.", retryable: false });
    }
    const headers = new Headers(request.headers);
    headers.set(PAYMENT_HEADER, encodePayment({ x402Version: X402_VERSION, scheme: "leash", network, payload: { intent, signature } }));
    // Prevent signed headers being forwarded through a redirect during the paid retry.
    const response: LeashResponse = await fetcher(new Request(request, { headers, redirect: "error" }));
    const receiptHeader = response.headers.get(PAYMENT_RESPONSE_HEADER);
    if (receiptHeader) {
      const receipt = decodePaymentResponse(receiptHeader);
      if (receipt.success && receipt.network === network && receipt.payer.toLowerCase() === sessionId.toLowerCase()) {
        response.payment = { ...receipt, amount };
        // Delivery (or a callback) can fail after payment. Do not discard the receipt or repay.
        try { await onPayment?.(response.payment); }
        catch { console.error("SpendLeash: onPayment callback failed; payment receipt remains on the response"); }
      }
    }
    return response;
  };
}
