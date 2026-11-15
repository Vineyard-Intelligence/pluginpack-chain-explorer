// Manifest fragments and run plumbing every Chain Explorer member shares.
import type { GraphNode, GraphScope, HostContext, NetworkScope, PluginManifest, TypeRef } from './sdk';
import { abortErr, OutOfTime, VendorDown, type Http } from './http';
import { CHAINS } from './chains';

export const CRYPTO = 'run.vineyard.typepacks.cryptocurrency';
export const ADDRESS = 'cryptocurrency.crypto_address';
export const TRANSACTION = 'cryptocurrency.crypto_transaction';
export const TOKEN = 'cryptocurrency.crypto_token';
export const crypto = (name: string): TypeRef => ({ typepack: CRYPTO, category: 'cryptocurrency', name });

// Every vendor answered a request from a browser origin with CORS (measured 2026-11-15), so the
// pack runs in the web app and the desktop app alike.
export const PLATFORMS: PluginManifest['platforms'] = {
    primary: 'web',
    web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
    desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
};

export const LIFECYCLE: NonNullable<PluginManifest['lifecycle']> = {
    persistence: 'opt-in',
    controls: ['progress', 'cancel'],
    progress: 'determinate',
};

export const READ_ONLY: GraphScope[] = ['node:read', 'node:update'];
export const WRITES: GraphScope[] = ['node:read', 'node:create', 'node:update', 'edge:read', 'edge:create'];

// ---- network scopes ---------------------------------------------------------------------------
// One endpoint per vendor route rather than bare origins, so the install gate names what is read.
// No key travels anywhere: every request is anonymous.

const get = (endpoint: string, purpose: string): NetworkScope => ({ endpoint, methods: ['GET'], purpose });
const post = (endpoint: string, purpose: string): NetworkScope => ({ endpoint, methods: ['POST'], purpose });

export const E = {
    mempool: get('https://mempool.space/api/', 'Read Bitcoin addresses and transactions from mempool.space.'),
    blockstream: get('https://blockstream.info/api/', 'Read Bitcoin addresses and transactions from blockstream.info when mempool.space does not answer.'),
    litecoinspace: get('https://litecoinspace.org/api/', 'Read Litecoin addresses and transactions from litecoinspace.org.'),
    haskoin: get('https://api.haskoin.com/bch/', 'Read Bitcoin Cash addresses and transactions from Haskoin.'),
    sochain: get('https://sochain.com/api/v3/', 'Read Litecoin, Dogecoin and Zcash addresses and transactions from SoChain.'),
    blockcypher_ltc: get('https://api.blockcypher.com/v1/ltc/main/', 'Read Litecoin addresses and transactions from BlockCypher.'),
    blockcypher_doge: get('https://api.blockcypher.com/v1/doge/main/', 'Read Dogecoin addresses and transactions from BlockCypher.'),
    blockcypher_dash: get('https://api.blockcypher.com/v1/dash/main/', 'Read Dash addresses and transactions from BlockCypher.'),
    insight: get('https://insight.dash.org/insight-api/', 'Read Dash addresses and transactions from insight.dash.org.'),
    routescan_eth: get('https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api', 'Read Ethereum transfers, contract creators and transactions from Routescan.'),
    routescan_avax: get('https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api', 'Read Avalanche C-Chain transfers, contract creators and transactions from Routescan.'),
    blockscout_eth: get('https://eth.blockscout.com/api/v2/', 'Read Ethereum addresses, transfers and labels from Blockscout.'),
    blockscout_op: get('https://explorer.optimism.io/api/v2/', 'Read OP Mainnet addresses, transfers and labels from its Blockscout explorer.'),
    blockscout_etc: get('https://etc.blockscout.com/api/v2/', 'Read Ethereum Classic addresses, transfers and labels from Blockscout.'),
    rpc_etc: post('https://etc.blockscout.com/api/eth-rpc', "Ask Ethereum Classic for an address's activity, code and token metadata through Blockscout's JSON-RPC."),
    binplorer: get('https://api.binplorer.com/', 'Read BNB Smart Chain transfers of the last 30 days from Binplorer, with its shared free key.'),
    rpc_ethereum: post('https://ethereum-rpc.publicnode.com', "Ask Ethereum for an address's activity, code and token metadata (public JSON-RPC)."),
    rpc_bsc: post('https://bsc-rpc.publicnode.com', "Ask BNB Smart Chain for an address's activity, code and token metadata (public JSON-RPC)."),
    rpc_polygon: post('https://polygon-bor-rpc.publicnode.com', "Ask Polygon PoS for an address's activity, code and token metadata (public JSON-RPC)."),
    rpc_arbitrum: post('https://arbitrum-one-rpc.publicnode.com', "Ask Arbitrum One for an address's activity, code and token metadata (public JSON-RPC)."),
    rpc_optimism: post('https://optimism-rpc.publicnode.com', "Ask OP Mainnet for an address's activity, code and token metadata (public JSON-RPC)."),
    rpc_base: post('https://base-rpc.publicnode.com', "Ask Base for an address's activity, code and token metadata (public JSON-RPC)."),
    rpc_avalanche_c: post('https://avalanche-c-chain-rpc.publicnode.com', "Ask Avalanche C-Chain for an address's activity, code and token metadata (public JSON-RPC)."),
    trongrid_v1: get('https://api.trongrid.io/v1/', 'Read TRON accounts and transfers from TronGrid without a key.'),
    trongrid_wallet: post('https://api.trongrid.io/wallet/', 'Read TRON transactions and contracts, and call read-only contract functions, through TronGrid.'),
    tronscan: get('https://apilist.tronscanapi.com/api/', 'Read TRON transfers, transactions and public tags from Tronscan.'),
    solana: post('https://api.mainnet-beta.solana.com', "Read Solana accounts and transactions from the Solana Foundation's public RPC."),
    solana_publicnode: post('https://solana-rpc.publicnode.com', "Read Solana accounts and transactions from PublicNode's RPC."),
    xrplcluster: post('https://xrplcluster.com/', 'Read XRP Ledger accounts and transactions from xrplcluster.com.'),
    xrplws: post('https://xrpl.ws/', 'Read XRP Ledger accounts and transactions from xrpl.ws when xrplcluster.com does not answer.'),
    xrpscan: get('https://api.xrpscan.com/api/v1/', 'Read XRP Ledger account activation and verified names from XRPSCAN.'),
    toncenter: get('https://toncenter.com/api/v3/', 'Read TON accounts, transfers and transactions from toncenter without a key.'),
} as const;

export const EVM_RPC_SCOPES = [E.rpc_ethereum, E.rpc_bsc, E.rpc_polygon, E.rpc_arbitrum, E.rpc_optimism, E.rpc_base, E.rpc_avalanche_c, E.rpc_etc];

// ---- params and selection ---------------------------------------------------------------------

export function intParam(ctx: HostContext, name: string, dflt: number, min: number, max: number): number {
    const v = Number(ctx.params?.[name]);
    return Number.isInteger(v) && v >= min && v <= max ? v : dflt;
}

/** The selected nodes of one type, and how many other nodes were selected. */
export async function selectedOfType(ctx: HostContext, type: string): Promise<{ nodes: GraphNode[]; other: number }> {
    const nodes: GraphNode[] = [];
    let other = 0;
    for (const id of ctx.input?.selection ?? []) {
        if (ctx.signal?.aborted) throw abortErr();
        const n = await ctx.graph?.get?.(id);
        if (n && n.type === type) nodes.push(n);
        else other++;
    }
    return { nodes, other };
}

export function requireNet(ctx: HostContext): void {
    if (!ctx.net?.fetch) throw new Error('This plugin was not granted its network permission');
}

/** "Ethereum" for a node's network, or the raw value. */
export const chainName = (network: string): string => CHAINS[network]?.name ?? network;

// ---- the run's report -------------------------------------------------------------------------

/**
 * Collects what a run did and could not do, so every member's summary reads the same way: what
 * was read, from where, what was skipped and why, which vendors failed, and the requests sent.
 */
// The host's refusals of a value (validate-node.ts): a project whose Cryptocurrency type pack is
// older than the values this pack writes (a network added in a later minor version, say).
const REFUSED = /must be one of|is declared \w+|does not match the format|must be at (?:least|most)/;

export class Report {
    private readonly lines: string[] = [];
    private readonly skips = new Map<string, number>();
    private readonly failures: string[] = [];
    private readonly refusals: string[] = [];
    stopped = '';

    line(s: string): void {
        if (s) this.lines.push(s);
    }

    skip(reason: string): void {
        this.skips.set(reason, (this.skips.get(reason) ?? 0) + 1);
    }

    fail(who: string, why: string): void {
        this.failures.push(`${who}: ${why}`);
    }

    get failed(): number {
        return this.failures.length;
    }

    get skipped(): number {
        return [...this.skips.values()].reduce((a, b) => a + b, 0);
    }

    /**
     * Catch what a node's lookup threw. Cancel and bugs propagate; the end of the run's time stops
     * the loop (returns false); a vendor that did not answer is that node's failure, named.
     */
    caught(e: unknown, who: string, left: number): boolean {
        if (e instanceof OutOfTime) {
            this.stopped = `STOPPED: the run reached its time budget; ${left} node(s) were not looked up — run them again`;
            return false;
        }
        if (e instanceof VendorDown) {
            this.fail(who, e.message);
            return true;
        }
        // A refused write is that node's problem, not the run's: throwing would discard everything
        // already staged for the other nodes (runner.ts).
        if (e instanceof Error && REFUSED.test(e.message)) {
            this.refusals.push(`${who}: ${e.message}`);
            return true;
        }
        throw e;
    }

    text(http: Http): string {
        const parts = [...this.lines];
        for (const [reason, n] of this.skips) parts.push(`${n} skipped: ${reason}`);
        if (this.failures.length) {
            parts.push(`${this.failures.length} not looked up because no source answered (${this.failures.slice(0, 4).join('; ')}${this.failures.length > 4 ? '; …' : ''}) — run them again later`);
        }
        if (this.refusals.length) {
            parts.push(`${this.refusals.length} write(s) refused by the project's type pack (${this.refusals.slice(0, 2).join('; ')}): update the Cryptocurrency type pack in this project, then run again`);
        }
        const used = http.usage();
        if (used) parts.push(`requests: ${used}`);
        if (this.stopped) parts.push(this.stopped);
        return parts.join('. ').replace(/\.\./g, '.') + '.';
    }
}
