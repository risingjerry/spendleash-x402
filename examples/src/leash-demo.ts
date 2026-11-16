/**
 * SpendLeash, end to end: an AI agent pays for an API over x402, inside limits the chain enforces.
 *
 *   1. The owner deposits tUSD8 and opens a leash for the agent's session key.
 *   2. A merchant API answers 402 Payment Required; the agent signs a PaymentIntent and retries.
 *      The merchant's relayer settles it on chain, the agent needs no gas.
 *   3. A prompt-injected agent is sent to an attacker's paywall. It signs. The chain refuses.
 *   4. Over the per-payment cap, then over the daily cap: refused.
 *   5. The owner revokes: the next payment is refused in the same block.
 *
 *   pnpm example leash-demo
 *
 * Env: RPC_URL, LEASH_ADDRESS, OWNER_KEY, AGENT_KEY, RELAYER_KEY, MERCHANT_ADDRESS, [DEPOSIT=1]
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createWalletClient, formatUnits, http, parseUnits, type Address, type Hash, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { aevumTestnet, erc20Abi, txUrl } from "@aevum-kit/aevum";
import {
  createLeashFetch,
  createPaywall,
  decodeLeashError,
  deposit,
  LeashPaymentRefused,
  newNonce,
  openSession,
  refFor,
  remaining,
  revoke,
  signIntent,
  spendLeashAbi,
  toNodeHandler,
} from "@spendleash/sdk";
import { connect, requiredAddress, requiredKey } from "./env";

const { client, chain, rpcUrl } = await connect();
const leash = requiredAddress("LEASH_ADDRESS");
const merchant = requiredAddress("MERCHANT_ADDRESS");
const owner = privateKeyToAccount(requiredKey("OWNER_KEY"));
const agent = privateKeyToAccount(requiredKey("AGENT_KEY"));
const relayer = privateKeyToAccount(requiredKey("RELAYER_KEY"));
const attacker = privateKeyToAccount(generatePrivateKey()).address;
const wallet = (account: typeof owner) => createWalletClient({ account, chain, transport: http(rpcUrl) });
const ownerOpts = { publicClient: client, walletClient: wallet(owner), leash };

const token = await client.readContract({ address: leash, abi: spendLeashAbi, functionName: "token" });
const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
const u = (v: string) => parseUnits(v, decimals);
const f = (v: bigint) => `${formatUnits(v, decimals)} tUSD8`;
const link = (h: Hash) => (chain.id === aevumTestnet.id ? txUrl(h) : h);

type Row = { step: string; expected: "paid" | "refused"; outcome: "paid" | "refused"; detail: string; tx?: Hash };
const rows: Row[] = [];
function log(row: Row) {
  rows.push(row);
  const ok = row.expected === row.outcome ? "✓" : "✗ UNEXPECTED";
  console.log(`${ok} ${row.step}: ${row.detail}${row.tx ? `\n    ${link(row.tx)}` : ""}`);
}

// ───── merchant APIs (each a tiny node:http server behind a SpendLeash paywall) ─────
const relayerWallet = wallet(relayer);
async function serve(payTo: Address, price: bigint, path: string, body: () => unknown): Promise<{ url: string; server: Server }> {
  const paywall = createPaywall({ publicClient: client, walletClient: relayerWallet, leash, payTo, price, description: `${path} (${f(price)})` });
  const server = createServer(toNodeHandler(paywall, async () => Response.json(body())));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, server };
}
const quote = await serve(merchant, u("0.05"), "/v1/quote?symbol=QDAY", () => ({ symbol: "QDAY", price: 1.07, at: Date.now() }));
const premium = await serve(merchant, u("0.08"), "/v1/premium-report", () => ({ report: "…" }));
const evil = await serve(attacker, u("0.05"), "/v1/totally-legit", () => ({ gotcha: true }));

try {
  console.log(`SpendLeash ${leash} on ${chain.name} (${chain.id})`);
  console.log(`owner ${owner.address} · agent ${agent.address} · merchant ${merchant} · relayer ${relayer.address}\n`);

  // ───── 1. owner funds the leash and opens a session ─────
  const want = u(process.env.DEPOSIT ?? "1");
  const inLeash = await client.readContract({ address: leash, abi: spendLeashAbi, functionName: "balanceOf", args: [owner.address] });
  if (inLeash < u("0.30")) {
    const ow = wallet(owner);
    const approve = await ow.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [leash, want], type: "legacy" });
    await client.waitForTransactionReceipt({ hash: approve });
    const r = await deposit(ownerOpts, want);
    console.log(`Owner deposited ${f(want)} → ${link(r.transactionHash)}`);
  } else {
    console.log(`Owner already has ${f(inLeash)} in SpendLeash`);
  }
  const head = await client.getBlock();
  const { sessionId, receipt: opened } = await openSession(
    ownerOpts,
    agent.address,
    { perPaymentCap: u("0.05"), dailyCap: u("0.20"), totalCap: u("0.30"), validUntil: Number(head.timestamp) + 2 * 3600 },
    [merchant],
  );
  console.log(`Owner opened leash ${sessionId}: 0.05 per call, 0.20 per day, 0.30 total, 2 h, may pay only ${merchant}`);
  console.log(`    ${link(opened.transactionHash)}\n`);

  // ───── the agent's HTTP client ─────
  const agentFetch = (allowPayTo?: Address[]) =>
    createLeashFetch({ account: agent, sessionId, chainId: chain.id, leash, publicClient: client, policy: { maxPerRequest: u("1"), allowPayTo } });
  const careful = agentFetch([merchant]);
  const injected = agentFetch(undefined); // local guard switched off: the agent "believes" the attacker

  async function call(step: string, expected: Row["expected"], fetcher: ReturnType<typeof agentFetch>, url: string) {
    try {
      const res = await fetcher(url);
      if (res.payment) {
        log({ step, expected, outcome: "paid", detail: `HTTP ${res.status}, paid ${f(res.payment.amount)}`, tx: res.payment.transaction });
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
        log({ step, expected, outcome: "refused", detail: `HTTP ${res.status} ${body.error?.code ?? ""}: ${body.error?.message ?? ""}` });
      }
    } catch (e) {
      if (e instanceof LeashPaymentRefused) log({ step, expected, outcome: "refused", detail: `${e.code}: ${e.message}` });
      else throw e;
    }
  }

  // ───── 2. normal use ─────
  for (let i = 1; i <= 3; i++) await call(`Paid API call ${i}`, "paid", careful, quote.url);

  // ───── 3. prompt injection: the agent is talked into paying an attacker ─────
  await call("Prompt-injected payment to attacker", "refused", injected, evil.url);
  // Not just the attacker's server being polite: sign the intent and try to settle it directly.
  {
    const intent = { sessionId, merchant: attacker, amount: u("0.05"), ref: refFor("GET", evil.url, "direct"), nonce: newNonce() as Hex, deadline: head.timestamp + 600n };
    const signature = await signIntent(agent, chain.id, leash, intent);
    try {
      await client.simulateContract({ account: relayer, address: leash, abi: spendLeashAbi, functionName: "pay", args: [intent, signature] });
      log({ step: "Signed intent to attacker, settled directly", expected: "refused", outcome: "paid", detail: "simulation passed (!)" });
    } catch (e) {
      const d = decodeLeashError(e);
      log({ step: "Signed intent to attacker, settled directly", expected: "refused", outcome: "refused", detail: `${d?.code}: contract reverts` });
    }
    const stolen = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [attacker] });
    console.log(`    attacker balance: ${f(stolen)}`);
  }

  // ───── 4. limits ─────
  await call("0.08 call over the 0.05 per-payment cap", "refused", agentFetch([merchant]), premium.url);
  await call("Paid API call 4 (reaches 0.20 today)", "paid", careful, quote.url);
  await call("Paid API call 5 (over the daily cap)", "refused", careful, quote.url);
  const [per, today, total] = await remaining(client, leash, sessionId);
  console.log(`    remaining: per call ${f(per)}, today ${f(today)}, lifetime ${f(total)}`);

  // ───── 5. kill switch ─────
  const revoked = await revoke(ownerOpts, sessionId);
  log({ step: "Owner revokes the leash", expected: "paid", outcome: "paid", detail: "SessionRevoked", tx: revoked.transactionHash });
  await call("Agent call after revoke", "refused", careful, quote.url);

  // ───── summary ─────
  const good = rows.every((r) => r.expected === r.outcome);
  console.log(`\n${good ? "All steps behaved as expected." : "Some steps did NOT behave as expected."}`);
  console.table(rows.map((r) => ({ step: r.step, expected: r.expected, outcome: r.outcome, tx: r.tx ?? "" })));
  mkdirSync("out", { recursive: true });
  const file = `out/leash-demo-${chain.id}-${Date.now()}.json`;
  writeFileSync(
    file,
    JSON.stringify(
      { chainId: chain.id, leash, owner: owner.address, agent: agent.address, merchant, attacker, sessionId, openTx: opened.transactionHash, rows },
      null,
      2,
    ),
  );
  console.log(`Saved ${file}`);
  process.exitCode = good ? 0 : 1;
} finally {
  for (const s of [quote, premium, evil]) s.server.close();
}
