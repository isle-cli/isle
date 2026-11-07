import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  encodeFunctionData,
  parseEventLogs,
  parseUnits,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { factoryAbi, tokenAbi } from "../abi.js";
import { API, quoteLabel, walletFor, type Context } from "../chain.js";
import { explain } from "../errors.js";
import { Attribution } from "ox/erc8021";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

type Row = { quote: Address; enabled: boolean };

export type LaunchFlags = {
  name: string;
  symbol: string;
  desc: string;
  image: string;
  config: string;
  buy: string;
  dryRun: boolean;
};

async function post(url: string, body: BodyInit, contentType: string): Promise<{ uri: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  const json = (await response.json()) as { uri?: string; error?: string };
  if (!response.ok || !json.uri) {
    throw new Error(json.error ?? `metadata upload failed (${response.status})`);
  }
  return { uri: json.uri };
}

export async function launch(ctx: Context, flags: LaunchFlags): Promise<void> {
  const contentType = IMAGE_TYPES[extname(flags.image).toLowerCase()];
  if (!contentType) throw new Error("image must be png, jpeg, webp, or gif");
  const configId = BigInt(flags.config);
  const row = (await ctx.client.readContract({
    address: ctx.addresses.factory,
    abi: factoryAbi,
    functionName: "getConfig",
    args: [configId],
  })) as Row;
  if (!row.enabled) throw new Error(`config ${configId} is not enabled`);

  const imageBytes = await readFile(flags.image);
  const image = await post(`${API}/api/metadata/image`, new Uint8Array(imageBytes), contentType);
  const metadata = await post(
    `${API}/api/metadata`,
    JSON.stringify({
      name: flags.name,
      symbol: flags.symbol,
      description: flags.desc,
      image: image.uri,
    }),
    "application/json",
  );

  const quote = await quoteLabel(ctx, row.quote);
  const firstBuyAmount = parseUnits(flags.buy, quote.decimals);
  const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
  const params = {
    name: flags.name,
    symbol: flags.symbol,
    metadataURI: metadata.uri,
    profile: {
      logo: image.uri,
      description: flags.desc,
      socials: { telegram: "", twitter: "", discord: "", website: "", extra: "" },
    },
    configId,
    supply: 0n,
    salt,
    feeRecipients: [] as Address[],
    feeShares: [] as number[],
    firstBuyAmount,
    firstBuyMinOut: 0n,
    permit: { deadline: 0n, v: 0, r: zeroHash, s: zeroHash },
  };

  const launchFee = (await ctx.client.readContract({
    address: ctx.addresses.factory,
    abi: factoryAbi,
    functionName: "launchFee",
  })) as bigint;
  const native = row.quote === zeroAddress;
  const value = native ? launchFee + firstBuyAmount : launchFee;
  const { account, wallet } = await walletFor(ctx);

  if (!native && firstBuyAmount > 0n) {
    const allowance = (await ctx.client.readContract({
      address: row.quote,
      abi: tokenAbi,
      functionName: "allowance",
      args: [account.address, ctx.addresses.factory],
    })) as bigint;
    if (allowance < firstBuyAmount) {
      const approveData = encodeFunctionData({
        abi: tokenAbi,
        functionName: "approve",
        args: [ctx.addresses.factory, firstBuyAmount],
      });
      try {
        await ctx.client.simulateContract({
          address: row.quote,
          abi: tokenAbi,
          functionName: "approve",
          args: [ctx.addresses.factory, firstBuyAmount],
          account,
        });
      } catch (err) {
        throw new Error(explain(err));
      }
      if (flags.dryRun) {
        console.log(`approve to=${row.quote}`);
        console.log(`data=${approveData}`);
      } else {
        const hash = await wallet.writeContract({
          address: row.quote,
          abi: tokenAbi,
          functionName: "approve",
          args: [ctx.addresses.factory, firstBuyAmount],
          account,
          chain: ctx.chain,
        });
        await ctx.client.waitForTransactionReceipt({ hash });
      }
    }
  }

  const data = encodeFunctionData({ abi: factoryAbi, functionName: "launch", args: [params] });
  try {
    await ctx.client.simulateContract({
      address: ctx.addresses.factory,
      abi: factoryAbi,
      functionName: "launch",
      
    args: [params],
    dataSuffix: Attribution.toDataSuffix({ codes: [ctx.config.builderCode] }),
      value,
      account,
    });
  } catch (err) {
    throw new Error(explain(err));
  }
  if (flags.dryRun) {
    console.log(`to=${ctx.addresses.factory}`);
    console.log(`value=${value}`);
    console.log(`data=${data}`);
    console.log("dataSuffix=" + Attribution.toDataSuffix({ codes: [ctx.config.builderCode] }));
    return;
  }

  const hash = await wallet.writeContract({
    address: ctx.addresses.factory,
    abi: factoryAbi,
    functionName: "launch",
    
    args: [params],
    dataSuffix: Attribution.toDataSuffix({ codes: [ctx.config.builderCode] }),
    value,
    account,
    chain: ctx.chain,
  });
  console.log("hash=" + hash);
  const receipt = await ctx.client.waitForTransactionReceipt({ hash });
  const logs = parseEventLogs({
    abi: factoryAbi,
    eventName: "TokenLaunched",
    logs: receipt.logs,
  }) as unknown as Array<{ args: { token: Address; poolId: Hex; firstBuyOut: bigint } }>;
  const launched = logs[0];
  if (!launched) throw new Error(`launch mined in ${hash} but TokenLaunched was not in the receipt`);
  console.log(`token=${launched.args.token}`);
  console.log(`poolId=${launched.args.poolId}`);
  console.log(`firstBuyOut=${launched.args.firstBuyOut}`);
}




