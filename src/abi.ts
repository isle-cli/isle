import type { Abi } from "viem";
import registryJson from "./abi/LaunchpadRegistry.json" with { type: "json" };
import factoryJson from "./abi/LaunchFactory.json" with { type: "json" };
import routerJson from "./abi/LaunchRouter.json" with { type: "json" };
import lensJson from "./abi/LaunchLens.json" with { type: "json" };
import quoteRegistryJson from "./abi/QuoteRegistry.json" with { type: "json" };
import hookJson from "./abi/LaunchHook.json" with { type: "json" };
import poolManagerJson from "./abi/PoolManager.json" with { type: "json" };
import tokenJson from "./abi/LaunchToken.json" with { type: "json" };

export const registryAbi = registryJson as Abi;
export const factoryAbi = factoryJson as Abi;
export const routerAbi = routerJson as Abi;
export const lensAbi = lensJson as Abi;
export const quoteRegistryAbi = quoteRegistryJson as Abi;
export const hookAbi = hookJson as Abi;
export const poolManagerAbi = poolManagerJson as Abi;
export const tokenAbi = tokenJson as Abi;

/** Router, hook, and pool manager errors. The docs unwrap in that order. */
export const refusalAbi: Abi = [
  ...routerAbi.filter((item) => item.type === "error"),
  ...hookAbi.filter((item) => item.type === "error"),
  ...poolManagerAbi.filter((item) => item.type === "error"),
  ...factoryAbi.filter((item) => item.type === "error"),
];
