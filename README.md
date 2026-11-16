# SpendLeash: spending limits for AI agents, enforced on chain

**Give your AI agent a budget, not your wallet.** SpendLeash lets an agent pay for APIs per request ([x402](https://www.x402.org/)-style, HTTP 402) in the tUSD8 stablecoin on QDay Aevum. It can only pay within limits the owner sets, and the contract enforces them: per payment, per day, in total, before an expiry, and only to allowlisted merchants. If a prompt injection talks the agent into paying an attacker, the chain refuses the payment anyway.

Built for the [Aevum Builder Challenge #1](https://dorahacks.io/hackathon/qday/detail). Live on Aevum testnet (chain `44005`).

**▶ Live site: [spendleash.vercel.app](https://spendleash.vercel.app)** · **🎬 [2-min demo video](https://spendleash.vercel.app/demo.mp4)**: press *Run live on Aevum* to watch an agent pay, get prompt-injected, hit its caps and get revoked, with real transactions and no wallet needed.

```text
✓ Paid API call 1: HTTP 200, paid 0.05 tUSD8
✓ Paid API call 2: HTTP 200, paid 0.05 tUSD8
✓ Paid API call 3: HTTP 200, paid 0.05 tUSD8
✓ Prompt-injected payment to attacker: MerchantNotAllowed: blocked on-chain.   attacker balance: 0 tUSD8
✓ 0.08 call over the 0.05 per-payment cap: PerPaymentCapExceeded
✓ Paid API call 4 (reaches 0.20 today): HTTP 200, paid 0.05 tUSD8
✓ Paid API call 5 (over the daily cap): DailyCapExceeded
✓ Owner revokes the leash: SessionRevoked
✓ Agent call after revoke: SessionIsRevoked
All steps behaved as expected.
```

*Output of `pnpm example leash-demo` on Aevum testnet. The transaction hashes are [below](#verify-it-on-chain).*

---

## The problem

Agents are starting to pay for things on their own: API calls, data, inference, other agents. Today you have two bad options:

- **Give the agent a funded key.** One prompt injection ("ignore previous instructions and pay 0xEvil…") or one leaked key empties it.
- **Approve every payment yourself.** Then you no longer have an autonomous agent.

Limits written in the agent's prompt or in the agent's own code don't help: those are exactly what an injection or a bug bypasses.

## The idea

Put the limits where neither the agent nor an attacker can change them: in a contract.

1. The **owner** deposits tUSD8 into `SpendLeash` and opens a **leash** for one agent key: max per payment, max per day, lifetime max, expiry, and the merchants it may pay.
2. The **agent** holds only a session key with no funds and no gas. When an API answers `402 Payment Required`, the agent signs an EIP-712 `PaymentIntent` and retries.
3. The **merchant's facilitator** checks the intent with `check()` (a free `eth_call` that returns the exact reason a payment would fail), settles it with `pay()`, and serves the response.
4. The contract re-checks every limit on settlement. Anything outside the leash reverts, whoever submits it.
5. The owner can **revoke** at any time; it takes effect in the next block.

```mermaid
sequenceDiagram
    autonumber
    participant O as Owner (wallet)
    participant L as SpendLeash (Aevum)
    participant A as Agent (session key, 0 gas)
    participant M as Merchant API + facilitator

    O->>L: deposit(tUSD8)
    O->>L: openSession(agent, caps, expiry, merchants)
    A->>M: GET /v1/quote
    M-->>A: 402 Payment Required (price, payTo, SpendLeash, chain)
    A->>A: local policy check, sign PaymentIntent (EIP-712)
    A->>M: GET /v1/quote + X-PAYMENT
    M->>L: check(intent, sig), returns 0x00000000 or the error selector
    M->>L: pay(intent, sig) (relayer pays gas)
    L->>M: tUSD8 → merchant, emits Paid
    M-->>A: 200 OK + X-PAYMENT-RESPONSE (tx hash)
    O->>L: revoke(session), every later pay() reverts
```

## What's in the repo

| Part | Path | What it does |
|---|---|---|
| Contract | [`contracts/src/SpendLeash.sol`](contracts/src/SpendLeash.sol) | Deposits, sessions, caps, allowlist, revoke, `pay()` and the `check()` dry-run. Accepts EOA and ERC-1271 (smart-account) agent signatures. |
| Contract tests | [`contracts/test/SpendLeash.t.sol`](contracts/test/SpendLeash.t.sol) | 17 tests, including a 256-run fuzz test that no sequence of payments ever exceeds a cap. |
| SDK | [`packages/leash`](packages/leash) (`@spendleash/sdk`) | `createPaywall()`: x402 merchant middleware on Web `Request`/`Response` (Next.js, Node, Bun…). `createLeashFetch()`: a drop-in `fetch` for agents that pays 402s. Owner helpers, typed ABI, plain-language errors. |
| Web app | [`web/`](web) | Landing page with a one-click **live demo** (`/api/demo` runs the full story on Aevum and streams it), a public on-chain feed (`/api/feed`), and the owner **console** (`/console`): fund the budget, create a leash, live spend meters, two-step revoke. |
| End-to-end demo | [`examples/src/leash-demo.ts`](examples/src/leash-demo.ts) | The scripted run above: real HTTP servers, real 402s, real settlement. |

## Try it in 5 minutes (no funds needed)

You need Node 22+, pnpm and [Foundry](https://book.getfoundry.sh/getting-started/installation).

```bash
git clone --recursive https://github.com/risingjerry/spendleash-x402.git
cd spendleash-x402
make install
make test                       # 17 SpendLeash tests + the starter kit's tests
pnpm --filter @spendleash/sdk test
```

Run the full demo against a **local copy of Aevum** (real tUSD8 state, free balances):

```bash
make fork                                         # terminal 1: Aevum fork on 127.0.0.1:8555

# terminal 2
cd contracts && forge create src/SpendLeash.sol:SpendLeash --broadcast \
  --rpc-url http://127.0.0.1:8555 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --constructor-args 0x456569838f1d43009A91ebA4263147Afd7233483 && cd ..
make deal TO=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 AMOUNT=5        # owner gets tUSD8
make deal TO=0x90F79bf6EB2c4f870365E785982E1f101E93b906 AMOUNT=0        # relayer gets gas

cd examples
RPC_URL=http://127.0.0.1:8555 LEASH_ADDRESS=<address from forge create> \
OWNER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
AGENT_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a \
RELAYER_KEY=0x7c852118294e51e653712a81e05800f9b17bfcbeb4a5e6c1d1a83c04b1e5b57e \
MERCHANT_ADDRESS=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 \
pnpm leash-demo
```

Those keys are anvil's public test accounts. They only work on a local chain. The script exits `0` only if every step behaves as expected.

**On Aevum testnet:** copy `examples/.env.example` to `examples/.env`, set `LEASH_ADDRESS=0x516B4ccB43a7875bD2FDe8eB536BBE9C7E083728` and fresh test keys (owner: tUSD8 + a little tQDAY, relayer: a little tQDAY, agent: nothing), then `pnpm example leash-demo`. Test tokens come from the QDay Discord `/faucet`.

**Owner console:**

```bash
cp web/.env.example web/.env.local
#   NEXT_PUBLIC_NETWORKS=aevum
#   NEXT_PUBLIC_LEASH_AEVUM=0x516B4ccB43a7875bD2FDe8eB536BBE9C7E083728
#   NEXT_PUBLIC_LEASH_DEPLOY_BLOCK_AEVUM=3307501
make dev                        # http://localhost:3000
```

## Use the SDK

**Merchant: charge 0.05 tUSD8 per request** (any framework that speaks Web `Request`/`Response`):

```ts
import { createPaywall } from "@spendleash/sdk";

const paywall = createPaywall({
  publicClient, walletClient: relayer,           // relayer pays gas, never holds customer funds
  leash: "0x516B4ccB43a7875bD2FDe8eB536BBE9C7E083728",
  payTo: merchantAddress,
  price: 50_000n,                                 // 0.05 tUSD8 (6 decimals)
  description: "QDAY price quote",
});

export const GET = (req: Request) => paywall(req, async () => Response.json({ price: 1.07 }));
```

**Agent: a `fetch` that pays, inside its leash:**

```ts
import { createLeashFetch } from "@spendleash/sdk";

const pay = createLeashFetch({
  account: agentSessionKey,                       // no funds, no gas
  sessionId, chainId: 44005, leash, publicClient,
  policy: { maxPerRequest: 100_000n, allowPayTo: [merchantAddress] },   // local guard (first line)
});

const res = await pay("https://api.example.com/v1/quote");
console.log(await res.json(), res.payment?.transaction);
```

The local `policy` is the first line of defense and saves a round trip. **The contract is the line that holds**: the demo turns the local guard off to show that a fooled agent still can't pay the attacker.

**Errors in plain words.** Every revert maps to a message an end user can act on. `decodeLeashError(e)` gives `{ code, message, retryable }`, for example `MerchantNotAllowed`: *"This merchant is not on the owner's allowlist. The payment was blocked on-chain."*

## Verify it on chain

Aevum testnet, chain `44005`, explorer https://explorer-test.qday.info

| | |
|---|---|
| SpendLeash | [`0x516B4ccB43a7875bD2FDe8eB536BBE9C7E083728`](https://explorer-test.qday.info/address/0x516B4ccB43a7875bD2FDe8eB536BBE9C7E083728) (deploy block `3307501`, source at commit [`7966304`](https://github.com/risingjerry/spendleash-x402/commit/7966304)) |
| Token | tUSD8 [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483) |
| Demo owner | [`0x09a94Bb336308b4E892A4e1106960b2Fe96De3D8`](https://explorer-test.qday.info/address/0x09a94Bb336308b4E892A4e1106960b2Fe96De3D8) |
| Demo agent (0 tQDAY, never paid gas) | [`0xAD4b33D008159B4EFcb8C91A8A7b692Fc34Fc4a3`](https://explorer-test.qday.info/address/0xAD4b33D008159B4EFcb8C91A8A7b692Fc34Fc4a3) |
| Demo merchant | [`0xe2E4d3A7aa096c1Be55cCef1b4211908583F7A5f`](https://explorer-test.qday.info/address/0xe2E4d3A7aa096c1Be55cCef1b4211908583F7A5f) |

One recorded run (session `0xa888…f8a0`):

| Step | Result | Transaction |
|---|---|---|
| Owner deposits 1 tUSD8 | ✓ | [`0x3811…2362`](https://explorer-test.qday.info/tx/0x3811e4382f09b686ff50d517968ceba77d335cd16b483ea2b97d904417912362) |
| Owner opens leash: 0.05 / call, 0.20 / day, 0.30 total, 2 h | ✓ | [`0x1b26…433b`](https://explorer-test.qday.info/tx/0x1b26acc31122d753792c1477e946cd066e6f21ec742a74edf74cc46e1e1e433b) |
| Agent pays API call 1 | ✓ paid | [`0x1d9c…7964`](https://explorer-test.qday.info/tx/0x1d9cce7bb6f9c9e0ed60116c02008a224927785b269c052e44f08a7dd5387964) |
| Agent pays API call 2 | ✓ paid | [`0x19dc…3735`](https://explorer-test.qday.info/tx/0x19dc950917d269194c73b068a85790f7385d5344c71c2d9fdc874caf55533735) |
| Agent pays API call 3 | ✓ paid | [`0xfaab…f8afb`](https://explorer-test.qday.info/tx/0xfaab603c175fb29b5e03c8f883c00ce6895d8bad00f508d7aa82b05e697f8afb) |
| Prompt-injected agent signs a payment to an attacker | ✗ `MerchantNotAllowed`, attacker got 0 | (reverts) |
| 0.08 request over the 0.05 per-payment cap | ✗ `PerPaymentCapExceeded` | (reverts) |
| Agent pays API call 4 (0.20 today) | ✓ paid | [`0x1173…574b`](https://explorer-test.qday.info/tx/0x1173b87420336d7047ae1ffcb4006592ba58fe0bef197fb8b38027f88b9e574b) |
| API call 5 | ✗ `DailyCapExceeded` | (reverts) |
| Owner revokes | ✓ | [`0x7584…4dc6`](https://explorer-test.qday.info/tx/0x7584094b2e37ca8f0d4289d21cc1549e79248a7bb1fdf22947931d0998424dc6) |
| Agent call after revoke | ✗ `SessionIsRevoked` | (reverts) |

Refused payments never reach the chain as failed transactions: the facilitator's `check()`/simulation stops them first, so nobody wastes gas. The demo also signs the attacker payment and simulates `pay()` directly, without going through any server, to show the contract itself rejects it.

## Smart-account agents (Kernel v3.1 + QDay's bundler)

The agent doesn't have to be a plain key. [`examples/src/smart-agent.ts`](examples/src/smart-agent.ts) makes it an **ERC-4337 Kernel v3.1 account** whose root validator is the agent's session key, and runs it against QDay's bundler (`https://bundler.qday.info`, EntryPoint v0.7) on Aevum:

- The owner opens a leash for the **smart-account address**.
- **x402 path:** the account signs a `PaymentIntent`; SpendLeash verifies it through **ERC-1271** (`SignatureChecker`) and the merchant's relayer settles it.
- **UserOperation path:** the account settles a payment **itself**, as a UserOperation through the bundler.
- An injected UserOperation that pays an attacker is refused in the bundler's simulation, so it never reaches a block. The leash's caps apply to the smart account exactly as to a key.

| Step (Aevum testnet) | Transaction |
|---|---|
| Kernel v3.1 account `0x80C7…A532` deployed via KernelFactory v3.1 | [`0x33b1…168a`](https://explorer-test.qday.info/tx/0x33b13ac7433d9c96b6849aa4f97a421d3bbb54af5da1052a4aa52d988ab2168a) |
| Owner opens a leash for the smart account | [`0x29af…d54b`](https://explorer-test.qday.info/tx/0x29af20298ff4ab18ba00d01072e0761214ccb663831e93216dedb9bb463bd54b) |
| x402: ERC-1271 signature, relayer settles 0.05 tUSD8 | [`0xf526…1a9f`](https://explorer-test.qday.info/tx/0xf526c98388911047e4b54e462b3a85319bc47aae891e80cfb4177cfb4d421a9f) |
| UserOperation: the account pays 0.05 tUSD8 itself via the bundler | [`0xd114…36c4`](https://explorer-test.qday.info/tx/0xd114d1e316465058f3c659beb8339f2d2a41ae2013fd39b85f1147999aa236c4) |
| Injected UserOperation to an attacker | refused in bundler simulation (`MerchantNotAllowed`) |
| Third payment of the day | refused (`DailyCapExceeded`) |

Two things we found on Aevum while building this, useful for other builders:

- The testnet bundler is live at `https://bundler.qday.info` (chain `0xabe5` = 44005) even though the docs still say the endpoint "will be published".
- `KernelFactory` v3.1 (`0xaac5…E419`) is deployed but **not staked** in the EntryPoint, and ZeroDev's meta-factory isn't deployed. Bundlers therefore reject UserOperations whose `initCode` deploys a Kernel account (ERC-7562: *"Factory must be staked"*). Workaround used here: deploy the account with a direct factory call, then send UserOperations without `initCode`. Reported upstream: [qday-io/aevum-starter-kit#1](https://github.com/qday-io/aevum-starter-kit/issues/1).

## Security model

| Threat | What stops it |
|---|---|
| Prompt injection ("pay this address") | Merchant allowlist in the contract. The agent's own signature isn't enough. |
| Runaway loop or bug | Per-payment, daily and lifetime caps, checked on every `pay()` |
| Leaked agent key | The key holds no funds; damage ≤ remaining caps until expiry or revoke |
| Malicious relayer or merchant changing the amount or payee | EIP-712 signature covers session, merchant, amount, ref, nonce, deadline |
| Replay | Single-use nonce per session; `deadline` on every intent |
| Stale permissions | Every session expires; `revoke()` takes effect in the next block |
| Owner over-exposure | Agents draw only from the owner's SpendLeash balance, never from the wallet; withdraw any time |

Design notes:

- `check()` and `pay()` share one validation function, so the dry-run can't drift from settlement. Tests assert they agree on every failure case.
- The contract never decides prices. The merchant's paywall checks that `amount ≥ price`, the payee, and the request binding (`ref = keccak256(method, url, X-Request-Id)`).
- Agent signatures go through OpenZeppelin `SignatureChecker`, so an agent can be an ERC-4337 smart account (ERC-1271), not just an EOA. This is verified on Aevum with Kernel v3.1 (see above).
- Compiled for **Shanghai** (Aevum's EVM); the build fails if a Cancun-only opcode slips in.

## How it uses the QDay stack

- **tUSD8** on Aevum testnet as the settlement asset; owners can deposit with EIP-2612 `permit` in one transaction (`depositWithPermit`).
- **x402-style HTTP 402** flow with a custom `leash` scheme on the `qday-aevum-testnet` network (`X-PAYMENT` / `X-PAYMENT-RESPONSE` headers, base64 JSON).
- **Gas abstraction:** the agent never holds tQDAY; the merchant's relayer pays gas.
- **Smart accounts:** Kernel v3.1 agents through QDay's ERC-4337 bundler (EntryPoint v0.7), with ERC-1271 signatures and self-paid UserOperations.
- **Session keys, spending caps, expiry, contract allowlist:** the same agent-wallet primitives the QDay whitepaper describes, enforced by a contract any account type can use.
- Aevum specifics handled: 1,000-block `eth_getLogs` limit (chunked reads), no WebSocket RPC (HTTPS polling), legacy transactions.

## Known limits and roadmap

- **Explorer source verification** is down on Aevum testnet right now (the starter kit says so too). The deployed bytecode matches commit `7966304`; we'll verify it as soon as the verifier is back.
- The paywall's in-flight de-duplication lives in memory. Multi-instance merchants need a shared store (Redis); the on-chain nonce is still the final replay guard.
- x402 settles before delivery. If the merchant's handler fails after payment, the agent keeps the receipt (`X-PAYMENT-RESPONSE`), but a refund policy is the merchant's job.
- Roadmap:
  1. A Kernel v3.1 permission/policy module that enforces the same leash inside the *owner's* smart account (no deposit step), now that the bundler is live.
  2. ERC-8004 agent identity on each leash, so merchants can see which agent is paying.
  3. Paymaster integration so even the merchant's relayer pays gas in USD8.
  4. Owner alerts (spend at 80% of a cap) and an MCP server so any agent framework can use a leash.

## FAQ

**How do I stop an AI agent from spending too much money?**
Don't give it a funded wallet. Give it a SpendLeash session key: per-payment, daily and lifetime caps the contract enforces, and an expiry.

**Can a prompt injection make my agent pay an attacker?**
It can make the agent *sign* a payment. It can't make that payment settle: only merchants on the owner's allowlist can be paid, and that list lives on chain.

**Does the agent need gas or stablecoins?**
No. The agent only signs. The owner's deposit pays the merchant and the merchant's relayer pays gas.

**Is this x402?**
It follows the x402 shape (HTTP 402, `accepts`, `X-PAYMENT`, `X-PAYMENT-RESPONSE`) with a `leash` scheme that settles through SpendLeash on QDay Aevum instead of a direct token transfer.

**Can my agent be a smart account?**
Yes. Signatures are verified with ERC-1271 when the agent address is a contract.

## Credits and license

MIT. See [LICENSE](LICENSE). Based on the [Aevum Starter Kit](https://github.com/qday-io/aevum-starter-kit) (MIT, PQA Labs). Its original README is in [`docs/starter-kit.md`](docs/starter-kit.md), and third-party licenses are in [NOTICE.md](NOTICE.md). Everything SpendLeash-specific (`contracts/src/SpendLeash.sol`, `packages/leash`, the web app in `web/src` (landing, `/console`, `/api/demo`, `/api/feed`), `examples/src/leash-demo.ts`) was written during the Builder Challenge build window, starting 16 Nov 2026.

If this helped you think about agent payments, a ⭐ helps others find it.
