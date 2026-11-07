import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  stringToHex,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { factoryAbi, quoteRegistryAbi, registryAbi } from "./abi.js";
import { loadConfig, readPrivateKey, type Config } from "./config.js";

/** Registry from the spec and from Montra's contracts page. */
export const REGISTRY: Address = "0xF1E2FA75422F889e565F3142bdbf60B28dce2aa7";

/**
 * The request named chain 99801. That chain has no code at REGISTRY.
 * Montra's contracts page puts this registry on Elysium mainnet, chain 99901.
 */
export const CHAIN_ID = 99901;

export const DEFAULT_RPC = "https://rpc.montramarkets.xyz";

export const API = "https://api.montramarkets.xyz";

/** 1e6 pips = 100%. */
export const PIPS = 1_000_000n;
export const TEN_PERCENT_PIPS = 100_000n;

export function registryKey(name: string): Hex {
  return stringToHex(name, { size: 32 });
}

export type Addresses = {
  factory: Address;
  router: Address;
  lens: Address;
  quoteRegistry: Address;
};

export type Context = {
  config: Config;
  rpc: string;
  chain: Chain;
  client: PublicClient;
  addresses: Addresses;
};

export function makeChain(rpc: string): Chain {
  return defineChain({
    id: CHAIN_ID,
    name: "Elysium",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

async function readNamed(client: PublicClient, key: string): Promise<Address> {
  const address = (await client.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: "get",
    args: [registryKey(key)],
  })) as Address;
  if (address === zeroAddress) throw new Error(`registry key "${key}" is unset`);
  return address;
}

export async function loadContext(rpc: string | undefined, opts?: { prompt?: boolean }): Promise<Context> {
  const config = await loadConfig(opts);
  const url = rpc && rpc.length > 0 ? rpc : DEFAULT_RPC;
  const chain = makeChain(url);
  const client = createPublicClient({ chain, transport: http(url) });
  const id = await client.getChainId();
  if (id !== CHAIN_ID) {
    throw new Error(`RPC chain id ${id} is not ${CHAIN_ID}`);
  }
  const code = await client.getCode({ address: REGISTRY });
  if (!code || code === "0x") {
    throw new Error(`no code at registry ${REGISTRY} on chain ${id}`);
  }
  const [factory, router, lens, quoteRegistry] = await Promise.all([
    readNamed(client, "factory"),
    readNamed(client, "router"),
    readNamed(client, "lens"),
    readNamed(client, "quoteRegistry"),
  ]);
  return {
    config,
    rpc: url,
    chain,
    client,
    addresses: { factory, router, lens, quoteRegistry },
  };
}

export async function walletFor(ctx: Context): Promise<{
  account: ReturnType<typeof privateKeyToAccount>;
  wallet: WalletClient;
}> {
  const key = await readPrivateKey(ctx.config.privateKeyPath);
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({
    account,
    chain: ctx.chain,
    transport: http(ctx.rpc),
  });
  return { account, wallet };
}

export async function quoteLabel(ctx: Context, asset: Address): Promise<{ symbol: string; decimals: number }> {
  if (asset === zeroAddress) return { symbol: "HYPE", decimals: 18 };
  try {
    const q = (await ctx.client.readContract({
      address: ctx.addresses.quoteRegistry,
      abi: quoteRegistryAbi,
      functionName: "get",
      args: [asset],
    })) as { exists: boolean; symbol: string; decimals: number };
    if (q.exists && q.symbol) return { symbol: q.symbol, decimals: q.decimals };
  } catch {
    // UnknownAsset: fall through to the bare address.
  }
  return { symbol: asset, decimals: 18 };
}

export async function hookOf(ctx: Context, moduleSetId: bigint): Promise<Address> {
  const mods = (await ctx.client.readContract({
    address: ctx.addresses.factory,
    abi: factoryAbi,
    functionName: "getModuleSet",
    args: [moduleSetId],
  })) as { hook: Address };
  return mods.hook;
}
