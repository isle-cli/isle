import { formatUnits, zeroAddress, type Address } from "viem";
import { factoryAbi } from "../abi.js";
import { hookOf, quoteLabel, type Context } from "../chain.js";

type Row = {
  moduleSetId: bigint;
  quote: Address;
  totalFeePips: number;
  enabled: boolean;
};

export type ConfigRow = {
  id: bigint;
  quote: string;
  quoteAsset: Address;
  feePips: number;
  feePct: string;
  hook: Address;
};

export async function listConfigRows(ctx: Context): Promise<ConfigRow[]> {
  const count = await ctx.client.readContract({
    address: ctx.addresses.factory,
    abi: factoryAbi,
    functionName: "configCount",
  });
  const total = count as bigint;
  const rows: ConfigRow[] = [];
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
    rows.push({
      id,
      quote: label.symbol,
      quoteAsset: row.quote,
      feePips: row.totalFeePips,
      feePct: pct,
      hook,
    });
  }
  return rows;
}

export async function configs(ctx: Context): Promise<void> {
  const rows = await listConfigRows(ctx);
  for (const row of rows) {
    console.log(
      [
        `id=${row.id}`,
        `quote=${row.quote}`,
        `quoteAsset=${row.quoteAsset}`,
        `fee=${row.feePips} pips (${row.feePct}%)`,
        `hook=${row.hook}`,
      ].join(" "),
    );
  }
}
