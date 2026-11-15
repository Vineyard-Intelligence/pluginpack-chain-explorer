// Networks this pack reads, the keyless vendors it reads them from, and in which order.
//
// Pure and dependency-free so test/pure.test.mjs can import it.
//
// THE ORDER IS THE PROPOSAL'S (X-1, measured 2026-11-14 and again 2026-11-15): the first vendor
// that answers is used, and one that fails, refuses or rate-limits hands over to the next. Every
// vendor here answered a browser origin with `access-control-allow-origin` (* or the origin
// itself), which is why the pack runs in the web app as well as the desktop one.
import type { VendorSpec } from './http';
import type { Chain } from './model';

export const V = {
    mempool: { id: 'mempool', name: 'mempool.space', gapMs: 250 },
    // Blockstream introduced limits on its free tier on 2026-04-22 and meant it for personal and
    // prototype use, so it is the fallback, not the first call.
    blockstream: { id: 'blockstream', name: 'blockstream.info', gapMs: 300 },
    litecoinspace: { id: 'litecoinspace', name: 'litecoinspace.org', gapMs: 250 },
    haskoin: { id: 'haskoin', name: 'Haskoin', gapMs: 250 },
    // 2,500 requests a day per IP (its x-ratelimit-limit header, 2026-11-15). A history costs one
    // request per transaction, so a run keeps to a share of that.
    sochain: { id: 'sochain', name: 'SoChain', gapMs: 350, perRun: 300 },
    // 100 requests an hour and 3 a second without a token (BlockCypher docs).
    blockcypher: { id: 'blockcypher', name: 'BlockCypher', gapMs: 400, perRun: 30 },
    insight: { id: 'insight', name: 'insight.dash.org', gapMs: 300 },
    // Keyless: 2 requests a second, 10,000 a day (Routescan docs).
    routescan: { id: 'routescan', name: 'Routescan', gapMs: 550, perRun: 1500 },
    blockscout_eth: { id: 'blockscout_eth', name: 'eth.blockscout.com', gapMs: 300 },
    blockscout_op: { id: 'blockscout_op', name: 'explorer.optimism.io', gapMs: 300 },
    blockscout_etc: { id: 'blockscout_etc', name: 'etc.blockscout.com', gapMs: 300 },
    // The shared `freekey`: 2 a second, 20 a minute, 100 an hour, 1,000 a day, 100 rows an answer
    // and nothing older than 30 days (Ethplorer API docs, which Binplorer shares).
    binplorer: { id: 'binplorer', name: 'Binplorer', gapMs: 3_100, perRun: 30 },
    // PublicNode serves each chain from its own endpoint, and one endpoint's throttle says nothing
    // about the others: with one id for all of them, a 429 from the Polygon endpoint turned off
    // Ethereum, BSC and Solana for the rest of the run (review of 1.0.0). So each endpoint is
    // refused on its own, and they are spaced as one vendor, since a keyless limit is per IP.
    publicnode_ethereum: { id: 'publicnode_ethereum', name: 'ethereum-rpc.publicnode.com', gapMs: 120, pace: 'publicnode' },
    publicnode_bsc: { id: 'publicnode_bsc', name: 'bsc-rpc.publicnode.com', gapMs: 120, pace: 'publicnode' },
    publicnode_polygon: { id: 'publicnode_polygon', name: 'polygon-bor-rpc.publicnode.com', gapMs: 120, pace: 'publicnode' },
    publicnode_arbitrum: { id: 'publicnode_arbitrum', name: 'arbitrum-one-rpc.publicnode.com', gapMs: 120, pace: 'publicnode' },
    publicnode_optimism: { id: 'publicnode_optimism', name: 'optimism-rpc.publicnode.com', gapMs: 120, pace: 'publicnode' },
    publicnode_base: { id: 'publicnode_base', name: 'base-rpc.publicnode.com', gapMs: 120, pace: 'publicnode' },
    publicnode_avalanche_c: { id: 'publicnode_avalanche_c', name: 'avalanche-c-chain-rpc.publicnode.com', gapMs: 120, pace: 'publicnode' },
    publicnode_solana: { id: 'publicnode_solana', name: 'solana-rpc.publicnode.com', gapMs: 120, pace: 'publicnode' },
    trongrid: { id: 'trongrid', name: 'TronGrid', gapMs: 350 },
    tronscan: { id: 'tronscan', name: 'Tronscan', gapMs: 400 },
    solana: { id: 'solana', name: 'api.mainnet-beta.solana.com', gapMs: 150 },
    xrplcluster: { id: 'xrplcluster', name: 'xrplcluster.com', gapMs: 200 },
    xrplws: { id: 'xrplws', name: 'xrpl.ws', gapMs: 200 },
    xrpscan: { id: 'xrpscan', name: 'XRPSCAN', gapMs: 600 },
    // Keyless: 1 request a second (toncenter docs); 1.1 s apart still met a 429 on 2026-11-15.
    toncenter: { id: 'toncenter', name: 'toncenter', gapMs: 1_300 },
} satisfies Record<string, VendorSpec>;

export const CHAINS: Readonly<Record<string, Chain>> = {
    bitcoin: { network: 'bitcoin', name: 'Bitcoin', native: 'BTC', decimals: 8, family: 'utxo' },
    litecoin: { network: 'litecoin', name: 'Litecoin', native: 'LTC', decimals: 8, family: 'utxo' },
    bitcoin_cash: { network: 'bitcoin_cash', name: 'Bitcoin Cash', native: 'BCH', decimals: 8, family: 'utxo' },
    dogecoin: { network: 'dogecoin', name: 'Dogecoin', native: 'DOGE', decimals: 8, family: 'utxo' },
    dash: { network: 'dash', name: 'Dash', native: 'DASH', decimals: 8, family: 'utxo' },
    zcash: { network: 'zcash', name: 'Zcash', native: 'ZEC', decimals: 8, family: 'utxo' },
    ethereum: { network: 'ethereum', name: 'Ethereum', native: 'ETH', decimals: 18, family: 'evm', chainId: 1 },
    optimism: { network: 'optimism', name: 'OP Mainnet', native: 'ETH', decimals: 18, family: 'evm', chainId: 10 },
    bsc: { network: 'bsc', name: 'BNB Smart Chain', native: 'BNB', decimals: 18, family: 'evm', chainId: 56 },
    ethereum_classic: { network: 'ethereum_classic', name: 'Ethereum Classic', native: 'ETC', decimals: 18, family: 'evm', chainId: 61 },
    polygon: { network: 'polygon', name: 'Polygon PoS', native: 'POL', decimals: 18, family: 'evm', chainId: 137 },
    base: { network: 'base', name: 'Base', native: 'ETH', decimals: 18, family: 'evm', chainId: 8453 },
    arbitrum: { network: 'arbitrum', name: 'Arbitrum One', native: 'ETH', decimals: 18, family: 'evm', chainId: 42161 },
    avalanche_c: { network: 'avalanche_c', name: 'Avalanche C-Chain', native: 'AVAX', decimals: 18, family: 'evm', chainId: 43114 },
    tron: { network: 'tron', name: 'TRON', native: 'TRX', decimals: 6, family: 'tron' },
    solana: { network: 'solana', name: 'Solana', native: 'SOL', decimals: 9, family: 'solana' },
    xrpl: { network: 'xrpl', name: 'XRP Ledger', native: 'XRP', decimals: 6, family: 'xrpl' },
    ton: { network: 'ton', name: 'TON', native: 'TON', decimals: 9, family: 'ton' },
};

/** The `asset` value the type pack's link rules use for a chain's own coin. */
export const NATIVE = 'native';

/** History and transaction sources, in the order tried. */
export const HISTORY_ORDER: Readonly<Record<string, readonly string[]>> = {
    bitcoin: ['mempool', 'blockstream'],
    litecoin: ['litecoinspace', 'sochain', 'blockcypher'],
    bitcoin_cash: ['haskoin'],
    dogecoin: ['sochain', 'blockcypher'],
    dash: ['blockcypher', 'insight'],
    zcash: ['sochain'],
    ethereum: ['routescan', 'blockscout_eth'],
    avalanche_c: ['routescan'],
    optimism: ['blockscout_op'],
    bsc: ['binplorer'],
    ethereum_classic: ['blockscout_etc'],
    tron: ['trongrid', 'tronscan'],
    solana: ['solana', 'publicnode_solana'],
    xrpl: ['xrplcluster', 'xrplws'],
    ton: ['toncenter'],
};

/**
 * Why a network has no keyless source, for the summary. It names no other pack: one that is not
 * listed in the registry leads the analyst nowhere. Polygon, Arbitrum and Base: Blockscout's
 * public explorers for them answer scripts with a Cloudflare check and no other keyless history
 * source was found. The rest are identifiers only (X-13): no public transaction graph (Monero),
 * not researched (Bitcoin SV), or no keyless source a browser may call (Cardano's Koios).
 */
export const NO_SOURCE: Readonly<Record<string, string>> = {
    polygon: 'no keyless source serves Polygon PoS history; it needs a keyed pack',
    arbitrum: 'no keyless source serves Arbitrum One history; it needs a keyed pack',
    base: 'no keyless source serves Base history; it needs a keyed pack',
    monero: 'Monero has no public transaction graph',
    verge: 'no keyless source for Verge',
    bitcoin_gold: 'no keyless source for Bitcoin Gold',
    bitcoin_sv: 'no keyless source for Bitcoin SV in this pack',
    cardano: 'no keyless source for Cardano that a browser may call',
    bnb_beacon: 'BNB Beacon Chain was shut down; no source',
};

/** Why a node is not looked up: its network is not established, or nothing serves it. */
export function noSource(network: string): string {
    if (network === 'evm' || network === 'unknown') {
        return `its network is "${network}", not established yet: run Identify Crypto Network first, or set the network on the node`;
    }
    return NO_SOURCE[network] ?? `"${network}" is not a network the Cryptocurrency type pack names`;
}

/** EIP-155 chain id → public JSON-RPC endpoint. ETC has none on PublicNode; Blockscout's serves it. */
export const RPC: Readonly<Record<string, { url: string; vendor: VendorSpec }>> = {
    ethereum: { url: 'https://ethereum-rpc.publicnode.com', vendor: V.publicnode_ethereum },
    bsc: { url: 'https://bsc-rpc.publicnode.com', vendor: V.publicnode_bsc },
    polygon: { url: 'https://polygon-bor-rpc.publicnode.com', vendor: V.publicnode_polygon },
    arbitrum: { url: 'https://arbitrum-one-rpc.publicnode.com', vendor: V.publicnode_arbitrum },
    optimism: { url: 'https://optimism-rpc.publicnode.com', vendor: V.publicnode_optimism },
    base: { url: 'https://base-rpc.publicnode.com', vendor: V.publicnode_base },
    avalanche_c: { url: 'https://avalanche-c-chain-rpc.publicnode.com', vendor: V.publicnode_avalanche_c },
    ethereum_classic: { url: 'https://etc.blockscout.com/api/eth-rpc', vendor: V.blockscout_etc },
};

/** Blockscout instances by network. */
export const BLOCKSCOUT: Readonly<Record<string, { base: string; vendor: VendorSpec; source: string }>> = {
    ethereum: { base: 'https://eth.blockscout.com/api/v2/', vendor: V.blockscout_eth, source: 'blockscout' },
    optimism: { base: 'https://explorer.optimism.io/api/v2/', vendor: V.blockscout_op, source: 'blockscout' },
    ethereum_classic: { base: 'https://etc.blockscout.com/api/v2/', vendor: V.blockscout_etc, source: 'blockscout' },
};

export const ESPLORA: Readonly<Record<string, { base: string; vendor: VendorSpec }>> = {
    mempool: { base: 'https://mempool.space/api/', vendor: V.mempool },
    blockstream: { base: 'https://blockstream.info/api/', vendor: V.blockstream },
    litecoinspace: { base: 'https://litecoinspace.org/api/', vendor: V.litecoinspace },
};

export const HASKOIN = 'https://api.haskoin.com/bch/';
export const SOCHAIN = 'https://sochain.com/api/v3/';
export const SOCHAIN_CODE: Readonly<Record<string, string>> = { litecoin: 'LTC', dogecoin: 'DOGE', zcash: 'ZEC' };
export const BLOCKCYPHER = 'https://api.blockcypher.com/v1/';
export const BLOCKCYPHER_CODE: Readonly<Record<string, string>> = { litecoin: 'ltc', dogecoin: 'doge', dash: 'dash' };
export const INSIGHT = 'https://insight.dash.org/insight-api/';
export const ROUTESCAN = (chainId: number) => `https://api.routescan.io/v2/network/mainnet/evm/${chainId}/etherscan/api`;
export const BINPLORER = 'https://api.binplorer.com/';
export const TRONGRID = 'https://api.trongrid.io/';
export const TRONSCAN = 'https://apilist.tronscanapi.com/api/';
export const SOLANA_RPC: ReadonlyArray<{ url: string; vendor: VendorSpec; source: string }> = [
    { url: 'https://api.mainnet-beta.solana.com', vendor: V.solana, source: 'solana_rpc' },
    { url: 'https://solana-rpc.publicnode.com', vendor: V.publicnode_solana, source: 'publicnode' },
];
export const XRPL_RPC: ReadonlyArray<{ url: string; vendor: VendorSpec; source: string }> = [
    { url: 'https://xrplcluster.com/', vendor: V.xrplcluster, source: 'xrplcluster' },
    { url: 'https://xrpl.ws/', vendor: V.xrplws, source: 'xrpl_ws' },
];
export const XRPSCAN = 'https://api.xrpscan.com/api/v1/';
export const TONCENTER = 'https://toncenter.com/api/v3/';

/** USDT on TRON, the token whose freeze list Stablecoin freeze status reads there. */
export const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
