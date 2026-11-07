import {
  encodeFunctionData,
  formatUnits,
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

export type FeeParts = {
  total: string;
  lp: string;
  protocol: string;
  creator: string;
  effectiveTotal: string;
  line: string;
};

export async function readFee(ctx: Context, hook: Address, poolId: Hex): Promise<FeeParts> {
  // viem returns multi-output calls as an array, in ABI order:
  // total, lp, protocol, creator, effectiveTotal.
  const fee = (await ctx.client.readContract({
    address: ctx.addresses.lens,
    abi: lensAbi,
    functionName: "feeBreakdown",
    args: [hook, poolId],
  })) as readonly [number, number, number, number, bigint];
  const total = pips(fee[0]);
  const lp = pips(fee[1]);
  const protocol = pips(fee[2]);
  const creator = pips(fee[3]);
  const effectiveTotal = pips(fee[4]);
  return {
    total,
    lp,
    protocol,
    creator,
    effectiveTotal,
    line: [
      `fee total=${total}`,
      `lp=${lp}`,
      `protocol=${protocol}`,
      `creator=${creator}`,
      `effectiveTotal=${effectiveTotal}`,
    ].join(" "),
  };
}

export async function printFeeBreakdown(ctx: Context, hook: Address, poolId: Hex): Promise<void> {
  console.log((await readFee(ctx, hook, poolId)).line);
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

export type QuoteResult = {
  to: Address;
  data: Hex;
  amountOut: bigint;
  effectiveTotalFee: bigint;
};

export async function quoteResult(
  ctx: Context,
  token: Address,
  amount: string,
  side: Side,
): Promise<QuoteResult> {
  const { view } = await loadPool(ctx, token);
  const input = inputCurrency(view, side);
  const amountIn = parseUnits(amount, await decimalsOf(ctx, input));
  const direction = zeroForOne(view, side);
  const amountOut = await quoteExactIn(ctx, view, side, amountIn);
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: "quoteExactIn",
    args: [view.key, direction, amountIn],
  });
  return { to: ctx.addresses.router, data, amountOut, effectiveTotalFee: view.effectiveTotalFee };
}

export async function quote(
  ctx: Context,
  token: Address,
  amount: string,
  side: Side,
  dryRun: boolean,
): Promise<void> {
  const result = await quoteResult(ctx, token, amount, side);
  if (dryRun) {
    console.log(`to=${result.to}`);
    console.log(`data=${result.data}`);
  }
  console.log(`amountOut=${result.amountOut}`);
}

export type TradeResult = {
  fee: FeeParts;
  poolId: Hex;
  token: Address;
  approveTo?: Address;
  approveData?: Hex;
  to: Address;
  value: bigint;
  data: Hex;
  minAmountOut: bigint;
  dryRun: boolean;
  hash?: Hex;
  amountOut?: bigint;
};

export async function runTrade(
  ctx: Context,
  token: Address,
  amount: string,
  side: Side,
  dryRun: boolean,
  maxSpendWei?: bigint,
  onFee?: (line: string) => void,
  onDryApprove?: (to: Address, data: Hex) => void,
): Promise<TradeResult> {
  const { view, poolId } = await loadPool(ctx, token);
  const fee = await readFee(ctx, view.key.hooks, poolId);
  onFee?.(fee.line);
  const input = inputCurrency(view, side);
  const amountIn = parseUnits(amount, await decimalsOf(ctx, input));
  const value = input === zeroAddress ? amountIn : 0n;
  if (maxSpendWei !== undefined && value > maxSpendWei) {
    throw new Error(
      `spend of ${formatUnits(value, 18)} HYPE exceeds maxSpendHype ${formatUnits(maxSpendWei, 18)}`,
    );
  }
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

  let approveTo: Address | undefined;
  let approveData: Hex | undefined;
  if (input !== zeroAddress) {
    const allowance = (await ctx.client.readContract({
      address: input,
      abi: tokenAbi,
      functionName: "allowance",
      args: [account.address, ctx.addresses.router],
    })) as bigint;
    if (allowance < amountIn) {
      approveData = encodeFunctionData({
        abi: tokenAbi,
        functionName: "approve",
        args: [ctx.addresses.router, amountIn],
      });
      approveTo = input;
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
        onDryApprove?.(input, approveData);
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
    return {
      fee,
      poolId,
      token,
      approveTo,
      approveData,
      to: ctx.addresses.router,
      value,
      data,
      minAmountOut,
      dryRun,
    };
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
  return {
    fee,
    poolId,
    token,
    to: ctx.addresses.router,
    value,
    data,
    minAmountOut,
    dryRun,
    hash,
    amountOut: swapped?.args.amountOut,
  };
}

export async function trade(
  ctx: Context,
  token: Address,
  amount: string,
  side: Side,
  dryRun: boolean,
): Promise<void> {
  const result = await runTrade(
    ctx,
    token,
    amount,
    side,
    dryRun,
    undefined,
    (line) => console.log(line),
    (to, data) => {
      console.log(`approve to=${to}`);
      console.log(`data=${data}`);
    },
  );
  if (dryRun) {
    console.log(`to=${result.to}`);
    console.log(`value=${result.value}`);
    console.log(`data=${result.data}`);
    console.log(`minAmountOut=${result.minAmountOut}`);
    return;
  }
  console.log(`hash=${result.hash}`);
  if (result.amountOut !== undefined) console.log(`amountOut=${result.amountOut}`);
}
