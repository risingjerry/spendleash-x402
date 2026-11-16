import type { IncomingMessage, ServerResponse } from "node:http";
import type { Address, PublicClient, WalletClient } from "viem";
import { spendLeashAbi } from "./abi";
import { decodeLeashError, type LeashErrorInfo } from "./errors";
import { refFor } from "./intent";
import {
  decodePayment, encodePaymentResponse, leashNetwork, PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER,
  X402_VERSION, ZERO_BYTES32, ZERO_SELECTOR, type PaymentRequired,
} from "./x402";

export interface PaywallOptions {
  publicClient: PublicClient;
  walletClient: WalletClient;
  leash: Address;
  payTo: Address;
  price: bigint;
  description: string;
  maxTimeoutSeconds?: number;
}
export type ResourceHandler = (req: Request) => Promise<Response>;
export type Paywall = (req: Request, handler: ResourceHandler) => Promise<Response>;

export function createPaywall(options: PaywallOptions): Paywall {
  const { publicClient, walletClient, leash, payTo, price, description, maxTimeoutSeconds = 300 } = options;
  if (price <= 0n || !Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) throw new Error("Invalid paywall price or timeout");
  if (!walletClient.account) throw new Error("The paywall requires a relayer account");
  // This only guards concurrent submissions in this process. Multiple instances need shared
  // storage/locking. On-chain nonces are the final replay defense; this is not durable delivery.
  const pending = new Set<string>();

  return async (req, handler) => {
    const chainId = await publicClient.getChainId();
    const network = leashNetwork(chainId);
    const asset = await publicClient.readContract({ address: leash, abi: spendLeashAbi, functionName: "token" });
    const required = (error: LeashErrorInfo): Response => Response.json({
      x402Version: X402_VERSION, error,
      accepts: [{ scheme: "leash", network, maxAmountRequired: price.toString(), resource: req.url,
        description, mimeType: "application/json", payTo, asset, maxTimeoutSeconds, extra: { leash, chainId } }],
    } satisfies PaymentRequired, { status: 402 });
    const invalid = (message: string) => required({ code: "InvalidPayment", message, retryable: false });
    const header = req.headers.get(PAYMENT_HEADER);
    if (!header) return required({ code: "PaymentRequired", message: "Payment is required to access this resource.", retryable: true });

    let payment;
    try { payment = decodePayment(header); }
    catch { return invalid("The payment header is malformed or unsupported."); }
    if (payment.network !== network) return invalid("The payment is for a different network.");
    const { intent, signature } = payment.payload;
    if (intent.merchant.toLowerCase() !== payTo.toLowerCase()) return invalid("The payment is for a different merchant.");
    if (intent.amount < price) return invalid("The payment does not cover the resource price.");
    const requestId = req.headers.get("X-Request-Id");
    if (requestId !== null ? intent.ref !== refFor(req.method, req.url, requestId) : intent.ref === ZERO_BYTES32) {
      return invalid("The payment does not identify this request.");
    }
    const now = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
    if (intent.deadline < now || intent.deadline > now + BigInt(maxTimeoutSeconds)) return invalid("The payment approval has expired or its validity window is too long.");
    const key = `${intent.sessionId}:${intent.nonce}`.toLowerCase();
    if (pending.has(key)) return required({ code: "PaymentInProgress", message: "This payment is already being submitted. Do not submit it again.", retryable: false });
    pending.add(key);
    try {
      let transaction;
      try {
        const selector = await publicClient.readContract({ address: leash, abi: spendLeashAbi, functionName: "check", args: [intent, signature] });
        if (selector !== ZERO_SELECTOR) return required(decodeLeashError(selector) ?? { code: "PaymentBlocked", message: "The contract blocked this payment.", retryable: false });
        const call = { account: walletClient.account!, address: leash, abi: spendLeashAbi, functionName: "pay", args: [intent, signature], type: "legacy" } as const;
        await publicClient.simulateContract(call);
        const hash = await walletClient.writeContract({ ...call, chain: walletClient.chain });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") return required({ code: "SettlementReverted", message: "The on-chain payment failed. No resource was delivered.", retryable: false });
        transaction = receipt.transactionHash;
      } catch (error) {
        const decoded = decodeLeashError(error);
        if (decoded) return required(decoded);
        // A timeout after broadcast is NOT evidence of failure. Never ask the agent to repay.
        return Response.json({ error: { code: "SettlementUnknown", message: "Payment status is unknown. Check the chain before making another payment.", retryable: false } }, { status: 503 });
      }
      let response;
      try { response = await handler(req); }
      catch {
        // Known x402 trade-off: payment settles before delivery. A handler failure does not undo
        // the payment. Production merchants need durable receipts and a delivery/refund policy.
        console.error("SpendLeash: resource handler failed after payment settled", transaction);
        response = Response.json({ error: { code: "DeliveryFailed", message: "Payment settled, but delivery failed. Contact the merchant with the payment receipt." } }, { status: 500 });
      }
      // Clone headers: fetch-produced Responses can have immutable header guards.
      const headers = new Headers(response.headers);
      headers.set(PAYMENT_RESPONSE_HEADER, encodePaymentResponse({ success: true, transaction, network, payer: intent.sessionId }));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } finally { pending.delete(key); }
  };
}

/** node:http adapter. Host must represent the externally signed URL; configure proxies accordingly. */
export function toNodeHandler(paywall: Paywall, handler: ResourceHandler) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
        else if (value !== undefined) headers.set(name, value);
      }
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const chunks: Uint8Array[] = [];
      if (method !== "GET" && method !== "HEAD") for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
      const response = await paywall(new Request(url, { method, headers, body }), handler);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      // Stream delivery; do not buffer potentially large resource responses in memory.
      if (method !== "HEAD" && response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (!res.write(chunk)) await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } catch {
      console.error("SpendLeash: node HTTP request failed");
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request failed. Check any payment receipt before retrying." }));
    }
  };
}
