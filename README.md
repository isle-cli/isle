# Isle

Docs: https://isle-cli.github.io/isle

A command line tool for launching and trading tokens on Montra, on Elysium (chain 99901).

Montra has a web UI. This is the same thing from a terminal, with the parts that matter for a launch tool done properly: every transaction is simulated before it is sent, hook refusals are unwrapped into readable errors, and the fee breakdown is printed before every buy and sell.

Launches made through Isle carry an ERC-8021 attribution suffix, so the launch is credited to the builder code in your config.

## Status

Early. Montra mainnet is live and Isle launches real tokens. The tool is not yet approved as a Montra builder and has no users beyond its author.

## Requirements

Node 20 or newer. An Elysium RPC is built in and can be overridden with `--rpc URL`.

## Install

```sh
git clone https://github.com/isle-cli/isle.git
cd isle
npm install
npm run build
node dist/index.js --help
```

## Configuration

`launch`, `buy` and `sell` need a key. On first use the CLI asks for two values and writes `~/.montra/config.json`:

```json
{ "privateKeyPath": "/home/you/.montra/key", "builderCode": "your-code" }
```

`privateKeyPath` points at a file holding one line, 32 bytes of hex. `builderCode` is your Montra builder code. It is appended to launch calldata as an ERC-8021 attribution suffix, built with ox and placed after the calldata.

`maxSpendHype` is optional. It is a HYPE amount. When the field is absent the cap is 0.05 HYPE. The MCP server refuses a launch or buy whose native value is above it. `bundle` refuses when its total spend is above it, unless `--force` is passed. `configs`, `quote`, `launch`, `buy` and `sell` do not read this field.

`mnemonicPath` is optional and is read only by `bundle`. It points at a BIP-39 mnemonic file. `bundle --new` generates a 12-word phrase with `generateMnemonic` and writes that file with mode `0600`. On Linux, macOS and WSL, run `chmod 600` on the file and check the mode. On Windows, mode `0600` does not keep other users out. Restrict the file to your account. Anyone who can read it can spend the bundle wallets. Wallet index 0 is never derived and never used. The main key in `privateKeyPath` is not an account of this mnemonic.

`configs` and `quote` read neither key and work without a config.

## Commands

### configs

Reads every factory row and prints the enabled ones. Config ids come from the factory, nothing is hard coded.

```sh
node dist/index.js configs
```

```
id=0 quote=HYPE quoteAsset=0x0000000000000000000000000000000000000000 fee=10000 pips (1%) hook=0x6b12...8EC
```

### launch

```sh
node dist/index.js launch --name Example --symbol EXMPL --desc "What it is." --image ./logo.png --config 0 --buy 0.01 --dry-run
```

`--buy` is a whole unit amount of the quote asset of that row. On a native row the transaction value is `launchFee + firstBuy`. On an ERC-20 row the value is `launchFee` and the factory is approved for the first buy. `supply` is 0, so the supply of the row is used. `firstBuyMinOut` is 0.

A real send waits for the receipt and prints `token`, `poolId` and `firstBuyOut` from `TokenLaunched`.

### quote

```sh
node dist/index.js quote --token 0x626d3d7317cd43eaf1e4963fd0ad058684232d35 --amount 0.01 --side buy
```

```
amountOut=233052350282514651759088
```

That token is CERBERUS. A buy whose `effectiveTotalFee` is over 10 percent (100000 pips) prints a warning on stderr before the quote.

### buy

```sh
node dist/index.js buy --token 0x626d3d7317cd43eaf1e4963fd0ad058684232d35 --amount 0.01 --dry-run
```

Prints the fee breakdown, quotes, sets `minAmountOut` to 1 percent under that quote, and uses a deadline 300 seconds after the latest block. Native input is sent as value. ERC-20 input is approved to the router. The swap is simulated before it is sent.

### sell

```sh
node dist/index.js sell --token 0x626d3d7317cd43eaf1e4963fd0ad058684232d35 --amount 1000 --dry-run
```

Same path as buy, with the token as the input. A sale the hook refuses comes back as `PastOpening` or `PartialFillRejected` after the wrappers are peeled off. A minimum the quote no longer clears comes back as `TooLittleReceived`.

### bundle

The bundle is a separate set of wallets. Index 0 on the mnemonic is never derived. Indexes `1..N` come from `mnemonicToAccount(mnemonic, { addressIndex: i })`. `--wallets` is capped at 30. The main key only sends the funding transfers.

```sh
node dist/index.js bundle --new
node dist/index.js bundle plan --wallets 3 --buy 0.002 --dry-run
node dist/index.js bundle fund --wallets 3 --buy 0.002
node dist/index.js bundle launch --wallets 3 --buy 0.002 --name Example --symbol EXMPL --desc "What it is." --image ./logo.png --config 0
node dist/index.js bundle status --wallets 3 --token 0xTOKEN
node dist/index.js bundle sweep --wallets 3 --token 0xTOKEN
```

Fund, then launch. `plan` prints each derived address, `fundingTotal` as `N × (buy + gas estimate)`, and `shortfall` against the main wallet. The shortfall also counts `launchFee` and the gas of the funding transfers, both printed on their own lines. `fund` sends `buy` plus that gas float to every derived wallet, and adds `launchFee` to wallet 1, because wallet 1 pays it. It waits for the receipts, prints each balance, and exits non-zero if any wallet is short.

`launch` sends the launch from wallet 1. The priority fee is `baseFee * 2`. Buys from wallets `2..N` use `baseFee * 1.5`. A buy reverts if the pool does not exist, so the command waits for the launch receipt, waits 400ms, takes a fresh quote, signs every buy, and only then sends them. Signing is finished before the first buy goes out, so signing does not stagger the burst.

Same block is attempted, not guaranteed. The buys are sent together so they can share a block. The chain can still order them apart or put them in later blocks. The launch itself is already mined before that burst.

After the burst, every receipt is polled for up to 30 seconds. The summary table has one row per wallet: status, amount out, or the revert reason. A reverted buy, or one that never left the machine, is retried once. A buy that is still pending when the 30 seconds run out is not sent again. No wallet is left out of the table.

`sweep` sells each wallet's balance of `--token`, with 400ms between sends, and prints the same table. `status` prints the address, the HYPE balance, and the token balance when `--token` is set.

A failed launch simulation is not sent. A wallet under its gas floor stops the command before any send. Spend above `maxSpendHype` stops it too, unless `--force` is passed. `--dry-run` sends nothing. A dry-run launch still uploads metadata, same as `launch`, because the URI is inside the calldata. Progress is printed on stderr. The facts and the table are stdout.

## Safety

- `--dry-run` prints the full calldata and sends nothing. A dry run launch still uploads the image and metadata, because those URIs are fields of the calldata.
- Every approve and every trade is simulated before it is sent.
- `eth_chainId` and `eth_getCode(registry)` guard against an RPC on the wrong chain.

## Refusals

`quoteExactIn` wraps the pool revert in `UnexpectedRevert(bytes)`. The quoter of the pool manager uses `UnexpectedRevertBytes(bytes)`. A hook revert is nested in `WrappedError(address,bytes4,bytes,bytes)`. The CLI unwraps those until the inner name and arguments remain. The published ABIs call the bytes wrapper `UnexpectedRevertBytes`, not `UnexpectedWrappedErrorBytes`.

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
| `eth_getBalance` | Bundle funding, status, and the gas-floor check. |
| `eth_getTransactionCount` | Nonce for each pre-signed bundle buy. |
| `factory.launchFee` | Added to wallet 1's funding and to the launch value. |
| `token.balanceOf` | Bundle status and sweep. |

## Limitations

- `firstBuyMinOut` is 0, so the first buy of a launch has no slippage floor.
- Images and metadata go to a third party IPFS pinning service. The CLI is only as available as that service.
- The default RPC is a single unofficial endpoint. `--rpc` overrides it.
- `quote` and `buy` trust the `feeBreakdown` of the hook. A hook that lies about its fee is not detected.
- No allowance revocation after a trade.
- Linux, macOS and WSL are the tested targets. PowerShell works but the install steps assume a POSIX shell.

## Licence

MIT.
