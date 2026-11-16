import { isAddress, isHex, size, type Address, type Hex } from "viem";
import type { PaymentIntent } from "./intent";
import type { LeashErrorInfo } from "./errors";

export const X402_VERSION = 1 as const;
export const LEASH_SCHEME = "leash" as const;
export const PAYMENT_HEADER = "X-PAYMENT";
export const PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";
export const ZERO_SELECTOR = "0x00000000";
export const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export function leashNetwork(chainId: number): string {
  if (chainId === 44005) return "qday-aevum-testnet";
  if (chainId === 440050) return "qday-aevum-fork";
  if (chainId === 31337) return "qday-aevum-local";
  throw new Error(`Unsupported SpendLeash chain: ${chainId}`);
}

export interface LeashAccept {
  scheme: typeof LEASH_SCHEME;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  asset: Address;
  maxTimeoutSeconds: number;
  extra: { leash: Address; chainId: number };
}
export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error: LeashErrorInfo;
  accepts: LeashAccept[];
}
export interface LeashPayment {
  x402Version: typeof X402_VERSION;
  scheme: typeof LEASH_SCHEME;
  network: string;
  payload: { intent: PaymentIntent; signature: Hex };
}
export interface PaymentResponse {
  success: boolean;
  transaction: Hex;
  network: string;
  /** SpendLeash's payer identifier is a sessionId, not an EOA. */
  payer: Hex;
}

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v));
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}
function decode(value: string): unknown {
  if (value.length > 16_384) throw new Error("Payment header is too large");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))));
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid payment object");
  return value as Record<string, unknown>;
}
function hex(value: unknown, bytes?: number): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || value.length % 2 !== 0 || (bytes !== undefined && size(value) !== bytes)) {
    throw new Error("Invalid payment hex data");
  }
  return value;
}
function uint(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error("Payment integers must be decimal strings");
  const result = BigInt(value);
  if (result >= 2n ** 256n) throw new Error("Payment integer exceeds uint256");
  return result;
}

export const encodePayment = (payment: LeashPayment): string => encode(payment);
export function decodePayment(header: string): LeashPayment {
  const payment = record(decode(header));
  if (payment.x402Version !== X402_VERSION || payment.scheme !== LEASH_SCHEME || typeof payment.network !== "string") throw new Error("Unsupported payment protocol");
  const payload = record(payment.payload);
  const intent = record(payload.intent);
  if (typeof intent.merchant !== "string" || !isAddress(intent.merchant)) throw new Error("Invalid merchant address");
  return {
    x402Version: X402_VERSION, scheme: LEASH_SCHEME, network: payment.network,
    payload: {
      signature: hex(payload.signature),
      intent: {
        sessionId: hex(intent.sessionId, 32), merchant: intent.merchant,
        amount: uint(intent.amount), ref: hex(intent.ref, 32), nonce: hex(intent.nonce, 32), deadline: uint(intent.deadline),
      },
    },
  };
}
export const encodePaymentResponse = (response: PaymentResponse): string => encode(response);
export function decodePaymentResponse(header: string): PaymentResponse {
  const response = record(decode(header));
  if (typeof response.success !== "boolean" || typeof response.network !== "string") throw new Error("Invalid payment response");
  return { success: response.success, transaction: hex(response.transaction, 32), network: response.network, payer: hex(response.payer, 32) };
}

/** Runtime guard: never sign untrusted quote data based on TypeScript assertions alone. */
export function isLeashAccept(value: unknown): value is LeashAccept {
  try {
    const a = record(value);
    const extra = record(a.extra);
    return a.scheme === LEASH_SCHEME && typeof a.network === "string" &&
      typeof a.resource === "string" && typeof a.description === "string" && typeof a.mimeType === "string" &&
      typeof a.payTo === "string" && isAddress(a.payTo) && typeof a.asset === "string" && isAddress(a.asset) &&
      typeof extra.leash === "string" && isAddress(extra.leash) && Number.isSafeInteger(extra.chainId) &&
      Number.isSafeInteger(a.maxTimeoutSeconds) && Number(a.maxTimeoutSeconds) > 0 && uint(a.maxAmountRequired) > 0n;
  } catch { return false; }
}
