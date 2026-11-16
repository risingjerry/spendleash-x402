/**
 * SpendLeash with an ERC-4337 smart-account agent on Aevum: Kernel v3.1 + EntryPoint v0.7 + QDay's bundler.
 *
 *   1. The agent is a Kernel v3.1 account whose root validator is the agent's session key (ECDSA).
 *   2. The owner opens a leash for the *smart account* address.
 *   3. x402 path: the smart account signs a PaymentIntent (ERC-1271); the merchant's relayer settles it.
 *   4. UserOperation path: the smart account settles a payment itself through the bundler.
 *   5. A prompt-injected UserOperation to an attacker is refused by the contract before it reaches a block.
 *
 *   pnpm example smart-agent
 *
 * Env: RPC_URL, LEASH_ADDRESS, OWNER_KEY, AGENT_KEY, RELAYER_KEY, MERCHANT_ADDRESS,
 *      BUNDLER_URL (default https://bundler.qday.info), FUNDER_KEY (tops up the smart account's gas; defaults to RELAYER_KEY)
 */
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createWalletClient, encodeFunctionData, formatEther, formatUnits, http, parseEther, parseUnits, type Hash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { aevumTestnet, txUrl } from "@aevum-kit/aevum";
import { decodeLeashError, intentTypedData, newNonce, openSession, refFor, spendLeashAbi } from "@spendleash/sdk";
import { connect, requiredAddress, requiredKey } from "./env";

const { client, chain, rpcUrl } = await connect();
const leash = requiredAddress("LEASH_ADDRESS");
const merchant = requiredAddress("MERCHANT_ADDRESS");
const owner = privateKeyToAccount(requiredKey("OWNER_KEY"));
const sessionKey = privateKeyToAccount(requiredKey("AGENT_KEY"));
const relayer = privateKeyToAccount(requiredKey("RELAYER_KEY"));
const funder = privateKeyToAccount((process.env.FUNDER_KEY?.trim() as `0x${string}`) || requiredKey("RELAYER_KEY"));
const bundlerUrl = process.env.BUNDLER_URL?.trim() || "https://bundler.qday.info";
const attacker = privateKeyToAccount(generatePrivateKey()).address;
const link = (h: Hash) => (chain.id === aevumTestnet.id ? txUrl(h) : h);
const u = (v: string) => parseUnits(v, 6);

// ── the agent as a Kernel v3.1 smart account ──
const entryPoint = getEntryPoint("0.7");
const ecdsa = await signerToEcdsaValidator(client, { signer: sessionKey, entryPoint, kernelVersion: KERNEL_V3_1 });
// Aevum has KernelFactory v3.1 but not ZeroDev's meta-factory: deploy through the factory directly.
const agent = await createKernelAccount(client, { plugins: { sudo: ecdsa }, entryPoint, kernelVersion: KERNEL_V3_1, useMetaFactory: false });
const kernel = createKernelAccountClient({
  account: agent,
  chain,
  client,
  bundlerTransport: http(bundlerUrl),
  userOperation: {
    // QDay's bundler is rundler-based; take fees from the node instead of a vendor-specific RPC.
    estimateFeesPerGas: async () => {
      const gasPrice = await client.getGasPrice();
      const fee = gasPrice * 2n + 1_000_000_000n;
      return { maxFeePerGas: fee, maxPriorityFeePerGas: fee };
    },
  },
});
console.log(`Agent smart account (Kernel v3.1): ${agent.address}  · session key ${sessionKey.address}`);
console.log(`Bundler ${bundlerUrl} · EntryPoint ${entryPoint.address}\n`);

// gas for the account's own UserOperations (no USD8 paymaster on Aevum yet)
const bal = await client.getBalance({ address: agent.address });
if (bal < parseEther("0.02")) {
  const h = await createWalletClient({ account: funder, chain, transport: http(rpcUrl) }).sendTransaction({ to: agent.address, value: parseEther("0.03"), type: "legacy" });
  await client.waitForTransactionReceipt({ hash: h });
  console.log(`Funded smart account with 0.03 tQDAY for UserOperation gas → ${link(h)}`);
} else {
  console.log(`Smart account gas balance ${formatEther(bal)} tQDAY`);
}

// Deploy the account (ERC-1271 needs code at the address). Aevum's KernelFactory isn't staked in the
// EntryPoint, so bundlers (ERC-7562) refuse UserOperations that deploy through it: call the factory directly.
if (!(await agent.isDeployed())) {
  const { factory, factoryData } = await agent.getFactoryArgs();
  const h = await createWalletClient({ account: funder, chain, transport: http(rpcUrl) }).sendTransaction({ to: factory!, data: factoryData!, type: "legacy" });
  await client.waitForTransactionReceipt({ hash: h });
  console.log(`Deployed the smart account through KernelFactory v3.1\n    ${link(h)}`);
}

// ── owner opens a leash for the smart account ──
const head = await client.getBlock();
const { sessionId, receipt: opened } = await openSession(
  { publicClient: client, walletClient: createWalletClient({ account: owner, chain, transport: http(rpcUrl) }), leash },
  agent.address,
  { perPaymentCap: u("0.05"), dailyCap: u("0.10"), totalCap: u("0.10"), validUntil: Number(head.timestamp) + 3600 },
  [merchant],
);
console.log(`Owner opened leash ${sessionId} for the smart account\n    ${link(opened.transactionHash)}\n`);

const intent = (to: `0x${string}`, amount: bigint, tag: string) => ({
  sessionId,
  merchant: to,
  amount,
  ref: refFor("GET", `https://api.quotes.example/${tag}`, tag),
  nonce: newNonce(),
  deadline: head.timestamp + 900n,
});
const signBySmartAccount = (i: ReturnType<typeof intent>) => agent.signTypedData(intentTypedData(chain.id, leash, i));

let ok = true;

// ── 3. x402 path: ERC-1271 signature, relayer settles ──
{
  const i = intent(merchant, u("0.05"), "x402");
  const sig = await signBySmartAccount(i);
  const sel = await client.readContract({ address: leash, abi: spendLeashAbi, functionName: "check", args: [i, sig] });
  if (sel !== "0x00000000") {
    ok = false;
    console.log(`✗ check() refused the smart-account signature: ${decodeLeashError(sel)?.code ?? sel}`);
  } else {
    const w = createWalletClient({ account: relayer, chain, transport: http(rpcUrl) });
    const h = await w.writeContract({ address: leash, abi: spendLeashAbi, functionName: "pay", args: [i, sig], type: "legacy" });
    const r = await client.waitForTransactionReceipt({ hash: h });
    console.log(`✓ x402: smart account signed (ERC-1271), relayer settled 0.05 tUSD8 → ${r.status}\n    ${link(h)}`);
  }
}

// ── 4. UserOperation path: the smart account settles its own payment through the bundler ──
{
  const i = intent(merchant, u("0.05"), "userop");
  const sig = await signBySmartAccount(i);
  const op = await kernel.sendUserOperation({
    callData: await agent.encodeCalls([{ to: leash, value: 0n, data: encodeFunctionData({ abi: spendLeashAbi, functionName: "pay", args: [i, sig] }) }]),
  });
  const r = await kernel.waitForUserOperationReceipt({ hash: op });
  if (!r.success) ok = false;
  console.log(`${r.success ? "✓" : "✗"} UserOperation: smart account paid 0.05 tUSD8 itself via the bundler (userOp ${op.slice(0, 12)}…)\n    ${link(r.receipt.transactionHash)}`);
}

// ── 5. prompt injection as a UserOperation ──
{
  const i = intent(attacker, u("0.05"), "evil");
  const sig = await signBySmartAccount(i);
  try {
    await kernel.sendUserOperation({
      callData: await agent.encodeCalls([{ to: leash, value: 0n, data: encodeFunctionData({ abi: spendLeashAbi, functionName: "pay", args: [i, sig] }) }]),
    });
    ok = false;
    console.log("✗ the injected UserOperation was accepted (should never happen)");
  } catch (e) {
    // The bundler's simulation reverts; check() names the exact reason.
    const sel = await client.readContract({ address: leash, abi: spendLeashAbi, functionName: "check", args: [i, sig] });
    const d = decodeLeashError(e) ?? decodeLeashError(sel);
    console.log(`✓ Injected UserOperation to ${attacker.slice(0, 10)}… refused by the bundler's simulation: ${d?.code ?? (e as Error).message.split("\n")[0]}`);
  }
}

// ── limits still apply to the smart account ──
{
  const i = intent(merchant, u("0.05"), "over");
  const sig = await signBySmartAccount(i);
  const sel = await client.readContract({ address: leash, abi: spendLeashAbi, functionName: "check", args: [i, sig] });
  const d = decodeLeashError(sel);
  if (d?.code !== "DailyCapExceeded") ok = false;
  console.log(`${d?.code === "DailyCapExceeded" ? "✓" : "✗"} Third payment: ${d?.code ?? "passed (!)"}`);
}

const [, today] = await client.readContract({ address: leash, abi: spendLeashAbi, functionName: "remaining", args: [sessionId] });
console.log(`\nSmart-account leash: ${formatUnits(u("0.10") - today, 6)} / 0.10 tUSD8 spent today.`);
console.log(ok ? "All steps behaved as expected." : "Some steps did NOT behave as expected.");
process.exitCode = ok ? 0 : 1;
