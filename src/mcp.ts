#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { isAddress, parseUnits, type Address } from "viem";
import * as z from "zod/v4";
import { loadContext, TEN_PERCENT_PIPS } from "./chain.js";
import { listConfigRows } from "./commands/configs.js";
import { runLaunch } from "./commands/launch.js";
import { quoteResult, runTrade, type Side } from "./commands/market.js";
import { explain } from "./errors.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function log(message: string): void {
  console.error(message);
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const parsed = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
  if (!parsed.version) throw new Error("package.json has no version");
  return parsed.version;
}

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

function refusal(err: unknown): ToolResult {
  const message = explain(err).replace(/\s+/g, " ").trim();
  const body = `refusal=${message}`;
  log(body);
  return text(body, true);
}

function address(value: string, name: string): Address {
  if (!isAddress(value)) throw new Error(`${name} is not an address`);
  return value;
}

function server(): McpServer {
  const mcp = new McpServer({ name: "isle", version: packageVersion() });

  mcp.registerTool(
    "list_configs",
    {
      description: "List enabled Montra launch configurations. Read only.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      try {
        const ctx = await loadContext(undefined, { prompt: false });
        const rows = await listConfigRows(ctx);
        if (rows.length === 0) return text("rows=0");
        const body = rows
          .map((row) =>
            [
              `id=${row.id}`,
              `quote=${row.quote}`,
              `quoteAsset=${row.quoteAsset}`,
              `fee=${row.feePips} pips (${row.feePct}%)`,
              `hook=${row.hook}`,
            ].join("\n"),
          )
          .join("\n\n");
        return text(body);
      } catch (err) {
        return refusal(err);
      }
    },
  );

  mcp.registerTool(
    "quote",
    {
      description: "Quote a buy or sell on Montra. Read only. Sends nothing.",
      inputSchema: z
        .object({
          token: z.string().describe("Token address"),
          amount: z.string().describe("Input amount in whole units"),
          side: z.enum(["buy", "sell"]),
        })
        .strict(),
    },
    async ({ token, amount, side }) => {
      try {
        const ctx = await loadContext(undefined, { prompt: false });
        const result = await quoteResult(ctx, address(token, "token"), amount, side as Side);
        const lines = [`amountOut=${result.amountOut}`];
        if (result.effectiveTotalFee > TEN_PERCENT_PIPS) {
          lines.unshift(`warning=effectiveTotalFee is ${result.effectiveTotalFee} pips, over 10%`);
        }
        return text(lines.join("\n"));
      } catch (err) {
        return refusal(err);
      }
    },
  );

  mcp.registerTool(
    "launch",
    {
      description:
        "Launch a token on Montra. send defaults to false: the transaction is simulated and not submitted. Refuses when the native HYPE value exceeds maxSpendHype.",
      inputSchema: z
        .object({
          name: z.string(),
          symbol: z.string(),
          desc: z.string(),
          image_path: z.string().describe("Path to a png, jpeg, webp, or gif on this machine"),
          config_id: z.number().int().describe("Enabled config id from list_configs"),
          buy: z.string().default("0.001").describe("First buy in whole units of the quote asset"),
          send: z.boolean().default(false).describe("Submit the transaction. Default false."),
        })
        .strict(),
    },
    async ({ name, symbol, desc, image_path, config_id, buy, send }) => {
      try {
        const ctx = await loadContext(undefined, { prompt: false });
        const cap = capFrom(ctx);
        const result = await runLaunch(
          ctx,
          { name, symbol, desc, image: image_path, config: String(config_id), buy, dryRun: !send },
          cap,
        );
        if (result.dryRun) {
          const lines = ["send=false"];
          if (result.approveTo && result.approveData) {
            lines.push(`approveTo=${result.approveTo}`, `approveData=${result.approveData}`);
          }
          lines.push(
            `to=${result.to}`,
            `value=${result.value}`,
            `data=${result.data}`,
            `dataSuffix=${result.dataSuffix}`,
          );
          return text(lines.join("\n"));
        }
        if (!result.hash || !result.token || !result.poolId || result.firstBuyOut === undefined) {
          throw new Error(
            result.hash
              ? `launch mined in ${result.hash} but TokenLaunched was not in the receipt`
              : "launch did not return a transaction",
          );
        }
        return text(
          [
            "send=true",
            `hash=${result.hash}`,
            `token=${result.token}`,
            `poolId=${result.poolId}`,
            `firstBuyOut=${result.firstBuyOut}`,
          ].join("\n"),
        );
      } catch (err) {
        return refusal(err);
      }
    },
  );

  mcp.registerTool(
    "buy",
    {
      description:
        "Buy a token on Montra. send defaults to false. Refuses when the HYPE spent exceeds maxSpendHype.",
      inputSchema: tradeInput("Whole units of the input asset"),
    },
    async (args) => tradeTool("buy", args),
  );

  mcp.registerTool(
    "sell",
    {
      description:
        "Sell a token on Montra. send defaults to false. Refuses when native HYPE would be spent above maxSpendHype.",
      inputSchema: tradeInput("Whole units of the token"),
    },
    async (args) => tradeTool("sell", args),
  );

  return mcp;
}

function tradeInput(amount: string) {
  return z
    .object({
      token: z.string().describe("Token address"),
      amount: z.string().describe(amount),
      send: z.boolean().default(false).describe("Submit the transaction. Default false."),
    })
    .strict();
}

function capFrom(ctx: Awaited<ReturnType<typeof loadContext>>): bigint {
  const cap = ctx.config.maxSpendHype;
  if (!Number.isFinite(cap) || cap < 0) {
    throw new Error("maxSpendHype is not a non-negative number");
  }
  let textCap = Number.isInteger(cap) ? String(cap) : cap.toString();
  if (!/^\d+(\.\d+)?$/.test(textCap)) {
    textCap = cap.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
  }
  return parseUnits(textCap, 18);
}

async function tradeTool(
  side: Side,
  args: { token: string; amount: string; send: boolean },
): Promise<ToolResult> {
  try {
    const ctx = await loadContext(undefined, { prompt: false });
    const result = await runTrade(
      ctx,
      address(args.token, "token"),
      args.amount,
      side,
      !args.send,
      capFrom(ctx),
    );
    if (result.dryRun) {
      const lines = [
        "send=false",
        `feeTotal=${result.fee.total}`,
        `feeLp=${result.fee.lp}`,
        `feeProtocol=${result.fee.protocol}`,
        `feeCreator=${result.fee.creator}`,
        `feeEffectiveTotal=${result.fee.effectiveTotal}`,
      ];
      if (result.approveTo && result.approveData) {
        lines.push(`approveTo=${result.approveTo}`, `approveData=${result.approveData}`);
      }
      lines.push(
        `to=${result.to}`,
        `value=${result.value}`,
        `data=${result.data}`,
        `minAmountOut=${result.minAmountOut}`,
        `token=${result.token}`,
        `poolId=${result.poolId}`,
      );
      return text(lines.join("\n"));
    }
    if (!result.hash) throw new Error("trade did not return a transaction");
    const lines = ["send=true", `hash=${result.hash}`, `token=${result.token}`, `poolId=${result.poolId}`];
    if (result.amountOut !== undefined) lines.push(`amountOut=${result.amountOut}`);
    return text(lines.join("\n"));
  } catch (err) {
    return refusal(err);
  }
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server().connect(transport);
}

main().catch((err: unknown) => {
  log(explain(err));
  process.exitCode = 1;
});
