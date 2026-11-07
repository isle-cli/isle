# Isle

Launch and trade Montra tokens on Elysium. Node 20, TypeScript, viem.

The request named chain **99801**. The registry `0xF1E2FA75422F889e565F3142bdbf60B28dce2aa7` has no code on that chain. Montra's contracts page puts this registry on Elysium mainnet, chain **99901**. This tool uses 99901 and `https://rpc.montramarkets.xyz`.

ABIs are the JSON files from `https://montramarkets.xyz/docs/abis/`, copied into `src/abi/`.

## Install

```sh
cd montra-cli
npm install
npm run build
node dist/index.js --help
```

On first use the CLI asks for a private-key file path and a builder code, then writes `~/.montra/config.json`. `configs` and `quote` do not read the key. `launch`, `buy`, and `sell` do. The key file is one line, 32 bytes hex. The builder code is appended to launch calldata as an ERC-8021 attribution suffix, built with ox and placed after the launch calldata.

`--rpc URL` overrides the default RPC. `--dry-run` prints the full calldata and does not send. A dry-run launch still uploads the image and metadata, because those URIs are fields of the calldata.

## configs

Read every factory row. Print the enabled ones. The config id is whatever the factory returns. Nothing is hard-coded.

```sh
node dist/index.js configs
```

```
id=0 quote=HYPE quoteAsset=0x0000000000000000000000000000000000000000 fee=10000 pips (1%) hook=0x…
```

## launch

```sh
node dist/index.js launch --name Example --symbol EXMPL --desc "What it is." --image ./logo.png --config 0 --buy 0.01 --dry-run
```

`--buy` is a whole-unit amount of that row's quote asset. On a native row the transaction value is `launchFee + firstBuy`. On an ERC-20 row the value is `launchFee` and the factory is approved for the first buy. `supply` is 0, so the row's own supply is used. `firstBuyMinOut` is 0.

A real send (no `--dry-run`) waits for the receipt and prints `token`, `poolId`, and `firstBuyOut` from `TokenLaunched`.

## quote

```sh
node dist/index.js quote --token 0x626d3d7317cd43eaf1e4963fd0ad058684232d35 --amount 0.01 --side buy
```

```
amountOut=233052350282514651759088
```

That token is CERBERUS. A buy whose `effectiveTotalFee` is over 10% (100000 pips) prints a warning on stderr before the quote.

## buy

```sh
node dist/index.js buy --token 0x626d3d7317cd43eaf1e4963fd0ad058684232d35 --amount 0.01 --dry-run
```

Prints the fee breakdown, quotes, sets `minAmountOut` to 1% under that quote, and uses a deadline 300 seconds after the latest block. Native input is sent as value. ERC-20 input is approved to the router. The swap is simulated before it is sent.

## sell

```sh
node dist/index.js sell --token 0x626d3d7317cd43eaf1e4963fd0ad058684232d35 --amount 1000 --dry-run
```

Same path as buy, with the token as the input. A sale the hook refuses comes back as `PastOpening` or `PartialFillRejected` after the wrappers are peeled off. A minimum that the quote no longer clears comes back as `TooLittleReceived`.

## Refusals

`quoteExactIn` wraps the pool's revert in `UnexpectedRevert(bytes)`. The pool manager's quoter uses `UnexpectedRevertBytes(bytes)`. A hook revert is nested in `WrappedError(address,bytes4,bytes,bytes)`. The CLI unwraps those until the inner name and arguments remain. The published ABIs call the bytes wrapper `UnexpectedRevertBytes`, not `UnexpectedWrappedErrorBytes`.

## Reads

| Read | Why |
| --- | --- |
| `eth_chainId` | Refuse an RPC that is not chain 99901. |
| `eth_getCode(registry)` | Refuse a chain where the registry was never deployed. |
| `registry.get("factory")` | Launch and the config menu. |
| `registry.get("router")` | `quoteExactIn` and `swapExactIn`. |
| `registry.get("lens")` | `tokenView` and `feeBreakdown`. |
| `registry.get("quoteRegistry")` | Symbol and decimals of an ERC-20 quote. |
| `factory.configCount` | How many rows exist. |
| `factory.getConfig(id)` | Quote, fee, enabled flag, module set. Ids come from this loop. |
| `factory.getModuleSet(id)` | The hook for that row. |
| `quoteRegistry.get(asset)` | Symbol and decimals when the quote is not native HYPE. |
| `factory.launchFee` | Added to the launch value. |
| `token.allowance` | Skip `approve` when the factory or router already has enough. |
| `token.decimals` | Turn `--amount` and `--buy` into raw units. |
| `lens.tokenView(token)` | Pool key, `quoteIsCurrency0`, `effectiveTotalFee`. |
| `registry.isKnownHook(hook)` | Refuse a pool whose hook Montra does not list. |
| `token.poolId` | The id `feeBreakdown` takes. |
| `lens.feeBreakdown(hook, poolId)` | Printed before every buy and sell. |
| `router.quoteExactIn` | Simulated. Output of `quote`, and the minimum for `buy` and `sell`. |
| `eth_getBlock` | Deadline is the block timestamp plus 300 seconds. |
| `approve` simulation | Required before an approve is sent. |
| `launch` / `swapExactIn` simulation | Required before either transaction is sent. |


## Limitations

- `firstBuyMinOut` is 0, so a launch's first buy has no slippage floor.
- Images and metadata go to a third-party IPFS pinning service; the CLI is only as available as that service.
- The default RPC is a single unofficial endpoint. `--rpc` overrides it.
- `quote` and `buy` trust the hook's `feeBreakdown`; a hook that lies about its fee is not detected.
- No allowance revocation after a trade.



