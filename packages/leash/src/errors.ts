import { toFunctionSelector, type Hex } from "viem";
import { spendLeashAbi } from "./abi";

export interface LeashErrorInfo {
  code: string;
  message: string;
  /** Whether a new intent may work later, after fixing the stated condition. Never blindly resubmit. */
  retryable: boolean;
}

const messages = {
  ZeroAddress: ["A required address is empty. Use a valid wallet or contract address.", false],
  ZeroAmount: ["The payment amount must be greater than zero.", false],
  NotOwner: ["Only the session owner can make this change.", false],
  UnknownSession: ["This spending session does not exist. Ask the owner to open one.", false],
  SessionIsRevoked: ["The owner revoked this spending session. No more payments are allowed.", false],
  SessionExpired: ["This spending session has expired. Ask the owner to open a new one.", false],
  IntentExpired: ["This payment approval has expired. Request a fresh payment approval.", true],
  NonceAlreadyUsed: ["This payment approval has already been used. It cannot be paid again.", false],
  MerchantNotAllowed: ["This merchant is not on the owner's allowlist. The payment was blocked on-chain.", false],
  PerPaymentCapExceeded: ["This payment exceeds the owner's per-payment spending limit.", false],
  DailyCapExceeded: ["The session's daily spending limit has been reached. Try again on the next UTC day.", true],
  TotalCapExceeded: ["The session's total spending limit has been reached. Ask the owner for a new session.", false],
  InsufficientDeposit: ["The owner's deposited balance is too low. Ask the owner to deposit more funds.", true],
  BadSignature: ["The payment signature is invalid. Use the correct session key and network.", false],
  BadLimits: ["The spending limits or expiry are invalid. Check the session settings.", false],
  InvalidShortString: ["The contract received invalid text data.", false],
  StringTooLong: ["The supplied text is too long for this contract.", false],
  ReentrancyGuardReentrantCall: ["A nested payment was blocked. Submit payments separately.", false],
  SafeERC20FailedOperation: ["The token transfer failed. Check the token balance and deposit allowance.", true],
} satisfies Record<string, readonly [string, boolean]>;

export const leashErrors: Readonly<Record<Hex, LeashErrorInfo>> = Object.fromEntries(
  spendLeashAbi.filter((item) => item.type === "error").map((item) => {
    const [message, retryable] = messages[item.name];
    return [toFunctionSelector(`${item.name}(${item.inputs.map((input) => input.type).join(",")})`), { code: item.name, message, retryable }];
  }),
);

/** Accepts selectors, encoded revert data, or viem's nested error/cause/data objects. */
export function decodeLeashError(selectorOrError: unknown): LeashErrorInfo | undefined {
  const seen = new Set<unknown>();
  function visit(value: unknown): LeashErrorInfo | undefined {
    if (typeof value === "string") return leashErrors[value.slice(0, 10).toLowerCase() as Hex];
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const error = value as Record<string, unknown>;
    if (typeof error.errorName === "string") {
      const match = Object.values(leashErrors).find((info) => info.code === error.errorName);
      if (match) return match;
    }
    return visit(error.data) ?? visit(error.cause) ?? visit(error.error);
  }
  return visit(selectorOrError);
}
