---
name: spendleash
description: Pay for HTTP 402 / x402 APIs from an AI agent within owner-set, on-chain spending limits (SpendLeash on QDay Aevum), or add a pay-per-request paywall to an API. Use when an agent must pay per API call in tUSD8, when a merchant wants to charge agents per request, or when someone asks how to cap what an AI agent can spend.
---

# SpendLeash

Contract on QDay Aevum testnet (chain 44005): `0x516B4ccB43a7875bD2FDe8eB536BBE9C7E083728`. Token: tUSD8 (6 decimals).
SDK: `@spendleash/sdk` (workspace package `packages/leash` in https://github.com/risingjerry/spendleash-x402).

## Agent: pay a 402 API
```ts
const pay = createLeashFetch({ account, sessionId, chainId: 44005, leash, publicClient,
  policy: { maxPerRequest: 100_000n, allowPayTo: [merchant] } });
const res = await pay(url);            // res.payment?.transaction = settlement tx
```
- The agent key holds no funds or gas. Get `sessionId` from the owner.
- On `LeashPaymentRefused`, report `e.code` + `e.message` to the user. Never work around it (another key, another merchant, splitting payments).
- `DailyCapExceeded` / `InsufficientDeposit` are the only ones worth retrying, and only after the condition changes.

## Merchant: charge per request
```ts
const paywall = createPaywall({ publicClient, walletClient: relayer, leash, payTo, price: 50_000n, description });
export const GET = (req: Request) => paywall(req, handler);
```
The relayer needs a little tQDAY. It never holds customer funds.

## Owner
`deposit`, `openSession(agent, {perPaymentCap, dailyCap, totalCap, validUntil}, merchants)`, `revoke(sessionId)` from the SDK,
or use the web console. Always set an expiry and the smallest caps that do the job.
