import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type Config = {
  privateKeyPath: string;
  builderCode: string;
};

export function configPath(): string {
  return join(homedir(), ".montra", "config.json");
}

export async function loadConfig(): Promise<Config> {
  const path = configPath();
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as Partial<Config>;
    if (typeof parsed.privateKeyPath !== "string" || typeof parsed.builderCode !== "string") {
      throw new Error(`${path} must contain privateKeyPath and builderCode`);
    }
    return { privateKeyPath: parsed.privateKeyPath, builderCode: parsed.builderCode };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const rl = createInterface({ input, output });
  try {
    const privateKeyPath = (await rl.question("private key path: ")).trim();
    const builderCode = (await rl.question("builder code: ")).trim();
    if (!privateKeyPath) throw new Error("private key path is required");
    const config = { privateKeyPath, builderCode };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
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
