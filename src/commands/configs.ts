import { formatUnits, zeroAddress, type Address } from "viem";
import { factoryAbi } from "../abi.js";
import { hookOf, quoteLabel, type Context } from "../chain.js";

type Row = {
  moduleSetId: bigint;
  quote: Address;
  totalFeePips: number;
  enabled: boolean;
};

export async function configs(ctx: Context): Promise<void> {
  const count = await ctx.client.readContract({
    address: ctx.addresses.factory,
    abi: factoryAbi,
    functionName: "configCount",
  });
  const total = count as bigint;
  for (let id = 0n; id < total; id++) {
    const row = (await ctx.client.readContract({
      address: ctx.addresses.factory,
      abi: factoryAbi,
      functionName: "getConfig",
      args: [id],
    })) as Row;
    if (!row.enabled) continue;
    const hook = await hookOf(ctx, row.moduleSetId);
    const label = row.quote === zeroAddress ? { symbol: "HYPE", decimals: 18 } : await quoteLabel(ctx, row.quote);
    const pct = formatUnits(BigInt(row.totalFeePips) * 100n, 6);
    console.log(
      [
        `id=${id}`,
        `quote=${label.symbol}`,
        `quoteAsset=${row.quote}`,
        `fee=${row.totalFeePips} pips (${pct}%)`,
        `hook=${hook}`,
      ].join(" "),
    );
  }
}
