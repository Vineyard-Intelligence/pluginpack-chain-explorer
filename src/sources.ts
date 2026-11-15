// Which vendor serves which network, tried in the order chains.ts lists.
import { CHAINS, HISTORY_ORDER, NATIVE, SOLANA_RPC, XRPL_RPC } from './chains';
import { firstAnswer, VendorDown, type Http } from './http';
import type { AccountHistory, AccountTx, Move, UtxoHistory, UtxoTx } from './model';
import { blockscoutHistory, blockscoutTx, binplorerHistory, binplorerTx, erc20Meta, routescanHistory, routescanTx } from './vendors/evm';
import { tonHistory, tonTx, xrplHistory, xrplTx } from './vendors/ledgers';
import { solanaHistory, solanaNodes, solanaTx } from './vendors/solana';
import { trc20Meta, trongridHistory, trongridTx, tronscanHistory, tronscanTx } from './vendors/tron';
import {
    blockcypherHistory,
    blockcypherTxLookup,
    esploraHistory,
    esploraTxLookup,
    haskoinHistory,
    haskoinTxLookup,
    insightHistory,
    insightTxLookup,
    sochainHistory,
    sochainTxLookup,
} from './vendors/utxo';

export interface Limits {
    /** Pages per list on paged account-chain sources. */
    maxPages: number;
    /** Transactions read on sources that cost a request per transaction (UTXO chains, Solana). */
    maxTxs: number;
}

/** Per-run state the sources share: the Solana health check, token metadata already read. */
export class RunState {
    solana: { done?: boolean } = {};
    readonly tokens = new Map<string, { symbol?: string; decimals?: number; name?: string }>();
}

export const hasSource = (network: string): boolean => !!HISTORY_ORDER[network];

type History = AccountHistory | UtxoHistory;

export async function readHistory(http: Http, state: RunState, network: string, address: string, memo: string | undefined, lim: Limits): Promise<{ history: History; missed: string[] }> {
    const steps = (HISTORY_ORDER[network] ?? []).map((vendor) => ({ vendor, run: () => historyFrom(http, state, vendor, network, address, memo, lim) }));
    const r = await firstAnswer(steps);
    return { history: r.value, missed: r.missed };
}

async function historyFrom(http: Http, state: RunState, vendor: string, network: string, address: string, memo: string | undefined, lim: Limits): Promise<History> {
    switch (vendor) {
        case 'mempool':
        case 'blockstream':
        case 'litecoinspace':
            return esploraHistory(http, network, vendor, address, lim.maxTxs);
        case 'haskoin':
            return haskoinHistory(http, address, lim.maxTxs);
        case 'sochain':
            return sochainHistory(http, network, address, lim.maxTxs);
        case 'blockcypher':
            return blockcypherHistory(http, network, address, lim.maxTxs);
        case 'insight':
            return insightHistory(http, address, lim.maxTxs);
        case 'routescan':
            return routescanHistory(http, network, address, lim.maxPages);
        case 'blockscout_eth':
        case 'blockscout_op':
        case 'blockscout_etc':
            return blockscoutHistory(http, network, address, lim.maxPages);
        case 'binplorer':
            return binplorerHistory(http, address);
        case 'trongrid':
            return trongridHistory(http, address, lim.maxPages);
        case 'tronscan':
            return tronscanHistory(http, address, lim.maxPages);
        case 'solana':
        case 'publicnode_solana':
            return solanaHistory(http, await solanaNode(http, state, vendor), address, lim.maxTxs);
        case 'xrplcluster':
        case 'xrplws':
            return xrplHistory(http, XRPL_RPC.find((n) => n.vendor.id === vendor)!, address, lim.maxPages, memo);
        case 'toncenter':
            return tonHistory(http, address, lim.maxPages);
    }
    throw new Error(`no history reader for ${vendor}`);
}

/** The Solana node `vendor` names, once the run's health check has passed it. */
export async function solanaNode(http: Http, state: RunState, vendor: string): Promise<(typeof SOLANA_RPC)[number]> {
    const node = SOLANA_RPC.find((n) => n.vendor.id === vendor)!;
    if (!(await solanaNodes(http, state.solana)).includes(node)) {
        throw new VendorDown(vendor, `${node.vendor.name}: ${http.refused.get(vendor) ?? 'refused'} earlier in this run`);
    }
    return node;
}

/** Run `fn` on the Solana nodes this run may use, in order, until one answers. */
export async function onSolana<T>(http: Http, state: RunState, fn: (node: (typeof SOLANA_RPC)[number]) => Promise<T>): Promise<T> {
    const nodes = await solanaNodes(http, state.solana);
    return (await firstAnswer(nodes.map((n) => ({ vendor: n.vendor.id, run: () => fn(n) })))).value;
}

type Tx = { kind: 'utxo'; tx: UtxoTx } | { kind: 'account'; tx: AccountTx };

export async function readTx(http: Http, state: RunState, network: string, hash: string): Promise<{ found: Tx | null; vendor: string; missed: string[] }> {
    const steps = (HISTORY_ORDER[network] ?? []).map((vendor) => ({ vendor, run: () => txFrom(http, state, vendor, network, hash) }));
    const r = await firstAnswer(steps);
    if (r.value?.kind === 'account') await fillDecimals(http, state, network, r.value.tx.moves);
    return { found: r.value, vendor: r.vendor, missed: r.missed };
}

const wrapU = (tx: UtxoTx | null): Tx | null => (tx ? { kind: 'utxo', tx } : null);
const wrapA = (tx: AccountTx | null): Tx | null => (tx ? { kind: 'account', tx } : null);

async function txFrom(http: Http, state: RunState, vendor: string, network: string, hash: string): Promise<Tx | null> {
    switch (vendor) {
        case 'mempool':
        case 'blockstream':
        case 'litecoinspace':
            return wrapU(await esploraTxLookup(http, network, vendor, hash));
        case 'haskoin':
            return wrapU(await haskoinTxLookup(http, hash));
        case 'sochain':
            return wrapU(await sochainTxLookup(http, network, hash));
        case 'blockcypher':
            return wrapU(await blockcypherTxLookup(http, network, hash));
        case 'insight':
            return wrapU(await insightTxLookup(http, hash));
        case 'routescan':
            return wrapA(await routescanTx(http, network, hash));
        case 'blockscout_eth':
        case 'blockscout_op':
        case 'blockscout_etc':
            return wrapA(await blockscoutTx(http, network, hash));
        case 'binplorer':
            return wrapA(await binplorerTx(http, hash));
        case 'trongrid':
            return wrapA(await trongridTx(http, hash));
        case 'tronscan':
            return wrapA(await tronscanTx(http, hash));
        case 'solana':
        case 'publicnode_solana':
            return wrapA(await solanaTx(http, await solanaNode(http, state, vendor), hash));
        case 'xrplcluster':
        case 'xrplws':
            return wrapA(await xrplTx(http, XRPL_RPC.find((n) => n.vendor.id === vendor)!, hash));
        case 'toncenter':
            return wrapA(await tonTx(http, hash));
    }
    throw new Error(`no transaction reader for ${vendor}`);
}

/**
 * Token transfers decoded from logs carry no decimals or symbol. Read them from the token (EVM:
 * public JSON-RPC; TRON: TronGrid), once per token per run. A token that does not answer keeps its
 * amount in base units, and the link says so.
 */
export async function fillDecimals(http: Http, state: RunState, network: string, moves: Move[]): Promise<void> {
    const family = CHAINS[network]?.family;
    for (const m of moves) {
        if (m.asset === NATIVE || m.decimals != null) continue;
        if (family !== 'evm' && family !== 'tron') continue;
        if (family === 'tron' && m.asset.startsWith('trc10:')) continue;
        const key = `${network}|${m.asset}`;
        let meta = state.tokens.get(key);
        if (!meta) {
            try {
                meta = family === 'evm' ? await erc20Meta(http, network, m.asset) : await trc20Meta(http, m.asset);
            } catch (e) {
                if (!(e instanceof VendorDown)) throw e;
                meta = {};
            }
            state.tokens.set(key, meta);
        }
        if (meta.decimals !== undefined) m.decimals = meta.decimals;
        if (meta.symbol && !m.symbol) m.symbol = meta.symbol;
    }
}
