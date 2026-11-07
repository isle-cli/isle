import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Hex,
} from "viem";
import { refusalAbi } from "./abi.js";

const WRAP_BYTES = new Set([
  "UnexpectedRevert",
  "UnexpectedRevertBytes",
]);

export type Refusal = {
  name: string;
  args: readonly unknown[];
  inputs: ReadonlyArray<{ name?: string }>;
};

function isPayload(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length >= 10;
}

/** Innermost custom error, unwrapping UnexpectedRevert, UnexpectedRevertBytes, and nested WrappedError. */
export function decodeRefusal(data: Hex): Refusal {
  let payload = data;
  let last: Refusal = { name: "Unknown", args: [data], inputs: [] };
  for (let depth = 0; depth < 8; depth++) {
    let decoded;
    try {
      decoded = decodeErrorResult({ abi: refusalAbi, data: payload });
    } catch {
      return last.name === "Unknown" ? { name: "Unknown", args: [payload], inputs: [] } : last;
    }
    const args = decoded.args ?? [];
    const inputs = "inputs" in decoded.abiItem ? (decoded.abiItem.inputs ?? []) : [];
    last = {
      name: decoded.errorName,
      args,
      inputs,
    };
    let inner: unknown;
    if (WRAP_BYTES.has(decoded.errorName)) inner = args[0];
    else if (decoded.errorName === "WrappedError") inner = args[2];
    else return last;
    if (!isPayload(inner)) return last;
    payload = inner;
  }
  return last;
}

function formatArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function formatRefusal(data: Hex): string {
  const refusal = decodeRefusal(data);
  if (refusal.inputs.length === 0) return refusal.name;
  const parts = refusal.inputs.map((input, i) => {
    const label = input.name && input.name.length > 0 ? input.name : String(i);
    return `${label}=${formatArg(refusal.args[i])}`;
  });
  return `${refusal.name}(${parts.join(", ")})`;
}

export function rawRevert(err: unknown): Hex | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((item) => item instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.raw) return reverted.raw;
  let found: Hex | null = null;
  err.walk((item) => {
    const data = (item as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      found = data as Hex;
      return true;
    }
    return false;
  });
  return found;
}

export function explain(err: unknown): string {
  const raw = rawRevert(err);
  if (raw) return formatRefusal(raw);
  if (err instanceof Error) return err.message;
  return String(err);
}
