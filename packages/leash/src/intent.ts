import { bytesToHex, keccak256, stringToHex, type Address, type Hex, type LocalAccount } from "viem";

export interface PaymentIntent {
  sessionId: Hex;
  merchant: Address;
  amount: bigint;
  ref: Hex;
  nonce: Hex;
  deadline: bigint;
}

export function leashDomain(chainId: number, leash: Address) {
  return { name: "SpendLeash", version: "1", chainId, verifyingContract: leash } as const;
}

export const paymentIntentTypes = {
  PaymentIntent: [
    { name: "sessionId", type: "bytes32" },
    { name: "merchant", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "ref", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function intentTypedData(chainId: number, leash: Address, intent: PaymentIntent) {
  return { domain: leashDomain(chainId, leash), types: paymentIntentTypes, primaryType: "PaymentIntent", message: intent } as const;
}

export function signIntent(account: LocalAccount, chainId: number, leash: Address, intent: PaymentIntent) {
  return account.signTypedData(intentTypedData(chainId, leash, intent));
}

export function newNonce(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Unambiguous tuple encoding; use the exact absolute Request URL (including query). */
export function refFor(method: string, url: string, requestId: string): Hex {
  return keccak256(stringToHex(JSON.stringify([method.toUpperCase(), url, requestId])));
}
