import { readFile, writeFile } from "node:fs/promises";
const artifact = JSON.parse(await readFile(new URL("../../../contracts/out/SpendLeash.sol/SpendLeash.json", import.meta.url), "utf8"));
await writeFile(new URL("../src/abi.ts", import.meta.url),
  '// Generated from contracts/out/SpendLeash.sol/SpendLeash.json by `pnpm --filter @spendleash/sdk gen-abi`. Do not edit.\n' +
  `export const spendLeashAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`);
