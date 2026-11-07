import {
  encodeFunctionData,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { lensAbi, registryAbi, routerAbi, tokenAbi } from "../abi.js";
import { REGISTRY, TEN_PERCENT_PIPS, walletFor, type Context } from "../chain.js";
import { explain } from "../errors.js";

type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

type PoolView = {
  key: PoolKey;
  config: { quoteIsCurrency0: boolean };
  effectiveTotalFee: bigint;
};

export type Side = "buy" | "sell";

const CALLER: Address = "0x0000000000000000000000000000000000000001";

function pips(value: bigint | number): string {
  const n = typeof value === "bigint" ? value : BigInt(value);
  return `${n} pips`;
}

export async function loadPool(ctx: Context, token: Address): Promise<{ view: PoolView; poolId: Hex }> {
  const view = (await ctx.client.readContract({
    address: ctx.addresses.lens,
    abi: lensAbi,
    functionName: "tokenView",
    args: [token],
  })) as PoolView;
  const known = (await ctx.client.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: "isKnownHook",
    args: [view.key.hooks],
  })) as boolean;
  if (!known) throw new Error(`hook ${view.key.hooks} is not a Montra hook`);
  const poolId = (await ctx.client.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "poolId",
  })) as Hex;
  return { view, poolId };
}

export async function printFeeBreakdown(ctx: Context, hook: Address, poolId: Hex): Promise<void> {
  // viem returns multi-output calls as an array, in ABI order:
  // total, lp, protocol, creator, effectiveTotal.
  const fee = (await ctx.client.readContract({
    address: ctx.addresses.lens,
    abi: lensAbi,
    functionName: "feeBreakdown",
    args: [hook, poolId],
  })) as readonly [number, number, number, number, bigint];
  console.log(
    [
      `fee total=${pips(fee[0])}`,
      `lp=${pips(fee[1])}`,
      `protocol=${pips(fee[2])}`,
      `creator=${pips(fee[3])}`,
      `effectiveTotal=${pips(fee[4])}`,
    ].join(" "),
  );
}

export function zeroForOne(view: PoolView, side: Side): boolean {
  const buyingMovesQuote = view.config.quoteIsCurrency0;
  return side === "buy" ? buyingMovesQuote : !buyingMovesQuote;
}

export function inputCurrency(view: PoolView, side: Side): Address {
  return zeroForOne(view, side) ? view.key.currency0 : view.key.currency1;
}

async function decimalsOf(ctx: Context, asset: Address): Promise<number> {
  if (asset === zeroAddress) return 18;
  return (await ctx.client.readContract({
    address: asset,
    abi: tokenAbi,
    functionName: "decimals",
  })) as number;
}

export async function quoteExactIn(
  ctx: Context,
  view: PoolView,
  side: Side,
  amountIn: bigint,
): Promise<bigint> {
  if (side === "buy" && view.effectiveTotalFee > TEN_PERCENT_PIPS) {
    console.error(`warning: effectiveTotalFee is ${view.effectiveTotalFee} pips, over 10%`);
  }
  try {
    const simulated = await ctx.client.simulateContract({
      address: ctx.addresses.router,
      abi: routerAbi,
      functionName: "quoteExactIn",
      args: [view.key, zeroForOne(view, side), amountIn],
      account: CALLER,
    });
    return simulated.result as bigint;
  } catch (err) {
    throw new Error(explain(err));
  }
}

export async function quote(
  ctx: Context,
  token: Address,
  amount: string,
  side: Side,
  dryRun: boolean,
): Promise<void> {
  const { view } = await loadPool(ctx, token);
  const input = inputCurrency(view, side);
  const amountIn = parseUnits(amount, await decimalsOf(ctx, input));
  const direction = zeroForOne(view, side);
  const amountOut = await quoteExactIn(ctx, view, side, amountIn);
  if (dryRun) {
    const data = encodeFunctionData({
      abi: routerAbi,
      functionName: "quoteExactIn",
      args: [view.key, direction, amountIn],
    });
    console.log(`to=${ctx.addresses.router}`);
    console.log(`data=${data}`);
  }
  console.log(`amountOut=${amountOut}`);
}

export async function trade(
  ctx: Context,
  token: Address,
  amount: string,
  side: Side,
  dryRun: boolean,
): Promise<void> {
  const { view, poolId } = await loadPool(ctx, token);
  await printFeeBreakdown(ctx, view.key.hooks, poolId);
  const input = inputCurrency(view, side);
  const amountIn = parseUnits(amount, await decimalsOf(ctx, input));
  const quoted = await quoteExactIn(ctx, view, side, amountIn);
  const minAmountOut = (quoted * 99n) / 100n;
  const { account, wallet } = await walletFor(ctx);
  const block = await ctx.client.getBlock();
  const deadline = block.timestamp + 300n;
  const exact = {
    key: view.key,
    zeroForOne: zeroForOne(view, side),
    amountIn,
    minAmountOut,
    recipient: account.address,
    deadline,
  };
  const value = input === zeroAddress ? amountIn : 0n;

  if (input !== zeroAddress) {
    const allowance = (await ctx.client.readContract({
      address: input,
      abi: tokenAbi,
      functionName: "allowance",
      args: [account.address, ctx.addresses.router],
    })) as bigint;
    if (allowance < amountIn) {
      const approveData = encodeFunctionData({
        abi: tokenAbi,
        functionName: "approve",
        args: [ctx.addresses.router, amountIn],
      });
      try {
        await ctx.client.simulateContract({
          address: input,
          abi: tokenAbi,
          functionName: "approve",
          args: [ctx.addresses.router, amountIn],
          account,
        });
      } catch (err) {
        throw new Error(explain(err));
      }
      if (dryRun) {
        console.log(`approve to=${input}`);
        console.log(`data=${approveData}`);
      } else {
        const hash = await wallet.writeContract({
          address: input,
          abi: tokenAbi,
          functionName: "approve",
          args: [ctx.addresses.router, amountIn],
          account,
          chain: ctx.chain,
        });
        await ctx.client.waitForTransactionReceipt({ hash });
      }
    }
  }

  const data = encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [exact] });
  try {
    await ctx.client.simulateContract({
      address: ctx.addresses.router,
      abi: routerAbi,
      functionName: "swapExactIn",
      args: [exact],
      value,
      account,
    });
  } catch (err) {
    throw new Error(explain(err));
  }
  if (dryRun) {
    console.log(`to=${ctx.addresses.router}`);
    console.log(`value=${value}`);
    console.log(`data=${data}`);
    console.log(`minAmountOut=${minAmountOut}`);
    return;
  }
  const hash = await wallet.writeContract({
    address: ctx.addresses.router,
    abi: routerAbi,
    functionName: "swapExactIn",
    args: [exact],
    value,
    account,
    chain: ctx.chain,
  });
  const receipt = await ctx.client.waitForTransactionReceipt({ hash });
  const logs = parseEventLogs({
    abi: routerAbi,
    eventName: "Swapped",
    logs: receipt.logs,
  }) as unknown as Array<{ args: { amountOut: bigint } }>;
  const swapped = logs[0];
  console.log(`hash=${hash}`);
  if (swapped) console.log(`amountOut=${swapped.args.amountOut}`);
}
