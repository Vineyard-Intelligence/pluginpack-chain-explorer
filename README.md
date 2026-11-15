# Chain Explorer — a Vineyard plugin pack

Keyless blockchain lookups for the Cryptocurrency type pack: no account, no key, no member that asks
for one. Members are tasks, not vendors — "this address's history", "this transaction" — and each one
picks the vendor from the node's `network`, moving to the next vendor when one fails, refuses or
rate-limits.

| `network` | History and transactions, in the order tried | Also |
| --- | --- | --- |
| `bitcoin` | mempool.space → blockstream.info | |
| `litecoin` | litecoinspace.org → SoChain → BlockCypher | |
| `bitcoin_cash` | Haskoin | |
| `dogecoin` | SoChain → BlockCypher | |
| `dash` | BlockCypher → insight.dash.org | |
| `zcash` | SoChain (transparent addresses only) | |
| `ethereum` | Routescan → eth.blockscout.com | deployers (Routescan → Blockscout), labels (Blockscout), USDT/USDC freeze |
| `avalanche_c` | Routescan | deployers |
| `optimism` | explorer.optimism.io (Blockscout) | deployers, labels |
| `bsc` | Binplorer with the shared `freekey` (last 30 days, 100 rows) | |
| `ethereum_classic` | etc.blockscout.com | labels |
| `tron` | TronGrid → Tronscan | first funder, deployers, labels (Tronscan), USDT freeze |
| `solana` | api.mainnet-beta.solana.com → solana-rpc.publicnode.com | |
| `xrpl` | xrplcluster.com → xrpl.ws | first funder and names (XRPSCAN) |
| `ton` | toncenter | |
| `polygon`, `arbitrum`, `base` | none keyless | contract and token (public RPC) |

Every EVM chain is also asked through public JSON-RPC (PublicNode; Blockscout's for Ethereum Classic)
for Identify Crypto Network and Crypto Contract and Token. Monero, Verge, Bitcoin Gold, Bitcoin SV,
Cardano and BNB Beacon Chain are identifiers only: nodes on them are skipped, and the summary says
why.

## Plugins

| Plugin | Takes | Adds |
| --- | --- | --- |
| **Identify Crypto Network** | the selection (any type), or every candidate in the project | For a Crypto Address on `evm` or `unknown`, a legacy Financial `crypto_address` or a payment `web.tracking_id`: a Crypto Address on each network it is decided to be on, in canonical form, linked from the original with `same address on` (or `same as` for a legacy node) and the reason in `basis`. A format that names one network settles it (`bc1…`, `ltc1…`/`L…`/`M…`, TRON `T…` or hex, CashAddr, XRPL `r…` and X-addresses, TON user-friendly); a shared format (`1…`/`3…`, `D…`, `0x…`, raw TON) is decided by asking each network for activity, and linked only once every network it may be on (with a keyless source) has answered: otherwise the summary names the network that did not answer and the next run asks again. An EVM address with no sent transaction, balance or code is "could not decide", not "unused". "Most nodes per run" bounds a sweep, not a selection. The original node is never changed |
| **Crypto Address History** | Crypto Address | Account chains: `sent to` links to and from its counterparties, with `summary_<source>` (per asset: count, total, first, last; with `window_from`, `window_to`, `complete` and the lists read) and, on a new link, the shared `recent` list. Bitcoin family: its transactions as nodes, linked `input to` / `output to` with the amounts and each input and output. On the address: `balance` (`balance_as_of`, `balance_source`), `tx_count`, `first_seen`/`last_seen`, `history_examined`, `history_complete`. A node with a memo is read on the XRP Ledger only, from the payments to its tag, and gets no balance |
| **Crypto Transaction** | Crypto Transaction | `block_height`, `block_time`, `status`, `fee`, `tx_kind`; every address that paid into it `input to` the transaction, every address it paid `output to`, with the amounts. Token amounts whose decimals the source does not give are read from the token, else kept in base units with `base_units: true` |
| **Crypto Activation and First Funder** | Crypto Address (TRON, XRPL), without a memo | `activated_at`, `first_funder`, `first_funding_tx`, and `first_funding` on the funder's `sent to` link |
| **Crypto Contract and Token** | Crypto Address (EVM, TRON, Solana) | `address_kind` (an EIP-7702 delegated wallet stays `eoa`, with `eip7702_delegate`); a Crypto Token (`standard`, `symbol`, `name`, `decimals`) linked `token contract`; `deployer` and `deployment_tx` with a `deployed` link on Ethereum, Avalanche C-Chain, OP Mainnet and TRON |
| **Crypto Public Labels** | Crypto Address (TRON, Ethereum, OP Mainnet, Ethereum Classic, XRPL) | `public_label` and `label_source` from Tronscan, Blockscout or XRPSCAN (with `label_domain`) |
| **Stablecoin Freeze Status** | Crypto Address (Ethereum, TRON) | `frozen_by_issuer` from Tether's `isBlackListed` and Circle's `isBlacklisted`, and `frozen_checked_at` |

Link labels and data keys are the Cryptocurrency type pack's. A pair has one link: an existing link is
amended with this pack's keys and never relabelled. `recent` is merged with the rows a link already
holds, read from the copy of its data the app passes, so a re-run adds to it. Commit replaces a key
whole, so on an older app that passes no link data `recent` is written only on a link this run
creates, and the summary counts the links whose list was left as it was.

## Decisions the code records

- **No key, anywhere.** The app files a key by pack and the set of origins a member calls, so one
  optional key would give this pack a key field per vendor and its page could not say "no key".
  Vendors whose keyed tier only raises limits (TronGrid, Routescan, SoChain, BlockCypher, toncenter)
  are used here without one; a keyed path belongs in a pack of its own.
- **Pacing.** Requests to each vendor are spaced to its published keyless limit (Routescan 2/s,
  toncenter 1/s, the Ethplorer free key 20/min), and a run stops calling a vendor with a small hourly
  budget (BlockCypher 100/h, Binplorer 100/h) after its share, so the next run still has some.
  A 429 is waited out once; a second one, a 403 or a bot-check page hands over to the next vendor
  for the rest of the run. PublicNode's endpoints are refused one chain at a time and spaced as one
  vendor.
- **Identify network, all or nothing.** A node's `same address on` / `same as` links are what tells
  a later sweep it is done, so they are drawn only when every network the address may be on, and
  that has a keyless source, has answered. A node an explorer did not answer for gets no link, and
  the summary says which network went unasked and what activity was seen elsewhere.
- **Solana.** Measured 2026-11-15: api.mainnet-beta.solana.com answers 403 to every request that
  carries an `Origin` header, which every request from the app does. It stays first in the order; a
  run asks it `getHealth` (which names no address) and goes to PublicNode when refused. PublicNode
  keeps recent slots only — two signatures, both from the last day, for a Binance hot wallet with
  years of activity — so a Solana history it serves is never `history_complete`.
- **TRON first funder.** The X-26 rule: TronGrid's `create_time` is the block before the
  activation, so the activation is a payment to the address (or `AccountCreateContract`) in the first
  block after it. Anything else is "could not tell", never the earliest incoming transfer.
  `activated_at` is that block's time, written by First Funder alone: Address History does not copy
  `create_time` into it, and "could not tell" leaves it empty.
- **XRPL destination tags.** A payment to a tagged destination goes to the node (address, memo =
  tag). A node with a memo sees only payments to that tag; an address's own outgoing payments are
  not per tag. The account's balance and activation are not the tag's, so a memo node gets neither,
  and its `first_seen` / `last_seen` are its own payments'.
- **Contract deployers** come from Routescan's `getcontractcreation` (Ethereum, Avalanche C-Chain),
  Blockscout's `creator_address_hash` (Ethereum, OP Mainnet) and TronGrid's `origin_address`, the
  sources the proposal names. BSC, Polygon, Arbitrum and Base need a keyed source.
- **Exact amounts.** Amounts are decimal strings; JSON integers of 16 digits or more are read as
  strings before parsing, so a lamport or wei balance past 2^53 stays exact.

## Terms

The pack page carries the conditions an institutional analyst needs first: Routescan's API licence is
for internal use and its content for information and personal use, commercial decisions need its
written approval, and use that is not private must show "Powered by Routescan.io APIs" (§3.1, §8.3,
§5.1). BlockCypher allows internal use only. SoChain allows use inside one's own application and bars
bulk copying, redistribution and benchmarks. XRPSCAN data is CC BY-NC-SA 4.0. Ethplorer and
Binplorer ask to be credited.

## Build and test

```bash
node build.mjs && git diff --exit-code dist/pack.mjs    # the bundle matches this source
node gen-manifest.mjs                                   # plugins/chain-explorer.manifest.json
node test/pure.test.mjs                                 # encodings, formats, values, rules
node test-plugin.mjs                                    # every scenario replayed from fixtures
node live-test.mjs [scenario …]                         # re-record against the real vendors
```

esbuild is pinned to 0.25.12: later versions declare a class field for each TypeScript parameter
property and change the bytes. The tests check node data against the Cryptocurrency type pack at
`../typepack-cryptocurrency` (or `CRYPTO_TYPEPACK`).

`test/fixtures/` holds the vendors' answers recorded on 2026-11-15 by `live-test.mjs`, trimmed of
keys no member reads (scripts, signatures, ABIs, prices). Every vendor path is in them; the
fallbacks were exercised by answering 429 for the vendor ahead. Two were assembled from curl
captures of the same requests: insight.dash.org's Cloudflare check refuses Node's fetch (its
User-Agent is `node`) and serves curl and browsers. mempool.space could not be reached from the
machine the fixtures were recorded on (TLS reset), so its recorded answer is that failure and the
Bitcoin scenarios show the fallback to blockstream.info, which serves the same Esplora API.

## Licence

Apache-2.0. Source: https://github.com/Vineyard-Intelligence/pluginpack-chain-explorer
