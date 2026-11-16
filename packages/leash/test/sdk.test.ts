import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeErrorResult, recoverTypedDataAddress, toFunctionSelector, type Address, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createLeashFetch, createPaywall, decodeLeashError, decodePayment, decodePaymentResponse,
  encodePayment, encodePaymentResponse, intentTypedData, leashErrors, leashNetwork,
  LeashPaymentRefused, newNonce, PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER, refFor, signIntent,
  spendLeashAbi, ZERO_BYTES32, type LeashPayment, type PaymentIntent,
} from "../src/index";

// Public, deterministic fixture key: never funded or used outside tests.
const account = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
const leash: Address = "0x1111111111111111111111111111111111111111";
const merchant: Address = "0x2222222222222222222222222222222222222222";
const chainId = 440050;
const now = BigInt(Math.floor(Date.now() / 1000));
const intent: PaymentIntent = { sessionId: newNonce(), merchant, amount: 50_000n, ref: refFor("GET", "http://merchant/quote", "id"), nonce: newNonce(), deadline: now + 60n };
const tx = newNonce();
const signature = await signIntent(account, chainId, leash, intent);
const payment: LeashPayment = { x402Version: 1, scheme: "leash", network: leashNetwork(chainId), payload: { intent, signature } };
const selector = (code: string) => Object.entries(leashErrors).find(([, error]) => error.code === code)![0];

function fixture(overrides: Record<string, unknown> = {}) {
  let submits = 0;
  let delivers = 0;
  const publicClient = {
    getChainId: async () => chainId,
    getBlock: async () => ({ timestamp: now }),
    readContract: async ({ functionName }: { functionName: string }) => functionName === "token" ? merchant : "0x00000000",
    simulateContract: async () => ({}),
    waitForTransactionReceipt: async () => ({ status: "success", transactionHash: tx }),
    ...overrides,
  } as unknown as PublicClient;
  const walletClient = { account, chain: undefined, writeContract: async (call: { type: string }) => { assert.equal(call.type, "legacy"); submits++; return tx; } } as unknown as WalletClient;
  const paywall = createPaywall({ publicClient, walletClient, leash, payTo: merchant, price: 50_000n, description: "行情 quote" });
  const handler = async () => { delivers++; return Response.json({ symbol: "QDAY" }); };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => paywall(new Request(input, init), handler)) as typeof fetch;
  return { publicClient, paywall, handler, fetcher, submits: () => submits, delivers: () => delivers };
}

function paidRequest(patch: Partial<PaymentIntent> = {}, requestId?: string) {
  return new Request("http://merchant/quote", { headers: {
    [PAYMENT_HEADER]: encodePayment({ ...payment, payload: { signature, intent: { ...intent, ...patch } } }),
    ...(requestId === undefined ? {} : { "X-Request-Id": requestId }),
  } });
}

test("x402 payment and receipt round-trip, decimal strings on the wire", () => {
  assert.deepEqual(decodePayment(encodePayment(payment)), payment);
  assert.equal(JSON.parse(atob(encodePayment(payment))).payload.intent.amount, "50000");
  const receipt = { success: true, transaction: tx, network: leashNetwork(chainId), payer: intent.sessionId };
  assert.deepEqual(decodePaymentResponse(encodePaymentResponse(receipt)), receipt);
});

test("malformed/version/negative/overflow payment values fail closed", () => {
  for (const value of ["not-base64", btoa("{}"), "a".repeat(20_000)]) assert.throws(() => decodePayment(value));
  for (const amount of ["-1", "1.5", "01", (2n ** 256n).toString(), 50000]) {
    const raw = JSON.parse(atob(encodePayment(payment)));
    raw.payload.intent.amount = amount;
    assert.throws(() => decodePayment(btoa(JSON.stringify(raw))));
  }
  const raw = JSON.parse(atob(encodePayment(payment)));
  raw.x402Version = 2;
  assert.throws(() => decodePayment(btoa(JSON.stringify(raw))));
});

test("every ABI custom error, including inherited errors, has a plain-language mapping", () => {
  const errors = spendLeashAbi.filter((item) => item.type === "error");
  assert.equal(Object.keys(leashErrors).length, errors.length);
  for (const error of errors) {
    const info = decodeLeashError(toFunctionSelector(`${error.name}(${error.inputs.map((input) => input.type).join(",")})`));
    assert.equal(info?.code, error.name);
    assert.ok(info!.message.length > 20);
    assert.equal(typeof info!.retryable, "boolean");
    assert.equal(decodeLeashError({ cause: { data: { errorName: error.name } } })?.code, error.name);
  }
  assert.equal(decodeLeashError(encodeErrorResult({ abi: spendLeashAbi, errorName: "SafeERC20FailedOperation", args: [merchant] }))?.code, "SafeERC20FailedOperation");
  assert.equal(decodeLeashError("0x00000000"), undefined);
  const circular: { cause?: unknown } = {}; circular.cause = circular;
  assert.equal(decodeLeashError(circular), undefined);
});

test("EIP-712 signature recovers agent; ref and nonce are deterministic/random as intended", async () => {
  assert.equal(await recoverTypedDataAddress({ ...intentTypedData(chainId, leash, intent), signature }), account.address);
  assert.notEqual(await recoverTypedDataAddress({ ...intentTypedData(44005, leash, intent), signature }), account.address);
  assert.equal(refFor("get", "url", "id"), refFor("GET", "url", "id"));
  assert.notEqual(refFor("GET", "ab", "c"), refFor("GET", "a", "bc"));
  assert.match(newNonce(), /^0x[0-9a-f]{64}$/);
  assert.notEqual(newNonce(), newNonce());
});

test("agent/paywall integration retries once, binds request, delivers only after settlement and reports payment", async () => {
  const f = fixture();
  let callbacks = 0;
  const agentFetch = createLeashFetch({ account, sessionId: intent.sessionId, chainId, leash, policy: { maxPerRequest: 50_000n, allowPayTo: [merchant] }, fetch: f.fetcher,
    onPayment: (info) => { callbacks++; assert.equal(info.amount, 50_000n); } });
  const result = await agentFetch("http://merchant/quote");
  assert.equal(result.status, 200);
  assert.equal(result.payment?.transaction, tx);
  assert.equal(result.payment?.amount, 50_000n);
  assert.equal(callbacks, 1);
  assert.equal(f.submits(), 1);
  assert.equal(f.delivers(), 1);
});

test("local caps and allowlist refuse before sending a signed payment", async () => {
  const f = fixture();
  for (const policy of [{ maxPerRequest: 49_999n }, { maxPerRequest: 50_000n, allowPayTo: [] }]) {
    const agentFetch = createLeashFetch({ account, sessionId: intent.sessionId, chainId, leash, policy, fetch: f.fetcher });
    await assert.rejects(() => agentFetch("http://merchant/quote"), LeashPaymentRefused);
  }
  assert.equal(f.submits(), 0);
});

test("merchant blocks wrong destination/price/ref/deadline/network and malformed headers without gas", async () => {
  const f = fixture();
  for (const patch of [{ merchant: leash }, { amount: 1n }, { ref: ZERO_BYTES32 }, { deadline: now - 1n }, { deadline: now + 301n }]) {
    assert.equal((await f.paywall(paidRequest(patch), f.handler)).status, 402);
  }
  assert.equal((await f.paywall(paidRequest({}, "wrong-id"), f.handler)).status, 402);
  const req = paidRequest(); req.headers.set(PAYMENT_HEADER, "bad");
  assert.equal((await f.paywall(req, f.handler)).status, 402);
  assert.equal(f.submits(), 0);
  assert.equal(f.delivers(), 0);
});

test("on-chain check refusal prevents settlement even without a local allowlist; only one retry", async () => {
  const f = fixture({ readContract: async ({ functionName }: { functionName: string }) => functionName === "token" ? merchant : selector("MerchantNotAllowed") });
  let requests = 0;
  const agentFetch = createLeashFetch({ account, sessionId: intent.sessionId, chainId, leash, policy: { maxPerRequest: 50_000n }, fetch: (async (input, init) => { requests++; return f.fetcher(input, init); }) as typeof fetch });
  const result = await agentFetch("http://merchant/quote");
  assert.equal(result.status, 402);
  assert.equal((await result.json()).error.code, "MerchantNotAllowed");
  assert.equal(requests, 2);
  assert.equal(f.submits(), 0);
  assert.equal(f.delivers(), 0);
});

test("optional agent preflight blocks before paid retry", async () => {
  const f = fixture({ readContract: async ({ functionName }: { functionName: string }) => functionName === "token" ? merchant : selector("SessionIsRevoked") });
  const agentFetch = createLeashFetch({ account, sessionId: intent.sessionId, chainId, leash, publicClient: f.publicClient, policy: { maxPerRequest: 50_000n }, fetch: f.fetcher });
  await assert.rejects(() => agentFetch("http://merchant/quote"), (e: unknown) => e instanceof LeashPaymentRefused && e.code === "SessionIsRevoked");
  assert.equal(f.submits(), 0);
});

test("reverted/unknown settlement never delivers; handler failure preserves paid receipt", async () => {
  for (const wait of [async () => ({ status: "reverted", transactionHash: tx }), async () => { throw new Error("timeout"); }]) {
    const f = fixture({ waitForTransactionReceipt: wait });
    const res = await f.paywall(paidRequest(), f.handler);
    assert.ok([402, 503].includes(res.status));
    assert.equal(f.delivers(), 0);
  }
  const f = fixture();
  const res = await f.paywall(paidRequest(), async () => { throw new Error("delivery failed"); });
  assert.equal(res.status, 500);
  assert.equal(decodePaymentResponse(res.headers.get(PAYMENT_RESPONSE_HEADER)!).transaction, tx);
});

test("same nonce concurrent requests cause at most one submission", async () => {
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  let checking!: () => void;
  const entered = new Promise<void>((resolve) => { checking = resolve; });
  const f = fixture({ simulateContract: async () => { checking(); await gate; return {}; } });
  const first = f.paywall(paidRequest(), f.handler);
  await entered;
  const second = await f.paywall(paidRequest(), f.handler);
  assert.equal((await second.json()).error.code, "PaymentInProgress");
  unblock();
  assert.equal((await first).status, 200);
  assert.equal(f.submits(), 1);
});

test("agent ignores mismatched protocol/chain/leash quotes and rejects resource substitution", async () => {
  const f = fixture();
  const original = await (await f.paywall(new Request("http://merchant/quote"), f.handler)).json();
  for (const patch of [{ scheme: "other" }, { extra: { chainId: 44005, leash } }, { extra: { chainId, leash: merchant } }]) {
    const fetcher = (async () => Response.json({ ...original, accepts: [{ ...original.accepts[0], ...patch }] }, { status: 402 })) as typeof fetch;
    const agentFetch = createLeashFetch({ account, sessionId: intent.sessionId, chainId, leash, policy: { maxPerRequest: 50_000n }, fetch: fetcher });
    assert.equal((await agentFetch("http://merchant/quote")).status, 402);
  }
  const fetcher = (async () => Response.json({ ...original, accepts: [{ ...original.accepts[0], resource: "http://evil/" }] }, { status: 402 })) as typeof fetch;
  const agentFetch = createLeashFetch({ account, sessionId: intent.sessionId, chainId, leash, policy: { maxPerRequest: 50_000n }, fetch: fetcher });
  await assert.rejects(() => agentFetch("http://merchant/quote"), (e: unknown) => e instanceof LeashPaymentRefused && e.code === "ResourceMismatch");
});
