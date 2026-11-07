import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { parseArgs } from "node:util";
import {
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  isAddress,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import { Attribution } from "ox/erc8021";
import { factoryAbi, routerAbi, tokenAbi } from "../abi.js";
import { API, CHAIN_ID, loadContext, walletFor, type Context } from "../chain.js";
import {
  defaultMnemonicPath,
  loadConfig,
  rememberMnemonicPath,
  type Config,
} from "../config.js";
import { explain } from "../errors.js";
import { loadPool, quoteExactIn, zeroForOne } from "./market.js";

/** Wallet index 0 is the mnemonic's first account. It is never derived. */
const MAX_WALLETS = 30;
const LAUNCH_GAS = 3_000_000n;
const BUY_GAS = 800_000n;
const TRANSFER_GAS = 21_000n;
const STAGGER_MS = 400;
const POLL_MS = 30_000;
const DEADLINE_S = 300n;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

type Wallet = {
  index: number;
  account: ReturnType<typeof mnemonicToAccount>;
};

type Fee = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

type Fees = {
  base: bigint;
  launch: Fee;
  buy: Fee;
  gasEstimate: bigint;
  transferGas: bigint;
};

type Row = {
  wallet: number;
  status: string;
  amountOut: string;
  reason: string;
};

type SignedSwap = {
  index: number;
  account: Wallet["account"];
  raw: Hex;
  to: Address;
  data: Hex;
  value: bigint;
};

type PoolView = Awaited<ReturnType<typeof loadPool>>["view"];

function progress(line: string): void {
  console.error(line);
}

function fact(key: string, value: string | number | bigint): void {
  console.log(`${key}=${value}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function oneLine(text: string): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").trim();
  return flat.length > 0 ? flat : "-";
}

function help(): void {
  console.log(`montra bundle --new
  montra bundle plan --wallets N --buy AMOUNT [--dry-run] [--force]
  montra bundle fund --wallets N --buy AMOUNT [--dry-run] [--force]
  montra bundle launch --wallets N --buy AMOUNT --name --symbol --desc --image --config ID [--dry-run] [--force]
  montra bundle status --wallets N [--token ADDR] [--dry-run]
  montra bundle sweep --wallets N --token ADDR [--dry-run] [--force]

Wallet index 0 is never derived. The main key only funds the bundle.`);
}

function walletCount(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error("--wallets must be an integer from 1 to 30");
  const n = Number(value);
  if (n < 1 || n > MAX_WALLETS) throw new Error("--wallets must be an integer from 1 to 30");
  return n;
}

function parseHype(amount: string, flag: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`${flag} is not a HYPE amount`);
  const frac = amount.split(".")[1];
  if (frac && frac.length > 18) throw new Error(`${flag} has more than 18 decimals`);
  return parseUnits(amount, 18);
}

function capWei(config: Config): bigint {
  if (!Number.isFinite(config.maxSpendHype) || config.maxSpendHype < 0) {
    throw new Error("maxSpendHype is not a non-negative number");
  }
  return parseUnits(String(config.maxSpendHype), 18);
}

function assertSpend(config: Config, total: bigint, force: boolean): void {
  if (force) {
    progress("spend cap skipped (--force)");
    return;
  }
  const cap = capWei(config);
  if (total > cap) {
    throw new Error(
      `spend of ${formatUnits(total, 18)} HYPE exceeds maxSpendHype ${formatUnits(cap, 18)}`,
    );
  }
}

function deriveWallets(mnemonic: string, n: number): Wallet[] {
  const wallets: Wallet[] = [];
  for (let index = 1; index <= n; index++) {
    wallets.push({ index, account: mnemonicToAccount(mnemonic, { addressIndex: index }) });
  }
  return wallets;
}

async function loadMnemonic(ctx: Context): Promise<string> {
  const path = ctx.config.mnemonicPath;
  if (!path) throw new Error("mnemonicPath is not set. Run bundle --new");
  let text: string;
  try {
    text = (await readFile(path, "utf8")).trim().replace(/\s+/g, " ");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${path} is missing. Run bundle --new`);
    }
    throw err;
  }
  const count = text.length === 0 ? 0 : text.split(" ").length;
  if (count !== 12 && count !== 24) throw new Error(`${path} is not a 12 or 24 word mnemonic`);
  return text;
}

async function createMnemonic(): Promise<void> {
  const config = await loadConfig();
  const path = config.mnemonicPath ?? defaultMnemonicPath();
  try {
    await readFile(path);
    throw new Error(`${path} already exists`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const phrase = generateMnemonic(english);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, phrase + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch (err) {
    progress(`chmod 600 failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!config.mnemonicPath) await rememberMnemonicPath(path);
  fact("mnemonicPath", path);
  fact("words", phrase.split(" ").length);
  progress(`wrote ${path}. On Unix, run: chmod 600 ${path}`);
}

async function feeSnapshot(ctx: Context, wallets: number): Promise<Fees> {
  const block = await ctx.client.getBlock();
  const raw = block.baseFeePerGas ?? 0n;
  const base = raw > 0n ? raw : 1n;
  const launchPriority = base * 2n;
  const buyPriority = (base * 3n) / 2n;
  const launch = { maxPriorityFeePerGas: launchPriority, maxFeePerGas: base + launchPriority };
  const buy = { maxPriorityFeePerGas: buyPriority, maxFeePerGas: base + buyPriority };
  return {
    base,
    launch,
    buy,
    gasEstimate: LAUNCH_GAS * launch.maxFeePerGas,
    transferGas: TRANSFER_GAS * BigInt(wallets) * (base * 2n),
  };
}

async function launchFeeOf(ctx: Context): Promise<bigint> {
  return (await ctx.client.readContract({
    address: ctx.addresses.factory,
    abi: factoryAbi,
    functionName: "launchFee",
  })) as bigint;
}

async function hypeBalance(ctx: Context, address: Address): Promise<bigint> {
  return ctx.client.getBalance({ address });
}

async function tokenBalance(ctx: Context, token: Address, owner: Address): Promise<bigint> {
  return (await ctx.client.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
}

function blankRows(wallets: Wallet[]): Row[] {
  return wallets.map((wallet) => ({
    wallet: wallet.index,
    status: "unaccounted",
    amountOut: "-",
    reason: "no result",
  }));
}

function setRow(rows: Row[], index: number, status: string, amountOut: string, reason: string): void {
  const row = rows.find((item) => item.wallet === index);
  if (!row) throw new Error(`wallet ${index} is not in the bundle`);
  row.status = status;
  row.amountOut = amountOut;
  row.reason = oneLine(reason);
}

function printTable(rows: Row[]): void {
  console.log("wallet\tstatus\tamountOut\treason");
  for (const row of [...rows].sort((a, b) => a.wallet - b.wallet)) {
    console.log(`${row.wallet}\t${row.status}\t${row.amountOut}\t${row.reason}`);
  }
}

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

async function plan(ctx: Context, n: number, buy: string, dryRun: boolean, force: boolean): Promise<void> {
  const buyWei = parseHype(buy, "--buy");
  const wallets = deriveWallets(await loadMnemonic(ctx), n);
  const fees = await feeSnapshot(ctx, n);
  const launchFee = await launchFeeOf(ctx);
  const fundingEach = buyWei + fees.gasEstimate;
  const fundingTotal = fundingEach * BigInt(n);
  const required = fundingTotal + launchFee + fees.transferGas;
  assertSpend(ctx.config, required, force);
  const { account } = await walletFor(ctx);
  const mainBalance = await hypeBalance(ctx, account.address);
  const gap = required - mainBalance;
  if (dryRun) fact("dryRun", "true");
  for (const wallet of wallets) {
    fact("wallet", wallet.index);
    fact("address", wallet.account.address);
  }
  fact("buy", buyWei);
  fact("gasEstimate", fees.gasEstimate);
  fact("fundingEach", fundingEach);
  fact("fundingTotal", fundingTotal);
  fact("launchFee", launchFee);
  fact("transferGas", fees.transferGas);
  fact("main", account.address);
  fact("mainBalance", mainBalance);
  fact("shortfall", gap > 0n ? gap : 0n);
}

async function fund(ctx: Context, n: number, buy: string, dryRun: boolean, force: boolean): Promise<void> {
  const buyWei = parseHype(buy, "--buy");
  const wallets = deriveWallets(await loadMnemonic(ctx), n);
  const fees = await feeSnapshot(ctx, n);
  const launchFee = await launchFeeOf(ctx);
  const fundingEach = buyWei + fees.gasEstimate;
  const fundingTotal = fundingEach * BigInt(n);
  const required = fundingTotal + launchFee + fees.transferGas;
  assertSpend(ctx.config, required, force);
  const { account, wallet } = await walletFor(ctx);
  const mainBalance = await hypeBalance(ctx, account.address);
  const gap = required > mainBalance ? required - mainBalance : 0n;
  const amounts = wallets.map((item) => ({
    item,
    value: item.index === 1 ? fundingEach + launchFee : fundingEach,
  }));
  if (dryRun) fact("dryRun", "true");
  for (const { item, value } of amounts) {
    fact("wallet", item.index);
    fact("address", item.account.address);
    fact("value", value);
  }
  fact("fundingTotal", fundingTotal);
  fact("launchFee", launchFee);
  fact("transferGas", fees.transferGas);
  fact("main", account.address);
  fact("mainBalance", mainBalance);
  fact("shortfall", gap);
  if (dryRun) return;
  if (gap > 0n) throw new Error(`main balance ${mainBalance} is short of ${required}`);

  progress("funding wallets");
  let nonce = await ctx.client.getTransactionCount({ address: account.address, blockTag: "pending" });
  const sent: Array<{ index: number; hash: Hex; value: bigint; address: Address }> = [];
  for (const { item, value } of amounts) {
    const hash = await wallet.sendTransaction({
      account,
      chain: ctx.chain,
      to: item.account.address,
      value,
      nonce,
      maxFeePerGas: fees.base * 2n,
      maxPriorityFeePerGas: fees.base,
    });
    nonce += 1;
    sent.push({ index: item.index, hash, value, address: item.account.address });
    fact("wallet", item.index);
    fact("hash", hash);
    progress(`funded wallet=${item.index} hash=${hash}`);
  }

  progress("waiting for funding receipts");
  const waits = await Promise.allSettled(
    sent.map(async (item) => {
      const receipt = await ctx.client.waitForTransactionReceipt({ hash: item.hash, timeout: 120_000 });
      return { item, receipt };
    }),
  );
  const funded: Array<{ index: number; value: bigint; address: Address }> = [];
  const failed: string[] = [];
  for (let i = 0; i < waits.length; i++) {
    const result = waits[i];
    const item = sent[i];
    if (!result || !item) continue;
    if (result.status === "rejected") {
      failed.push(`wallet ${item.index} ${item.hash} ${explain(result.reason)}`);
      continue;
    }
    if (result.value.receipt.status !== "success") {
      failed.push(`wallet ${item.index} reverted in ${item.hash}`);
      continue;
    }
    funded.push(item);
  }

  console.log("wallet\tbalance\trequired\tstatus");
  let short = false;
  for (const item of sent) {
    const landed = funded.some((row) => row.index === item.index);
    const balance = await hypeBalance(ctx, item.address);
    const status = !landed ? "failed" : balance < item.value ? "short" : "ok";
    if (status !== "ok") short = true;
    console.log(`${item.index}\t${balance}\t${item.value}\t${status}`);
  }
  if (failed.length > 0 || short) {
    throw new Error(failed.length > 0 ? failed.join("; ") : "a funded wallet is short");
  }
}

type BuiltLaunch = {
  params: {
    name: string;
    symbol: string;
    metadataURI: string;
    profile: {
      logo: string;
      description: string;
      socials: { telegram: string; twitter: string; discord: string; website: string; extra: string };
    };
    configId: bigint;
    supply: bigint;
    salt: Hex;
    feeRecipients: Address[];
    feeShares: number[];
    firstBuyAmount: bigint;
    firstBuyMinOut: bigint;
    permit: { deadline: bigint; v: number; r: Hex; s: Hex };
  };
  value: bigint;
  data: Hex;
  dataSuffix: Hex;
};

async function buildLaunch(
  ctx: Context,
  flags: { name: string; symbol: string; desc: string; image: string; config: string; buy: string },
  buyWei: bigint,
): Promise<BuiltLaunch> {
  const contentType = IMAGE_TYPES[extname(flags.image).toLowerCase()];
  if (!contentType) throw new Error("image must be png, jpeg, webp, or gif");
  if (!/^\d+$/.test(flags.config)) throw new Error("--config must be an integer");
  const configId = BigInt(flags.config);
  const row = (await ctx.client.readContract({
    address: ctx.addresses.factory,
    abi: factoryAbi,
    functionName: "getConfig",
    args: [configId],
  })) as { quote: Address; enabled: boolean };
  if (!row.enabled) throw new Error(`config ${configId} is not enabled`);
  if (row.quote !== zeroAddress) throw new Error("bundle launch requires a native HYPE quote");

  progress("uploading metadata");
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
  const launchFee = await launchFeeOf(ctx);
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
    firstBuyAmount: buyWei,
    firstBuyMinOut: 0n,
    permit: { deadline: 0n, v: 0, r: zeroHash, s: zeroHash },
  };
  const value = launchFee + buyWei;
  const data = encodeFunctionData({ abi: factoryAbi, functionName: "launch", args: [params] });
  const dataSuffix = Attribution.toDataSuffix({ codes: [ctx.config.builderCode] });
  return { params, value, data, dataSuffix };
}

async function signSwap(
  ctx: Context,
  wallet: Wallet,
  view: PoolView,
  side: "buy" | "sell",
  amountIn: bigint,
  minAmountOut: bigint,
  deadline: bigint,
  fee: Fee,
): Promise<SignedSwap> {
  const value = side === "buy" ? amountIn : 0n;
  const exact = {
    key: view.key,
    zeroForOne: zeroForOne(view, side),
    amountIn,
    minAmountOut,
    recipient: wallet.account.address,
    deadline,
  };
  const data = encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [exact] });
  let gas: bigint;
  try {
    const simulated = await ctx.client.simulateContract({
      address: ctx.addresses.router,
      abi: routerAbi,
      functionName: "swapExactIn",
      args: [exact],
      value,
      account: wallet.account,
    });
    gas = simulated.request.gas ?? BUY_GAS;
  } catch (err) {
    throw new Error(explain(err));
  }
  const nonce = await ctx.client.getTransactionCount({
    address: wallet.account.address,
    blockTag: "pending",
  });
  const raw = await wallet.account.signTransaction({
    type: "eip1559",
    chainId: CHAIN_ID,
    nonce,
    to: ctx.addresses.router,
    data,
    value,
    gas,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
  });
  return { index: wallet.index, account: wallet.account, raw, to: ctx.addresses.router, data, value };
}

function swappedAmount(receipt: TransactionReceipt): string | undefined {
  const logs = parseEventLogs({
    abi: routerAbi,
    eventName: "Swapped",
    logs: receipt.logs,
  }) as unknown as Array<{ args: { amountOut: bigint } }>;
  const amount = logs[0]?.args.amountOut;
  return amount === undefined ? undefined : amount.toString();
}

async function revertReason(
  ctx: Context,
  receipt: TransactionReceipt,
  tx: { to: Address; data: Hex; value: bigint; account: Address },
): Promise<string> {
  if (receipt.status === "success") return "-";
  try {
    await ctx.client.call({
      account: tx.account,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      blockNumber: receipt.blockNumber,
    });
    return "reverted";
  } catch (err) {
    return oneLine(explain(err));
  }
}

async function pollReceipts(
  ctx: Context,
  items: Array<{ index: number; hash: Hex }>,
): Promise<Map<number, TransactionReceipt>> {
  const pending = new Map(items.map((item) => [item.index, item.hash]));
  const found = new Map<number, TransactionReceipt>();
  const deadline = Date.now() + POLL_MS;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const [index, hash] of [...pending]) {
      try {
        const receipt = await ctx.client.getTransactionReceipt({ hash });
        found.set(index, receipt);
        pending.delete(index);
        progress(`receipt wallet=${index} status=${receipt.status}`);
      } catch {
        // Not mined yet.
      }
    }
    if (pending.size > 0) await sleep(STAGGER_MS);
  }
  return found;
}

async function quoteBuy(
  ctx: Context,
  token: Address,
  buyWei: bigint,
): Promise<{ view: PoolView; minAmountOut: bigint; quoted: bigint }> {
  const { view } = await loadPool(ctx, token);
  const quoted = await quoteExactIn(ctx, view, "buy", buyWei);
  return { view, quoted, minAmountOut: (quoted * 99n) / 100n };
}

async function blastBuys(
  ctx: Context,
  buyers: Wallet[],
  token: Address,
  buyWei: bigint,
  rows: Row[],
): Promise<void> {
  // The launch receipt is already in. Buys revert until the pool exists, so
  // the quote is taken after that, and every buy is signed before the first send.
  const fees = await feeSnapshot(ctx, buyers.length);
  progress(
    `buy priorityFee=${fees.buy.maxPriorityFeePerGas} maxFee=${fees.buy.maxFeePerGas}`,
  );
  const block = await ctx.client.getBlock();
  const deadline = block.timestamp + DEADLINE_S;
  let prepared: { view: PoolView; minAmountOut: bigint; quoted: bigint };
  try {
    prepared = await quoteBuy(ctx, token, buyWei);
  } catch (err) {
    const reason = explain(err);
    for (const buyer of buyers) setRow(rows, buyer.index, "reverted", "-", reason);
    await retryBuys(ctx, buyers, token, buyWei, rows);
    return;
  }
  fact("quoteAmountOut", prepared.quoted);
  fact("minAmountOut", prepared.minAmountOut);

  const signed: SignedSwap[] = [];
  for (const buyer of buyers) {
    try {
      signed.push(
        await signSwap(ctx, buyer, prepared.view, "buy", buyWei, prepared.minAmountOut, deadline, fees.buy),
      );
    } catch (err) {
      setRow(rows, buyer.index, "reverted", "-", explain(err));
    }
  }
  progress(`blasting ${signed.length} buys`);
  const sent: Array<{ tx: SignedSwap; hash: Hex }> = [];
  const results = await Promise.allSettled(
    signed.map(async (tx) => {
      const hash = await ctx.client.sendRawTransaction({ serializedTransaction: tx.raw });
      return { tx, hash };
    }),
  );
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const tx = signed[i];
    if (!result || !tx) continue;
    if (result.status === "rejected") {
      setRow(rows, tx.index, "unsent", "-", explain(result.reason));
      continue;
    }
    sent.push(result.value);
    fact("wallet", tx.index);
    fact("hash", result.value.hash);
  }
  await settleSwaps(ctx, sent, rows);
  await retryBuys(ctx, buyers, token, buyWei, rows);
}

async function settleSwaps(
  ctx: Context,
  sent: Array<{ tx: SignedSwap; hash: Hex }>,
  rows: Row[],
): Promise<void> {
  if (sent.length === 0) return;
  progress(`polling ${sent.length} receipts`);
  const receipts = await pollReceipts(
    ctx,
    sent.map((item) => ({ index: item.tx.index, hash: item.hash })),
  );
  for (const item of sent) {
    const receipt = receipts.get(item.tx.index);
    if (!receipt) {
      setRow(rows, item.tx.index, "pending", "-", "receipt not mined within 30s");
      continue;
    }
    if (receipt.status === "success") {
      setRow(rows, item.tx.index, "success", swappedAmount(receipt) ?? "-", "-");
      continue;
    }
    const reason = await revertReason(ctx, receipt, {
      to: item.tx.to,
      data: item.tx.data,
      value: item.tx.value,
      account: item.tx.account.address,
    });
    setRow(rows, item.tx.index, "reverted", "-", reason);
  }
}

async function retryBuys(
  ctx: Context,
  buyers: Wallet[],
  token: Address,
  buyWei: bigint,
  rows: Row[],
): Promise<void> {
  const failed = buyers.filter((buyer) => {
    const row = rows.find((item) => item.wallet === buyer.index);
    return row?.status === "reverted" || row?.status === "unsent";
  });
  if (failed.length === 0) return;
  progress(`retrying ${failed.map((buyer) => buyer.index).join(",")}`);
  const fees = await feeSnapshot(ctx, failed.length);
  const block = await ctx.client.getBlock();
  const deadline = block.timestamp + DEADLINE_S;
  let prepared: { view: PoolView; minAmountOut: bigint };
  try {
    prepared = await quoteBuy(ctx, token, buyWei);
  } catch (err) {
    const reason = `retry ${explain(err)}`;
    for (const buyer of failed) setRow(rows, buyer.index, "reverted", "-", reason);
    return;
  }
  const signed: SignedSwap[] = [];
  for (const buyer of failed) {
    try {
      signed.push(
        await signSwap(ctx, buyer, prepared.view, "buy", buyWei, prepared.minAmountOut, deadline, fees.buy),
      );
      fact("retry", buyer.index);
    } catch (err) {
      setRow(rows, buyer.index, "reverted", "-", `retry ${explain(err)}`);
    }
  }
  const sent: Array<{ tx: SignedSwap; hash: Hex }> = [];
  const results = await Promise.allSettled(
    signed.map(async (tx) => {
      const hash = await ctx.client.sendRawTransaction({ serializedTransaction: tx.raw });
      return { tx, hash };
    }),
  );
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const tx = signed[i];
    if (!result || !tx) continue;
    if (result.status === "rejected") {
      setRow(rows, tx.index, "reverted", "-", `retry ${explain(result.reason)}`);
      continue;
    }
    sent.push(result.value);
    fact("wallet", tx.index);
    fact("hash", result.value.hash);
  }
  await settleSwaps(ctx, sent, rows);
}

async function launchBundle(
  ctx: Context,
  n: number,
  flags: { name: string; symbol: string; desc: string; image: string; config: string; buy: string },
  dryRun: boolean,
  force: boolean,
): Promise<void> {
  const buyWei = parseHype(flags.buy, "--buy");
  const wallets = deriveWallets(await loadMnemonic(ctx), n);
  const launcher = wallets.find((wallet) => wallet.index === 1);
  if (!launcher) throw new Error("wallet 1 was not derived");
  const buyers = wallets.filter((wallet) => wallet.index >= 2);
  const fees = await feeSnapshot(ctx, n);
  const launchFee = await launchFeeOf(ctx);
  const spend = launchFee + buyWei * BigInt(n) + fees.gasEstimate * BigInt(n);
  assertSpend(ctx.config, spend, force);

  const buyFloor = BUY_GAS * fees.buy.maxFeePerGas;
  for (const wallet of wallets) {
    const balance = await hypeBalance(ctx, wallet.account.address);
    const floor = wallet.index === 1 ? fees.gasEstimate : buyFloor;
    const need = wallet.index === 1 ? launchFee + buyWei + floor : buyWei + floor;
    if (balance < floor) {
      throw new Error(`wallet ${wallet.index} balance ${balance} is below the gas floor ${floor}`);
    }
    if (balance < need) {
      throw new Error(`wallet ${wallet.index} balance ${balance} is short of ${need}`);
    }
  }

  const built = await buildLaunch(ctx, flags, buyWei);
  progress("simulating launch");
  let gasLimit = LAUNCH_GAS;
  try {
    const simulated = await ctx.client.simulateContract({
      address: ctx.addresses.factory,
      abi: factoryAbi,
      functionName: "launch",
      args: [built.params],
      dataSuffix: built.dataSuffix,
      value: built.value,
      account: launcher.account,
    });
    if (simulated.request.gas) gasLimit = simulated.request.gas;
  } catch (err) {
    throw new Error(`launch simulation failed: ${explain(err)}`);
  }
  const gasCost = gasLimit * fees.launch.maxFeePerGas;
  const launcherBalance = await hypeBalance(ctx, launcher.account.address);
  if (launcherBalance < gasCost) {
    throw new Error(`wallet 1 balance ${launcherBalance} is below the gas floor ${gasCost}`);
  }
  if (launcherBalance < built.value + gasCost) {
    throw new Error(`wallet 1 balance ${launcherBalance} is short of ${built.value + gasCost}`);
  }

  const rows = blankRows(wallets);
  if (dryRun) {
    fact("dryRun", "true");
    for (const wallet of wallets) {
      fact("wallet", wallet.index);
      fact("address", wallet.account.address);
    }
    fact("to", ctx.addresses.factory);
    fact("value", built.value);
    fact("data", built.data);
    fact("dataSuffix", built.dataSuffix);
    fact("launchPriority", fees.launch.maxPriorityFeePerGas);
    fact("buyPriority", fees.buy.maxPriorityFeePerGas);
    for (const wallet of wallets) {
      setRow(rows, wallet.index, "dry-run", "-", wallet.index === 1 ? "launch not sent" : "buy not sent");
    }
    printTable(rows);
    return;
  }

  progress(
    `sending launch priorityFee=${fees.launch.maxPriorityFeePerGas} maxFee=${fees.launch.maxFeePerGas}`,
  );
  const client = createWalletClient({
    account: launcher.account,
    chain: ctx.chain,
    transport: http(ctx.rpc),
  });
  const hash = await client.writeContract({
    address: ctx.addresses.factory,
    abi: factoryAbi,
    functionName: "launch",
    args: [built.params],
    dataSuffix: built.dataSuffix,
    value: built.value,
    account: launcher.account,
    chain: ctx.chain,
    gas: gasLimit,
    maxFeePerGas: fees.launch.maxFeePerGas,
    maxPriorityFeePerGas: fees.launch.maxPriorityFeePerGas,
  });
  fact("wallet", 1);
  fact("hash", hash);
  progress(`waiting for launch ${hash}`);
  const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") {
    const reason = await revertReason(ctx, receipt, {
      to: ctx.addresses.factory,
      data: built.data,
      value: built.value,
      account: launcher.account.address,
    });
    setRow(rows, 1, "reverted", "-", reason);
    for (const buyer of buyers) setRow(rows, buyer.index, "unsent", "-", "launch reverted");
    printTable(rows);
    throw new Error(`launch reverted: ${reason}`);
  }
  const logs = parseEventLogs({
    abi: factoryAbi,
    eventName: "TokenLaunched",
    logs: receipt.logs,
  }) as unknown as Array<{ args: { token: Address; poolId: Hex; firstBuyOut: bigint } }>;
  const launched = logs[0];
  if (!launched) {
    setRow(rows, 1, "reverted", "-", "TokenLaunched was not in the receipt");
    for (const buyer of buyers) setRow(rows, buyer.index, "unsent", "-", "TokenLaunched missing");
    printTable(rows);
    throw new Error(`launch mined in ${hash} but TokenLaunched was not in the receipt`);
  }
  fact("token", launched.args.token);
  fact("poolId", launched.args.poolId);
  fact("firstBuyOut", launched.args.firstBuyOut);
  setRow(rows, 1, "launched", launched.args.firstBuyOut.toString(), "-");
  if (buyers.length === 0) {
    printTable(rows);
    return;
  }
  progress("launch mined, sleeping 400ms");
  await sleep(STAGGER_MS);
  await blastBuys(ctx, buyers, launched.args.token, buyWei, rows);
  printTable(rows);
  const missing = rows.filter((row) => row.status === "unaccounted");
  if (missing.length > 0) {
    throw new Error(`unaccounted wallets: ${missing.map((row) => row.wallet).join(",")}`);
  }
}

async function status(ctx: Context, n: number, token: Address | undefined, dryRun: boolean): Promise<void> {
  const wallets = deriveWallets(await loadMnemonic(ctx), n);
  if (dryRun) fact("dryRun", "true");
  for (const wallet of wallets) {
    fact("wallet", wallet.index);
    fact("address", wallet.account.address);
    fact("hype", await hypeBalance(ctx, wallet.account.address));
    if (token) fact("token", await tokenBalance(ctx, token, wallet.account.address));
  }
}

async function ensureAllowance(
  ctx: Context,
  wallet: Wallet,
  token: Address,
  amount: bigint,
  dryRun: boolean,
): Promise<void> {
  const allowance = (await ctx.client.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "allowance",
    args: [wallet.account.address, ctx.addresses.router],
  })) as bigint;
  if (allowance >= amount) return;
  try {
    await ctx.client.simulateContract({
      address: token,
      abi: tokenAbi,
      functionName: "approve",
      args: [ctx.addresses.router, amount],
      account: wallet.account,
    });
  } catch (err) {
    throw new Error(explain(err));
  }
  const data = encodeFunctionData({
    abi: tokenAbi,
    functionName: "approve",
    args: [ctx.addresses.router, amount],
  });
  fact("wallet", wallet.index);
  fact("approveData", data);
  if (dryRun) return;
  const client = createWalletClient({
    account: wallet.account,
    chain: ctx.chain,
    transport: http(ctx.rpc),
  });
  const hash = await client.writeContract({
    address: token,
    abi: tokenAbi,
    functionName: "approve",
    args: [ctx.addresses.router, amount],
    account: wallet.account,
    chain: ctx.chain,
  });
  fact("hash", hash);
  progress(`approve wallet=${wallet.index} hash=${hash}`);
  const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`approve for wallet ${wallet.index} reverted`);
}

async function sweep(
  ctx: Context,
  n: number,
  token: Address,
  dryRun: boolean,
  force: boolean,
): Promise<void> {
  const wallets = deriveWallets(await loadMnemonic(ctx), n);
  const fees = await feeSnapshot(ctx, n);
  const floor = BUY_GAS * fees.buy.maxFeePerGas;
  assertSpend(ctx.config, floor * BigInt(n), force);
  for (const wallet of wallets) {
    const balance = await hypeBalance(ctx, wallet.account.address);
    if (balance < floor) {
      throw new Error(`wallet ${wallet.index} balance ${balance} is below the gas floor ${floor}`);
    }
  }
  const { view } = await loadPool(ctx, token);
  const rows = blankRows(wallets);
  const sales: Array<{ wallet: Wallet; amount: bigint }> = [];
  if (dryRun) fact("dryRun", "true");
  for (const wallet of wallets) {
    const amount = await tokenBalance(ctx, token, wallet.account.address);
    fact("wallet", wallet.index);
    fact("address", wallet.account.address);
    fact("balance", amount);
    if (amount === 0n) {
      setRow(rows, wallet.index, "empty", "0", "-");
      continue;
    }
    sales.push({ wallet, amount });
  }
  for (const sale of sales) {
    try {
      await ensureAllowance(ctx, sale.wallet, token, sale.amount, dryRun);
    } catch (err) {
      setRow(rows, sale.wallet.index, "reverted", "-", explain(err));
    }
  }
  const open = sales.filter((sale) => rows.find((row) => row.wallet === sale.wallet.index)?.status === "unaccounted");
  const ready: SignedSwap[] = [];
  for (const sale of open) {
    try {
      const block = await ctx.client.getBlock();
      const quoted = await quoteExactIn(ctx, view, "sell", sale.amount);
      const minAmountOut = (quoted * 99n) / 100n;
      const tx = await signSwap(
        ctx,
        sale.wallet,
        view,
        "sell",
        sale.amount,
        minAmountOut,
        block.timestamp + DEADLINE_S,
        fees.buy,
      );
      if (dryRun) {
        fact("wallet", sale.wallet.index);
        fact("to", tx.to);
        fact("value", tx.value);
        fact("data", tx.data);
        fact("minAmountOut", minAmountOut);
        setRow(rows, sale.wallet.index, "dry-run", "-", "sell not sent");
        continue;
      }
      ready.push(tx);
    } catch (err) {
      setRow(rows, sale.wallet.index, "reverted", "-", explain(err));
    }
  }
  const sent: Array<{ tx: SignedSwap; hash: Hex }> = [];
  for (let i = 0; i < ready.length; i++) {
    const tx = ready[i];
    if (!tx) continue;
    if (i > 0) {
      progress("sleeping 400ms");
      await sleep(STAGGER_MS);
    }
    try {
      const hash = await ctx.client.sendRawTransaction({ serializedTransaction: tx.raw });
      sent.push({ tx, hash });
      fact("wallet", tx.index);
      fact("hash", hash);
      progress(`sell wallet=${tx.index} hash=${hash}`);
    } catch (err) {
      setRow(rows, tx.index, "reverted", "-", explain(err));
    }
  }
  if (!dryRun) await settleSwaps(ctx, sent, rows);
  printTable(rows);
  const missing = rows.filter((row) => row.status === "unaccounted");
  if (missing.length > 0) {
    throw new Error(`unaccounted wallets: ${missing.map((row) => row.wallet).join(",")}`);
  }
}

export async function bundle(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      rpc: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      wallets: { type: "string" },
      buy: { type: "string" },
      name: { type: "string" },
      symbol: { type: "string" },
      desc: { type: "string" },
      image: { type: "string" },
      config: { type: "string" },
      token: { type: "string" },
      new: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const sub = positionals[0];
  if (values.help || (!sub && !values.new)) {
    help();
    return;
  }
  if (positionals.length > 1) throw new Error(`unknown argument ${positionals[1]}`);
  if (values.new) {
    await createMnemonic();
    if (!sub) return;
  }
  const known = new Set(["plan", "fund", "launch", "status", "sweep"]);
  if (!sub || !known.has(sub)) throw new Error(`unknown bundle command ${sub ?? ""}`.trim());
  const n = walletCount(values.wallets);
  if ((sub === "plan" || sub === "fund" || sub === "launch") && !values.buy) throw new Error("missing --buy");
  if (sub === "launch") {
    for (const flag of ["name", "symbol", "desc", "image", "config"] as const) {
      if (!values[flag]) throw new Error(`missing --${flag}`);
    }
  }
  if (sub === "sweep" && !values.token) throw new Error("missing --token");
  let token: Address | undefined;
  if (values.token) {
    if (!isAddress(values.token)) throw new Error("--token is not an address");
    token = values.token;
  }
  const ctx = await loadContext(values.rpc);
  const dryRun = values["dry-run"];
  const force = values.force;
  if (sub === "plan") {
    await plan(ctx, n, values.buy ?? "", dryRun, force);
    return;
  }
  if (sub === "fund") {
    await fund(ctx, n, values.buy ?? "", dryRun, force);
    return;
  }
  if (sub === "launch") {
    await launchBundle(
      ctx,
      n,
      {
        name: values.name ?? "",
        symbol: values.symbol ?? "",
        desc: values.desc ?? "",
        image: values.image ?? "",
        config: values.config ?? "",
        buy: values.buy ?? "",
      },
      dryRun,
      force,
    );
    return;
  }
  if (sub === "status") {
    await status(ctx, n, token, dryRun);
    return;
  }
  if (!token) throw new Error("missing --token");
  await sweep(ctx, n, token, dryRun, force);
}
