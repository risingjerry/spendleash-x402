# @spendleash/sdk

MIT-licensed TypeScript source package for viem 2.57+, Node 22+ and browsers.
The workspace already includes `packages/*`. The root workspace link makes it
resolvable from web without changing web files; consumers outside this workspace
must declare their own SDK dependency and transpile its TypeScript source.

- `createPaywall({ publicClient, walletClient, leash, payTo, price, description })`
  wraps an async Web `Request -> Response` handler. `toNodeHandler` adapts it to
  `node:http`. Prices use token base units (tUSD8 has **6 decimals**).
- `createLeashFetch({ account, sessionId, chainId, leash, policy, onPayment? })`
  returns a fetch-compatible function. Read `response.payment` for the receipt
  and amount, or use `onPayment`. It attempts at most one signed retry. An
  optional `publicClient` checks the chain, token and intent before retrying.
- Owner helpers take `{ publicClient, walletClient, leash }`, simulate and wait
  for a successful legacy receipt. `openSession` returns `{ sessionId, receipt }`.
  Approve the token before `deposit`, or pass a permit to `depositWithPermit`.
  Read helpers take `(publicClient, leash, sessionId)`; `readPayments` takes
  `(publicClient, leash, fromBlock, toBlock?)` and returns Paid/SessionRevoked logs
  in chain order, querying at most 1,000 blocks at a time.
- `signIntent`, `intentTypedData`, `refFor` and the x402 header codecs can also
  be used independently. All uint256 values in payment headers are decimal strings.
  `decodeLeashError` understands selectors, revert data and nested viem errors.

## Security and delivery boundaries

The agent's local allowlist is an optional first defense. The **contract's**
allowlist, limits, signature and nonce checks remain authoritative even when an
agent is fooled into signing for an attacker. All gas is paid by the relayer.
The demonstration deliberately disables the local allowlist for this attack.

`refFor` hashes `JSON.stringify([upperCaseMethod, absoluteUrl, requestId])`.
Keep the URL (including query) and `X-Request-Id` unchanged between the challenge
and retry; the client generates that header if absent. Without it the merchant
can only require a nonzero ref. Reverse proxies must preserve the signed external
URL when creating the Web Request (the basic HTTP adapter uses the Host header).
A resource URL is not a delivery idempotency key. Do not automatically retry paid
requests after delivery errors or an unknown settlement status.

The merchant waits for a successful payment receipt **before** running the
resource handler. This is x402's payment-before-delivery trade-off: a handler
failure cannot undo settlement; the 500 response still includes the receipt.
Applications need durable delivery/refund handling. Callback failures likewise
never discard a receipt. Receipt headers are merchant assertions; use an RPC to
independently verify them if the merchant is not trusted.

In-flight nonce locks are in-memory and shared only by requests to the same
paywall instance. Multiple instances/processes need shared locking/storage.
The contract prevents double spending, but not duplicated relayer gas attempts.
A settlement timeout yields **503 SettlementUnknown**, not a new 402 invitation
to pay. Check the chain before retrying. Relayer admission/rate limiting and
browser CORS policy belong to the hosting application. No WebSocket is needed.

Regenerate the ABI after `make build`: `pnpm --filter @spendleash/sdk gen-abi`.
