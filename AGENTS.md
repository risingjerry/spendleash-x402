# AGENTS.md — SpendLeash

SpendLeash = on-chain spending limits for AI agents on QDay Aevum (chain 44005). Owner deposits tUSD8, opens a
"leash" (per-payment / daily / lifetime caps, expiry, merchant allowlist) for an agent key; the agent signs EIP-712
`PaymentIntent`s; a merchant's x402 paywall settles them via `SpendLeash.pay()`.

## Layout
- `contracts/` Foundry. `src/SpendLeash.sol` (the product), `test/SpendLeash.t.sol`. Starter-kit `Checkout.sol` kept as reference.
- `packages/leash/` `@spendleash/sdk`: `createPaywall` (merchant), `createLeashFetch` (agent), owner helpers, `decodeLeashError`.
- `packages/aevum/` chain config, `getLogsChunked` (Aevum caps eth_getLogs at 1,000 blocks).
- `web/` Next.js owner console (`/`), plus the starter kit's pages.
- `examples/src/leash-demo.ts` end-to-end run; exits non-zero if any step misbehaves.

## Commands
```bash
make install                         # submodules + pnpm
make build                           # forge build + Shanghai opcode check (must pass)
make test                            # forge unit tests
pnpm --filter @spendleash/sdk test   # SDK tests
pnpm -r typecheck && pnpm build      # TS + web
make fork                            # local Aevum copy on 127.0.0.1:8555 for end-to-end runs
pnpm --filter examples leash-demo    # needs env, see examples/.env.example
```
After changing `SpendLeash.sol`: `make build && pnpm --filter @spendleash/sdk gen-abi`, then rerun the SDK tests.

## Rules
- EVM is **Shanghai**. Never raise `evm_version`, never use OpenZeppelin `*Transient` contracts.
- `check()` and `pay()` must share `_check()`; add a test for any new failure path asserting both agree.
- Send legacy (type 0) transactions on Aevum. Poll over HTTPS; there is no WebSocket RPC.
- Never commit keys or `.env` files. Use only throwaway test wallets; anvil keys only on `make fork` / `make anvil`.
- Don't send transactions to Aevum testnet unless asked; prefer `make fork`.
