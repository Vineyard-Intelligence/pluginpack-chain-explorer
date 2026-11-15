// Bitcoin-family vendors: Esplora (mempool.space, blockstream.info, litecoinspace.org), Haskoin,
// SoChain, BlockCypher and Insight, each turned into the same transaction shape.
//
// The parse functions are pure so test/pure.test.mjs can feed them recorded answers.
import { BLOCKCYPHER, BLOCKCYPHER_CODE, ESPLORA, HASKOIN, INSIGHT, SOCHAIN, SOCHAIN_CODE, V } from '../chains';
import { canonicalOn } from '../formats';
import type { Http } from '../http';
import { VendorDown } from '../http';
import type { Facts, Part, UtxoHistory, UtxoTx } from '../model';
import { countOf, formatUnits, isoTime, parseUnits, str } from '../values';

const DECIMALS = 8;

/** An address a vendor printed, in the type pack's canonical form for `network`, or undefined. */
function addr(network: string, v: unknown): string | undefined {
    const s = str(v);
    if (!s) return undefined;
    // Haskoin prints `bitcoincash:q…`; canonicalOn drops the prefix.
    return canonicalOn(network, s)?.address;
}

const sats = (v: unknown): string | null => {
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return v.trim();
    return null;
};

// ---- Esplora ----------------------------------------------------------------------------------

export function esploraTx(network: string, t: any): UtxoTx | null {
    const txid = str(t?.txid).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid) || !Array.isArray(t?.vin) || !Array.isArray(t?.vout)) return null;
    const coinbase = t.vin.some((i: any) => i?.is_coinbase === true);
    const inputs: Part[] = t.vin.map((i: any, index: number) => ({
        index,
        address: addr(network, i?.prevout?.scriptpubkey_address),
        raw: sats(i?.prevout?.value) ?? '0',
        prev_txid: i?.is_coinbase ? undefined : str(i?.txid).toLowerCase() || undefined,
        prev_vout: Number.isInteger(i?.vout) && !i?.is_coinbase ? i.vout : undefined,
    }));
    const outputs: Part[] = t.vout.map((o: any, index: number) => ({ index, address: addr(network, o?.scriptpubkey_address), raw: sats(o?.value) ?? '0' }));
    const confirmed = t?.status?.confirmed === true;
    return {
        txid,
        confirmed,
        block_height: confirmed ? countOf(t.status.block_height) : undefined,
        block_time: confirmed ? isoTime(t.status.block_time) : undefined,
        fee: formatUnits(sats(t.fee) ?? '', DECIMALS) ?? undefined,
        coinbase,
        inputs,
        outputs,
    };
}

export function esploraFacts(a: any): Facts {
    const c = a?.chain_stats;
    const m = a?.mempool_stats;
    const funded = sats(c?.funded_txo_sum);
    const spent = sats(c?.spent_txo_sum);
    const n = (countOf(c?.tx_count) ?? 0) + (countOf(m?.tx_count) ?? 0);
    return {
        tx_count: c ? n : undefined,
        // Confirmed balance: what the chain says, not what the mempool may still change.
        balance: funded && spent ? (formatUnits((BigInt(funded) - BigInt(spent)).toString(), DECIMALS) ?? undefined) : undefined,
    };
}

export async function esploraHistory(http: Http, network: string, which: 'mempool' | 'blockstream' | 'litecoinspace', address: string, maxTxs: number): Promise<UtxoHistory> {
    const { base, vendor } = ESPLORA[which];
    const info = await http.get(vendor, `${base}address/${address}`);
    if (!info || typeof info !== 'object') throw new VendorDown(vendor.id, `${vendor.name}: did not recognise the address`);
    const facts = esploraFacts(info);
    const txs: UtxoTx[] = [];
    let complete = false;
    // The first page holds the mempool's transactions and the newest 25 confirmed ones; each later
    // page is 25 confirmed ones older than the last txid given.
    let page = await http.get(vendor, `${base}address/${address}/txs`);
    for (;;) {
        if (!Array.isArray(page)) throw new VendorDown(vendor.id, `${vendor.name}: unexpected answer for the address's transactions`);
        let confirmed = 0;
        let lastConfirmed = '';
        for (const t of page) {
            const tx = esploraTx(network, t);
            if (!tx) continue;
            if (tx.confirmed) {
                confirmed++;
                lastConfirmed = tx.txid;
            }
            if (!txs.some((x) => x.txid === tx.txid)) txs.push(tx);
        }
        if (confirmed < 25) {
            complete = true;
            break;
        }
        if (txs.length >= maxTxs || http.outOfTime) break;
        page = await http.get(vendor, `${base}address/${address}/txs/chain/${lastConfirmed}`);
    }
    return { kind: 'utxo', source: which, vendor: vendor.name, txs: txs.slice(0, maxTxs), complete: complete && txs.length <= maxTxs, facts };
}

export async function esploraTxLookup(http: Http, network: string, which: 'mempool' | 'blockstream' | 'litecoinspace', txid: string): Promise<UtxoTx | null> {
    const { base, vendor } = ESPLORA[which];
    const t = await http.get(vendor, `${base}tx/${txid}`);
    return t ? esploraTx(network, t) : null;
}

/** Whether an address has ever been used, for Identify network. */
export async function esploraUsed(http: Http, which: 'mempool' | 'blockstream' | 'litecoinspace', address: string): Promise<number | null> {
    const { base, vendor } = ESPLORA[which];
    const a = await http.get(vendor, `${base}address/${address}`);
    return a ? (esploraFacts(a).tx_count ?? null) : null;
}

// ---- Haskoin (Bitcoin Cash) -------------------------------------------------------------------
// Queried with the CashAddr payload, no prefix, lower case: the form the type pack stores.

export function haskoinTx(t: any): UtxoTx | null {
    const txid = str(t?.txid).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid) || !Array.isArray(t?.inputs) || !Array.isArray(t?.outputs)) return null;
    const coinbase = t.inputs.some((i: any) => i?.coinbase === true);
    const height = countOf(t?.block?.height);
    return {
        txid,
        confirmed: height !== undefined,
        block_height: height,
        block_time: height !== undefined ? isoTime(t.time) : undefined,
        fee: formatUnits(sats(t.fee) ?? '', DECIMALS) ?? undefined,
        coinbase,
        inputs: t.inputs.map((i: any, index: number) => ({
            index,
            address: addr('bitcoin_cash', i?.address),
            raw: sats(i?.value) ?? '0',
            prev_txid: i?.coinbase ? undefined : str(i?.txid).toLowerCase() || undefined,
            prev_vout: Number.isInteger(i?.output) && !i?.coinbase ? i.output : undefined,
        })),
        outputs: t.outputs.map((o: any, index: number) => ({ index, address: addr('bitcoin_cash', o?.address), raw: sats(o?.value) ?? '0' })),
    };
}

const HASKOIN_PAGE = 25;

export async function haskoinHistory(http: Http, address: string, maxTxs: number): Promise<UtxoHistory> {
    const v = V.haskoin;
    const bal = await http.get(v, `${HASKOIN}address/${address}/balance`);
    if (!bal || typeof bal !== 'object' || bal.error) throw new VendorDown(v.id, `${v.name}: did not recognise the address`);
    const facts: Facts = {
        tx_count: countOf(bal.txs),
        balance: formatUnits(sats(bal.confirmed) ?? '', DECIMALS) ?? undefined,
    };
    const txs: UtxoTx[] = [];
    let complete = false;
    // Full transactions are large (a busy wallet's 25 are a quarter of a megabyte), so a page asks
    // for no more than the run will keep.
    const limit = Math.min(HASKOIN_PAGE, maxTxs);
    for (let offset = 0; ; offset += limit) {
        const page = await http.get(v, `${HASKOIN}address/${address}/transactions/full?limit=${limit}&offset=${offset}`);
        if (!Array.isArray(page)) throw new VendorDown(v.id, `${v.name}: unexpected answer for the address's transactions`);
        for (const t of page) {
            const tx = haskoinTx(t);
            if (tx && !txs.some((x) => x.txid === tx.txid)) txs.push(tx);
        }
        if (page.length < limit) {
            complete = true;
            break;
        }
        if (txs.length >= maxTxs || http.outOfTime) break;
    }
    return { kind: 'utxo', source: 'haskoin', vendor: v.name, txs: txs.slice(0, maxTxs), complete: complete && txs.length <= maxTxs, facts };
}

export async function haskoinTxLookup(http: Http, txid: string): Promise<UtxoTx | null> {
    const t = await http.get(V.haskoin, `${HASKOIN}transaction/${txid}`);
    return t && !t.error ? haskoinTx(t) : null;
}

export async function haskoinUsed(http: Http, address: string): Promise<number | null> {
    const b = await http.get(V.haskoin, `${HASKOIN}address/${address}/balance`);
    return b && !b.error ? (countOf(b.txs) ?? null) : null;
}

// ---- SoChain (Litecoin, Dogecoin, Zcash) ------------------------------------------------------
// Amounts are decimal strings in coins. The address list gives hashes only, so a history costs one
// request per transaction for its inputs and outputs.

export function sochainTx(network: string, d: any): UtxoTx | null {
    const txid = str(d?.hash).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid) || !Array.isArray(d?.inputs) || !Array.isArray(d?.outputs)) return null;
    const height = countOf(d.block_height);
    const coinbase = d.inputs.length > 0 && d.inputs.every((i: any) => !i?.previous_output?.hash || /^0+$/.test(str(i.previous_output.hash)));
    return {
        txid,
        confirmed: height !== undefined,
        block_height: height,
        block_time: isoTime(d.time),
        fee: str(d.fee) && parseUnits(d.fee, DECIMALS) ? (formatUnits(parseUnits(d.fee, DECIMALS)!, DECIMALS) ?? undefined) : undefined,
        coinbase,
        inputs: d.inputs.map((i: any, k: number) => ({
            index: Number.isInteger(i?.index) ? i.index : k,
            address: addr(network, i?.address),
            raw: parseUnits(i?.value, DECIMALS) ?? '0',
            prev_txid: str(i?.previous_output?.hash).toLowerCase() || undefined,
            prev_vout: Number.isInteger(i?.previous_output?.index) ? i.previous_output.index : undefined,
        })),
        outputs: d.outputs.map((o: any, k: number) => ({
            index: Number.isInteger(o?.index) ? o.index : k,
            // An OP_RETURN output is printed with the address "op_return"; canonicalOn refuses it.
            address: addr(network, o?.address),
            raw: parseUnits(o?.value, DECIMALS) ?? '0',
        })),
    };
}

const SOCHAIN_PAGE = 10;

export async function sochainSummary(http: Http, network: string, address: string): Promise<Facts | null> {
    const code = SOCHAIN_CODE[network];
    const r = await http.get(V.sochain, `${SOCHAIN}address_summary/${code}/${address}`);
    if (!r || r.status !== 'success' || !r.data) return null;
    const d = r.data;
    return {
        tx_count: countOf(d.txs_total),
        balance: str(d.confirmed_balance) && parseUnits(d.confirmed_balance, DECIMALS) ? (formatUnits(parseUnits(d.confirmed_balance, DECIMALS)!, DECIMALS) ?? undefined) : undefined,
        first_seen: isoTime(d.first_active?.time),
        last_seen: isoTime(d.last_active?.time),
    };
}

export async function sochainHistory(http: Http, network: string, address: string, maxTxs: number): Promise<UtxoHistory> {
    const v = V.sochain;
    const code = SOCHAIN_CODE[network];
    const facts = await sochainSummary(http, network, address);
    if (!facts) throw new VendorDown(v.id, `${v.name}: did not recognise the address`);
    const hashes: string[] = [];
    let complete = false;
    for (let page = 1; ; page++) {
        const r = await http.get(v, `${SOCHAIN}transactions/${code}/${address}/${page}`);
        const list = r?.data?.transactions;
        if (!Array.isArray(list)) throw new VendorDown(v.id, `${v.name}: unexpected answer for the address's transactions`);
        // Pages overlap while new transactions arrive (measured 2026-11-15: page 2 began with the
        // last three of page 1), so hashes are merged rather than appended.
        for (const t of list) {
            const h = str(t?.hash).toLowerCase();
            if (/^[0-9a-f]{64}$/.test(h) && !hashes.includes(h)) hashes.push(h);
        }
        if (list.length < SOCHAIN_PAGE) {
            complete = true;
            break;
        }
        if (hashes.length >= maxTxs || http.outOfTime) break;
    }
    const txs: UtxoTx[] = [];
    for (const h of hashes.slice(0, maxTxs)) {
        if (http.outOfTime) {
            complete = false;
            break;
        }
        const r = await http.get(v, `${SOCHAIN}transaction/${code}/${h}`);
        const tx = r?.status === 'success' ? sochainTx(network, r.data) : null;
        if (tx) txs.push(tx);
        else complete = false;
    }
    if (hashes.length > maxTxs) complete = false;
    return { kind: 'utxo', source: 'sochain', vendor: v.name, txs, complete, facts };
}

export async function sochainTxLookup(http: Http, network: string, txid: string): Promise<UtxoTx | null> {
    const r = await http.get(V.sochain, `${SOCHAIN}transaction/${SOCHAIN_CODE[network]}/${txid}`);
    return r?.status === 'success' ? sochainTx(network, r.data) : null;
}

export async function sochainUsed(http: Http, network: string, address: string): Promise<number | null> {
    const f = await sochainSummary(http, network, address);
    return f ? (f.tx_count ?? null) : null;
}

// ---- BlockCypher (Litecoin, Dogecoin, Dash) ---------------------------------------------------

export function blockcypherTx(network: string, t: any): UtxoTx | null {
    const txid = str(t?.hash).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid) || !Array.isArray(t?.inputs) || !Array.isArray(t?.outputs)) return null;
    const height = typeof t.block_height === 'number' && t.block_height >= 0 ? t.block_height : undefined;
    const coinbase = t.inputs.some((i: any) => i?.script_type === 'empty' && !i?.prev_hash);
    const one = (a: any) => (Array.isArray(a) && a.length === 1 ? addr(network, a[0]) : undefined);
    return {
        txid,
        confirmed: height !== undefined,
        block_height: height,
        block_time: isoTime(t.confirmed) ?? undefined,
        fee: formatUnits(sats(t.fees) ?? '', DECIMALS) ?? undefined,
        coinbase,
        // `full` lists 20 inputs and 20 outputs unless asked for more (BlockCypher docs).
        truncated: (countOf(t.vin_sz) ?? 0) > t.inputs.length || (countOf(t.vout_sz) ?? 0) > t.outputs.length,
        inputs: t.inputs.map((i: any, k: number) => ({
            index: k,
            address: one(i?.addresses),
            raw: sats(i?.output_value) ?? '0',
            prev_txid: str(i?.prev_hash).toLowerCase() || undefined,
            prev_vout: Number.isInteger(i?.output_index) ? i.output_index : undefined,
        })),
        outputs: t.outputs.map((o: any, k: number) => ({ index: k, address: one(o?.addresses), raw: sats(o?.value) ?? '0' })),
    };
}

const BLOCKCYPHER_PAGE = 50;

export async function blockcypherHistory(http: Http, network: string, address: string, maxTxs: number): Promise<UtxoHistory> {
    const v = V.blockcypher;
    const base = `${BLOCKCYPHER}${BLOCKCYPHER_CODE[network]}/main/`;
    const txs: UtxoTx[] = [];
    let facts: Facts = {};
    let complete = false;
    let before: number | undefined;
    const limit = Math.min(BLOCKCYPHER_PAGE, maxTxs);
    for (let first = true; ; first = false) {
        const r = await http.get(v, `${base}addrs/${address}/full?limit=${limit}${before !== undefined ? `&before=${before}` : ''}`);
        if (!r || !Array.isArray(r.txs)) throw new VendorDown(v.id, `${v.name}: did not recognise the address`);
        if (first) facts = { tx_count: countOf(r.final_n_tx) ?? countOf(r.n_tx), balance: formatUnits(sats(r.balance) ?? '', DECIMALS) ?? undefined };
        let lowest: number | undefined;
        let added = 0;
        for (const t of r.txs) {
            const tx = blockcypherTx(network, t);
            if (!tx) continue;
            if (tx.block_height !== undefined && (lowest === undefined || tx.block_height < lowest)) lowest = tx.block_height;
            if (!txs.some((x) => x.txid === tx.txid)) {
                txs.push(tx);
                added++;
            }
        }
        if (!r.hasMore) {
            complete = true;
            break;
        }
        // A page that added nothing is a block holding more of the address's transactions than a
        // page lists: the cursor cannot get past it, so the history stops there, incomplete.
        if (!first && !added) break;
        if (lowest === undefined || txs.length >= maxTxs || http.outOfTime) break;
        // `before` keeps heights strictly below it (BlockCypher docs), and a page can end partway
        // through a block: `before=lowest` skipped the rest of that block and could still end
        // complete (review of 1.0.0). The next page starts at that block again; the txid check
        // drops what was already read.
        before = lowest + 1;
    }
    return { kind: 'utxo', source: 'blockcypher', vendor: v.name, txs: txs.slice(0, maxTxs), complete: complete && txs.length <= maxTxs, facts };
}

export async function blockcypherTxLookup(http: Http, network: string, txid: string): Promise<UtxoTx | null> {
    const t = await http.get(V.blockcypher, `${BLOCKCYPHER}${BLOCKCYPHER_CODE[network]}/main/txs/${txid}?limit=50`);
    return t && !t.error ? blockcypherTx(network, t) : null;
}

export async function blockcypherUsed(http: Http, network: string, address: string): Promise<number | null> {
    const r = await http.get(V.blockcypher, `${BLOCKCYPHER}${BLOCKCYPHER_CODE[network]}/main/addrs/${address}/balance`);
    return r && !r.error ? (countOf(r.final_n_tx) ?? countOf(r.n_tx) ?? null) : null;
}

// ---- Insight (Dash) ---------------------------------------------------------------------------

export function insightTx(t: any): UtxoTx | null {
    const txid = str(t?.txid).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid) || !Array.isArray(t?.vin) || !Array.isArray(t?.vout)) return null;
    const height = typeof t.blockheight === 'number' && t.blockheight >= 0 ? t.blockheight : undefined;
    const coinbase = t.vin.some((i: any) => typeof i?.coinbase === 'string');
    // `fees` is a JSON number; parseUnits refuses one that does not print exactly.
    const fee = parseUnits(typeof t.fees === 'number' ? Number(t.fees.toFixed(8)) : t.fees, DECIMALS);
    return {
        txid,
        confirmed: height !== undefined,
        block_height: height,
        block_time: height !== undefined ? isoTime(t.blocktime ?? t.time) : undefined,
        fee: fee ? (formatUnits(fee, DECIMALS) ?? undefined) : undefined,
        coinbase,
        inputs: t.vin.map((i: any, k: number) => ({
            index: Number.isInteger(i?.n) ? i.n : k,
            address: addr('dash', i?.addr),
            raw: sats(i?.valueSat) ?? parseUnits(i?.value, DECIMALS) ?? '0',
            prev_txid: str(i?.txid).toLowerCase() || undefined,
            prev_vout: Number.isInteger(i?.vout) ? i.vout : undefined,
        })),
        outputs: t.vout.map((o: any, k: number) => ({
            index: Number.isInteger(o?.n) ? o.n : k,
            address: Array.isArray(o?.scriptPubKey?.addresses) && o.scriptPubKey.addresses.length === 1 ? addr('dash', o.scriptPubKey.addresses[0]) : undefined,
            raw: parseUnits(o?.value, DECIMALS) ?? '0',
        })),
    };
}

export async function insightHistory(http: Http, address: string, maxTxs: number): Promise<UtxoHistory> {
    const v = V.insight;
    const a = await http.get(v, `${INSIGHT}addr/${address}?noTxList=1`);
    if (!a || typeof a !== 'object' || !('balanceSat' in a)) throw new VendorDown(v.id, `${v.name}: did not recognise the address`);
    const facts: Facts = { tx_count: countOf(a.txAppearances ?? a.txApperances), balance: formatUnits(sats(a.balanceSat) ?? '', DECIMALS) ?? undefined };
    const txs: UtxoTx[] = [];
    let complete = false;
    for (let page = 0; ; page++) {
        const r = await http.get(v, `${INSIGHT}txs?address=${address}&pageNum=${page}`);
        if (!r || !Array.isArray(r.txs)) throw new VendorDown(v.id, `${v.name}: unexpected answer for the address's transactions`);
        for (const t of r.txs) {
            const tx = insightTx(t);
            if (tx && !txs.some((x) => x.txid === tx.txid)) txs.push(tx);
        }
        if (page + 1 >= (countOf(r.pagesTotal) ?? 0)) {
            complete = true;
            break;
        }
        if (txs.length >= maxTxs || http.outOfTime) break;
    }
    return { kind: 'utxo', source: 'insight', vendor: v.name, txs: txs.slice(0, maxTxs), complete: complete && txs.length <= maxTxs, facts };
}

export async function insightTxLookup(http: Http, txid: string): Promise<UtxoTx | null> {
    const t = await http.get(V.insight, `${INSIGHT}tx/${txid}`);
    return t ? insightTx(t) : null;
}
