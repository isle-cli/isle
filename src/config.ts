import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type Config = {
  privateKeyPath: string;
  builderCode: string;
  /** HYPE cap used by the MCP server. Absent in the file means 0.05. */
  maxSpendHype: number;
};

const DEFAULT_MAX_SPEND_HYPE = 0.05;

/** Absent means the default. A present but unusable value is NaN so the server can refuse it. */
export function parseMaxSpendHype(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_SPEND_HYPE;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return Number.NaN;
}

export function configPath(): string {
  return join(homedir(), ".montra", "config.json");
}

export async function loadConfig(opts?: { prompt?: boolean }): Promise<Config> {
  const path = configPath();
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as {
      privateKeyPath?: unknown;
      builderCode?: unknown;
      maxSpendHype?: unknown;
    };
    if (typeof parsed.privateKeyPath !== "string" || typeof parsed.builderCode !== "string") {
      throw new Error(`${path} must contain privateKeyPath and builderCode`);
    }
    return {
      privateKeyPath: parsed.privateKeyPath,
      builderCode: parsed.builderCode,
      maxSpendHype: parseMaxSpendHype(parsed.maxSpendHype),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (opts?.prompt === false) throw new Error(`${path} is missing`);
  const rl = createInterface({ input, output });
  try {
    const privateKeyPath = (await rl.question("private key path: ")).trim();
    const builderCode = (await rl.question("builder code: ")).trim();
    if (!privateKeyPath) throw new Error("private key path is required");
    const config = { privateKeyPath, builderCode, maxSpendHype: DEFAULT_MAX_SPEND_HYPE };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ privateKeyPath, builderCode }, null, 2) + "\n",
      "utf8",
    );
    return config;
  } finally {
    rl.close();
  }
}

export async function readPrivateKey(path: string): Promise<`0x${string}`> {
  const text = (await readFile(path, "utf8")).trim();
  const hex = text.startsWith("0x") ? text : `0x${text}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${path} is not a 32-byte hex private key`);
  }
  return hex as `0x${string}`;
}
