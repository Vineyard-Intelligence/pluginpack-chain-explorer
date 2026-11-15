// Solana through public JSON-RPC: api.mainnet-beta.solana.com, then solana-rpc.publicnode.com.
//
// MEASURED 2026-11-15: api.mainnet-beta.solana.com answers `403 Access forbidden` to every request
// that carries an `Origin` header — any origin, `app://vineyard` included — and serves the same
// request without one. Every request from the app carries one, so in practice the second node
// serves. The order stays the proposal's in case that changes; to learn it without telling the
// foundation's node which address is being looked up, each run first asks it `getHealth`, which
// names nothing, and goes straight to the next node when that is refused.
import { NATIVE, SOLANA_RPC } from '../chains';
import type { Http } from '../http';
import { VendorDown } from '../http';
import type { AccountHistory, AccountTx, Feed, Move } from '../model';
import { countOf, formatUnits, isoTime, str } from '../values';
import { transfersOf } from './solana-transfers';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const LAMPORTS = 9;

type Node = (typeof SOLANA_RPC)[number];

/** The nodes this run may use, in order, after the address-free health check of the first. */
export async function solanaNodes(http: Http, checked: { done?: boolean }): Promise<Node[]> {
    if (!checked.done) {
        checked.done = true;
        const first = SOLANA_RPC[0];
        try {
            const r = await http.post(first.vendor, first.url, { jsonrpc: '2.0', id: 1, method: 'getHealth' });
            if (r?.result !== 'ok') http.giveUp(first.vendor, 'did not report healthy');
        } catch (e) {
            if (!(e instanceof VendorDown)) throw e;
        }
    }
    return SOLANA_RPC.filter((n) => !http.refused.has(n.vendor.id));
}

async function call(http: Http, node: Node, method: string, params: unknown[]): Promise<any> {
    const r = await http.post(node.vendor, node.url, { jsonrpc: '2.0', id: 1, method, params });
    if (!r || typeof r !== 'object') throw new VendorDown(node.vendor.id, `${node.vendor.name}: no JSON-RPC answer`);
    if (r.error) {
        const msg = str(r.error.message) || `error ${r.error.code}`;
        // -32005 / -32429 and "rate" are the node's limits, not an answer about the address.
        if (/rate|limit|too many/i.test(msg) || r.error.code === -32005 || r.error.code === 429 || r.error.code === 403) throw http.giveUp(node.vendor, msg);
        throw new VendorDown(node.vendor.id, `${node.vendor.name}: ${msg}`);
    }
    return r.result;
}

/** Transfers in one getTransaction answer, wallet to wallet. Pure. */
export function solanaMoves(tx: any, focus?: string): Move[] {
    const slot = typeof tx?.slot === 'number' ? tx.slot : 0;
    const time = isoTime(tx?.blockTime);
    const out: Move[] = [];
    for (const t of transfersOf(tx, time, focus).transfers) {
        // A createAccount for a token or program account is its rent, not a payment to a wallet.
        if (t.created_owner !== undefined && t.created_owner !== SYSTEM_PROGRAM) continue;
        out.push({ tx_hash: t.tx_hash, time, order: slot, from: t.from, to: t.to, asset: t.asset, symbol: t.symbol, decimals: t.decimals, raw: t.raw });
    }
    return out;
}

const SIG_PAGE = 100;

/**
 * Signatures newest first, then each transaction (one request each — the public RPC has no
 * batch-by-address call), up to `maxTxs`.
 */
export async function solanaHistory(http: Http, node: Node, address: string, maxTxs: number): Promise<AccountHistory> {
    const sigs: Array<{ signature: string; slot: number; blockTime?: number; err: unknown }> = [];
    let before: string | undefined;
    let complete = false;
    for (;;) {
        const page = await call(http, node, 'getSignaturesForAddress', [address, { limit: SIG_PAGE, ...(before ? { before } : {}) }]);
        if (!Array.isArray(page)) throw new VendorDown(node.vendor.id, `${node.vendor.name}: unexpected answer for the address's signatures`);
        for (const s of page) if (typeof s?.signature === 'string') sigs.push(s);
        if (page.length < SIG_PAGE) {
            complete = true;
            break;
        }
        if (sigs.length >= maxTxs || http.outOfTime) break;
        before = page[page.length - 1].signature;
    }
    const feed: Feed = { name: 'transactions', rows: [], complete: false, oldest: null, examined: 0 };
    let read = 0;
    for (const s of sigs.slice(0, maxTxs)) {
        if (http.outOfTime) break;
        feed.examined++;
        const slot = countOf(s.slot) ?? null;
        if (slot != null && (feed.oldest == null || slot < feed.oldest)) feed.oldest = slot;
        const t = isoTime(s.blockTime);
        if (t && (!feed.newest || t > feed.newest)) feed.newest = t;
        if (t && (!feed.oldestTime || t < feed.oldestTime)) feed.oldestTime = t;
        read++;
        // A failed transaction moves nothing; its fee is not a transfer between parties.
        if (s.err != null) continue;
        const tx = await call(http, node, 'getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
        if (tx) feed.rows.push(...solanaMoves(tx, address));
    }
    // Only a node with the full ledger history can say a list ended. PublicNode keeps recent slots:
    // for a Binance hot wallet with years of activity it returned two signatures, both from the last
    // day, as the whole list (2026-11-15). Its last page proves nothing, so its history is never
    // complete.
    feed.complete = node.source === 'solana_rpc' && complete && read === sigs.length;
    const bal = await call(http, node, 'getBalance', [address]);
    const lamports = countOf(bal?.value) ?? (typeof bal?.value === 'string' && /^\d+$/.test(bal.value) ? bal.value : undefined);
    return {
        kind: 'account',
        source: node.source,
        vendor: node.vendor.name,
        feeds: [feed],
        facts: { balance: lamports !== undefined ? (formatUnits(String(lamports), LAMPORTS) ?? undefined) : undefined },
    };
}

export async function solanaTx(http: Http, node: Node, signature: string): Promise<AccountTx | null> {
    const tx = await call(http, node, 'getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!tx) return null;
    const keys = tx.transaction?.message?.accountKeys;
    const signer = Array.isArray(keys) ? (keys.find((k: any) => k?.signer)?.pubkey ?? (typeof keys[0] === 'string' ? keys[0] : undefined)) : undefined;
    const fee = countOf(tx.meta?.fee);
    return {
        tx_hash: signature,
        // A slot is not a block height (slots without a block are skipped), so it goes in its own key.
        extra: countOf(tx.slot) !== undefined ? { slot: countOf(tx.slot) } : undefined,
        block_time: isoTime(tx.blockTime),
        status: tx.meta?.err == null ? 'success' : 'failed',
        fee: fee !== undefined ? (formatUnits(String(fee), LAMPORTS) ?? undefined) : undefined,
        tx_kind: 'other',
        signer: typeof signer === 'string' ? signer : undefined,
        moves: tx.meta?.err == null ? solanaMoves(tx) : [],
    };
}

/** getAccountInfo, jsonParsed: what kind of account an address is. */
export async function solanaAccount(http: Http, node: Node, address: string): Promise<any | null> {
    const r = await call(http, node, 'getAccountInfo', [address, { encoding: 'jsonParsed' }]);
    return r?.value ?? null;
}

export { NATIVE };
