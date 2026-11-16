"use client";

import { erc20Abi, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import { spendLeashAbi } from "@spendleash/sdk";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { useNetwork } from "@/lib/network";

/** The payment token: SpendLeash.token() when configured, otherwise tUSD8 on Aevum. */
export function useToken() {
  const { net } = useNetwork();
  const chainId = net.chain.id;
  const fromLeash = useReadContract({ address: net.leash, abi: spendLeashAbi, functionName: "token", chainId, query: { enabled: Boolean(net.leash) } });
  const address: Address | undefined = fromLeash.data ?? (net.key === "local" ? undefined : TUSD8_ADDRESS);
  const meta = useReadContracts({
    contracts: address
      ? [
          { address, abi: erc20Abi, functionName: "decimals", chainId },
          { address, abi: erc20Abi, functionName: "symbol", chainId },
        ]
      : [],
    query: { enabled: Boolean(address) },
  });
  const decimals = (meta.data?.[0]?.result as number | undefined) ?? 6;
  const symbol = (meta.data?.[1]?.result as string | undefined) ?? "tUSD8";
  return { address, decimals, symbol, isLoading: fromLeash.isLoading || meta.isLoading };
}
