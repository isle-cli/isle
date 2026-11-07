#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isAddress, type Address } from "viem";
import { CHAIN_ID, DEFAULT_RPC, loadContext } from "./chain.js";
import { configs } from "./commands/configs.js";
import { launch } from "./commands/launch.js";
import { quote, trade, type Side } from "./commands/market.js";

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`missing ${flag}`);
  return value;
}

function address(value: string, flag: string): Address {
  if (!isAddress(value)) throw new Error(`${flag} is not an address`);
  return value;
}

function side(value: string | undefined): Side {
  if (value === "buy" || value === "sell") return value;
  throw new Error("--side must be buy or sell");
}

function help(): void {
  console.log(`montra-cli  chain ${CHAIN_ID}  rpc ${DEFAULT_RPC}

  montra configs [--rpc URL] [--dry-run]
  montra launch --name --symbol --desc --image --config ID --buy AMOUNT [--rpc URL] [--dry-run]
  montra quote --token ADDR --amount AMOUNT --side buy|sell [--rpc URL] [--dry-run]
  montra buy --token ADDR --amount AMOUNT [--rpc URL] [--dry-run]
  montra sell --token ADDR --amount AMOUNT [--rpc URL] [--dry-run]`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      rpc: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      name: { type: "string" },
      symbol: { type: "string" },
      desc: { type: "string" },
      image: { type: "string" },
      config: { type: "string" },
      buy: { type: "string" },
      token: { type: "string" },
      amount: { type: "string" },
      side: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const command = positionals[0];
  if (values.help || !command) {
    help();
    return;
  }
  const ctx = await loadContext(values.rpc);
  const dryRun = values["dry-run"];
  if (command === "configs") {
    await configs(ctx);
    return;
  }
  if (command === "launch") {
    await launch(ctx, {
      name: required(values.name, "--name"),
      symbol: required(values.symbol, "--symbol"),
      desc: required(values.desc, "--desc"),
      image: required(values.image, "--image"),
      config: required(values.config, "--config"),
      buy: required(values.buy, "--buy"),
      dryRun,
    });
    return;
  }
  if (command === "quote") {
    await quote(
      ctx,
      address(required(values.token, "--token"), "--token"),
      required(values.amount, "--amount"),
      side(values.side),
      dryRun,
    );
    return;
  }
  if (command === "buy" || command === "sell") {
    await trade(
      ctx,
      address(required(values.token, "--token"), "--token"),
      required(values.amount, "--amount"),
      command,
      dryRun,
    );
    return;
  }
  throw new Error(`unknown command ${command}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
