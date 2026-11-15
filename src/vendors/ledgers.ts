// XRP Ledger (public rippled JSON-RPC, XRPSCAN for activation and names) and TON (toncenter v3).
//
// The parse functions are pure so test/pure.test.mjs can feed them recorded answers.
import { NATIVE, TONCENTER, V, XRPL_RPC, XRPSCAN } from '../chains';
import { base64Decode, bytesToHex } from '../codec';
import { tonRaw, xrplClassic } from '../formats';
import type { Http } from '../http';
import { VendorDown } from '../http';
import type { AccountHistory, AccountTx, Facts, Feed, Move } from '../model';
import { countOf, formatUnits, isoTime, str } from '../values';

// ---- XRPL -------------------------------------------------------------------------------------

/** Seconds between the Unix epoch and the Ripple epoch (2000-01-01). */
const RIPPLE_EPOCH = 946_684_800;
const DROPS = 6;
/**
 * Issued currencies have no decimals of their own: their amounts are decimal strings with up to 15
 * significant digits. They are carried at a fixed 15 places so one asset's rows add up.
 */
const IOU_PLACES = 15;

/** An issued-currency value ("1.5", "1e-5", "1234567890123456e-10") in units of 10^-15, or null. */
export function iouRaw(v: unknown): string | null {
    const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(str(v));
    if (!m) return null;
    const digits = (m[1] + (m[2] ?? '')).replace(/^0+(?=\d)/, '');
    const exp = Number(m[3] ?? 0) - (m[2]?.length ?? 0) + IOU_PLACES;
    if (!Number.isInteger(exp) || Math.abs(exp) > 200) return null;
    if (exp >= 0) return (BigInt(digits) * 10n ** BigInt(exp)).toString();
    // More places than the fixed scale holds: the amount is below 10^-15 and is dropped as dust.
    const cut = digits.slice(0, Math.max(0, digits.length + exp));
    return cut ? BigInt(cut).toString() : null;
}

/** XRPL currency code as printed: three letters, or the 40-hex form decoded when it is text. */
export function currencyName(code: unknown): string {
    const c = str(code);
    if (/^[0-9A-F]{40}$/i.test(c) && !/^0{40}$/.test(c)) {
        const text = c.replace(/(00)+$/, '').replace(/../g, (h) => String.fromCharCode(parseInt(h, 16)));
        if (/^[\x20-\x7e]+$/.test(text)) return text.trim();
    }
    return c;
}

/** A Payment's delivered value as a move. `tx` is the transaction object, `meta` its metadata. Pure. */
export function xrplMove(tx: any, meta: any, ledger?: number): Move | null {
    if (str(tx?.TransactionType) !== 'Payment' || str(meta?.TransactionResult) !== 'tesSUCCESS') return null;
    const from = xrplClassic(str(tx.Account));
    const to = xrplClassic(str(tx.Destination));
    const tx_hash = /^[0-9a-fA-F]{64}$/.test(str(tx.hash)) ? str(tx.hash).toLowerCase() : null;
    const order = ledger ?? countOf(tx.ledger_index) ?? 0;
    if (!from || !to || !tx_hash || from === to) return null;
    const time = typeof tx.date === 'number' ? isoTime(tx.date + RIPPLE_EPOCH) : undefined;
    // `delivered_amount`, not `Amount`: a partial payment delivers less than it names, and is the
    // classic way to fake a large deposit.
    const d = meta.delivered_amount ?? meta.DeliveredAmount;
    const tag = Number.isInteger(tx.DestinationTag) ? String(tx.DestinationTag) : undefined;
    if (typeof d === 'string') {
        if (!/^\d+$/.test(d) || /^0+$/.test(d)) return null;
        return { tx_hash, time, order, from, to, to_memo: tag, asset: NATIVE, symbol: 'XRP', decimals: DROPS, raw: d };
    }
    if (d && typeof d === 'object') {
        const issuer = xrplClassic(str(d.issuer));
        const raw = iouRaw(d.value);
        if (!issuer || !raw || raw === '0') return null;
        const currency = currencyName(d.currency);
        return { tx_hash, time, order, from, to, to_memo: tag, asset: `${str(d.currency)}.${issuer}`, symbol: currency, decimals: IOU_PLACES, raw };
    }
    return null;
}

type XrplNode = (typeof XRPL_RPC)[number];

async function xrpl(http: Http, node: XrplNode, method: string, params: Record<string, unknown>): Promise<any> {
    const r = await http.post(node.vendor, node.url, { method, params: [params] });
    const res = r?.result;
    if (!res || typeof res !== 'object') throw new VendorDown(node.vendor.id, `${node.vendor.name}: no answer`);
    if (res.status === 'error' && /slowDown|tooBusy|noNetwork|notSynced|amendmentBlocked/.test(str(res.error))) {
        throw http.giveUp(node.vendor, str(res.error));
    }
    return res;
}

const XRPL_PAGE = 200;

export async function xrplHistory(http: Http, node: XrplNode, address: string, maxPages: number, memo?: string): Promise<AccountHistory> {
    const info = await xrpl(http, node, 'account_info', { account: address, ledger_index: 'validated' });
    if (info.status === 'error' && str(info.error) !== 'actNotFound') throw new VendorDown(node.vendor.id, `${node.vendor.name}: ${str(info.error_message) || str(info.error)}`);
    // A tag has no balance of its own: the account's (an exchange hot wallet's, for a deposit tag)
    // was written onto one customer's node (review of 1.0.0). Its first and last payments come from
    // its own rows (write.ts).
    const facts: Facts = memo !== undefined ? {} : info.status === 'error' ? { balance: '0', tx_count: 0 } : { balance: formatUnits(str(info.account_data?.Balance), DROPS) ?? undefined };
    const feed: Feed = { name: 'payments', rows: [], complete: info.status === 'error', oldest: null, examined: 0 };
    if (info.status !== 'error') {
        let marker: unknown;
        for (let page = 0; page < maxPages; page++) {
            const r = await xrpl(http, node, 'account_tx', { account: address, limit: XRPL_PAGE, forward: false, ...(marker ? { marker } : {}) });
            if (r.status === 'error' || !Array.isArray(r.transactions)) throw new VendorDown(node.vendor.id, `${node.vendor.name}: ${str(r.error) || 'unexpected account_tx answer'}`);
            for (const e of r.transactions) {
                const tx = e?.tx ?? e?.tx_json;
                const ledger = countOf(tx?.ledger_index ?? e?.ledger_index);
                feed.examined++;
                if (ledger !== undefined && (feed.oldest == null || ledger < feed.oldest)) feed.oldest = ledger;
                const t = typeof tx?.date === 'number' ? isoTime(tx.date + RIPPLE_EPOCH) : undefined;
                if (t && (!feed.newest || t > feed.newest)) feed.newest = t;
                if (t && (!feed.oldestTime || t < feed.oldestTime)) feed.oldestTime = t;
                const m = xrplMove({ ...tx, hash: tx?.hash ?? e?.hash }, e?.meta, ledger);
                if (!m) continue;
                // A node with a memo is one destination tag behind the address: only payments to
                // that tag are its own, and the address's outgoing payments are not per tag.
                if (memo !== undefined && !(m.to === address && m.to_memo === memo)) continue;
                feed.rows.push(m);
            }
            marker = r.marker;
            if (!marker) {
                feed.complete = true;
                break;
            }
            if (http.outOfTime) break;
        }
    }
    return { kind: 'account', source: node.source, vendor: node.vendor.name, feeds: [feed], facts };
}

export async function xrplTx(http: Http, node: XrplNode, hash: string): Promise<AccountTx | null> {
    const r = await xrpl(http, node, 'tx', { transaction: hash.toUpperCase(), binary: false });
    if (r.status === 'error') {
        if (str(r.error) === 'txnNotFound') return null;
        throw new VendorDown(node.vendor.id, `${node.vendor.name}: ${str(r.error)}`);
    }
    const tx = r.tx_json ?? r;
    const meta = r.meta;
    const ledger = countOf(r.ledger_index ?? tx.ledger_index);
    const m = xrplMove({ ...tx, hash: r.hash ?? tx.hash }, meta, ledger);
    const fee = str(tx.Fee);
    return {
        tx_hash: hash.toLowerCase(),
        block_height: ledger,
        block_time: typeof tx.date === 'number' ? isoTime(tx.date + RIPPLE_EPOCH) : undefined,
        status: r.validated !== true ? 'pending' : str(meta?.TransactionResult) === 'tesSUCCESS' ? 'success' : 'failed',
        fee: /^\d+$/.test(fee) ? (formatUnits(fee, DROPS) ?? undefined) : undefined,
        tx_kind: str(tx.TransactionType) === 'Payment' ? 'transfer' : 'other',
        signer: xrplClassic(str(tx.Account)) ?? undefined,
        moves: m ? [m] : [],
        extra: str(tx.TransactionType) ? { xrpl_type: str(tx.TransactionType) } : undefined,
    };
}

/** XRPSCAN's account record: activation (`parent`, `inception`, `tx_hash`) and the verified name. */
export async function xrpscanAccount(http: Http, address: string): Promise<any | null> {
    const r = await http.get(V.xrpscan, `${XRPSCAN}account/${address}`);
    return r && typeof r === 'object' && (r.account || r.Account) ? r : null;
}

// ---- TON --------------------------------------------------------------------------------------

/** USDT on TON, whose decimals toncenter's metadata does not always carry. */
const KNOWN_JETTONS: Record<string, { symbol: string; decimals: number }> = {
    '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe': { symbol: 'USDT', decimals: 6 },
};

/** A TON transaction hash (base64) as the type pack writes it: hex, lower case. */
export function tonHash(v: unknown): string | null {
    const s = str(v);
    if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
    const b = base64Decode(s);
    return b && b.length === 32 ? bytesToHex(b) : null;
}

/** Native TON moves of one toncenter v3 transaction. Pure. */
export function tonMoves(t: any): Move[] {
    const tx_hash = tonHash(t?.hash);
    const order = Number(str(t?.lt));
    const account = tonRaw(str(t?.account));
    if (!tx_hash || !Number.isFinite(order) || !account) return [];
    const time = isoTime(t.now);
    const out: Move[] = [];
    const add = (from: unknown, to: unknown, value: unknown) => {
        const f = tonRaw(str(from));
        const d = tonRaw(str(to));
        const raw = str(value);
        if (!f || !d || f === d || !/^\d+$/.test(raw) || /^0+$/.test(raw)) return;
        out.push({ tx_hash, time, order, from: f, to: d, asset: NATIVE, symbol: 'TON', decimals: 9, raw });
    };
    const inm = t.in_msg;
    // An external message (from no one) starts a wallet's own transfer; its value is zero.
    if (inm?.source) add(inm.source, account, inm.value);
    for (const o of Array.isArray(t.out_msgs) ? t.out_msgs : []) if (o?.destination) add(account, o.destination, o.value);
    return out;
}

/** One jetton transfer (owner to owner) from toncenter v3 `/jetton/transfers`. Pure. */
export function jettonMove(j: any, metadata?: any): Move | null {
    if (j?.transaction_aborted === true) return null;
    const tx_hash = tonHash(j?.transaction_hash);
    const order = Number(str(j?.transaction_lt));
    const from = tonRaw(str(j?.source));
    const to = tonRaw(str(j?.destination));
    const asset = tonRaw(str(j?.jetton_master));
    const raw = str(j?.amount);
    if (!tx_hash || !Number.isFinite(order) || !from || !to || !asset || from === to || !/^\d+$/.test(raw) || /^0+$/.test(raw)) return null;
    const known = KNOWN_JETTONS[asset];
    const info = (metadata?.[str(j.jetton_master)]?.token_info ?? []).find((x: any) => x?.type === 'jetton_masters');
    const dec = countOf(info?.extra?.decimals);
    return {
        tx_hash,
        time: isoTime(j.transaction_now),
        order,
        from,
        to,
        asset,
        symbol: known?.symbol ?? (str(info?.symbol) || undefined),
        decimals: known?.decimals ?? (dec !== undefined && dec <= 255 ? dec : null),
        raw,
    };
}

const TON_PAGE = 100;

export async function tonAccount(http: Http, address: string): Promise<any | null> {
    const r = await http.request(V.toncenter, `${TONCENTER}account?address=${encodeURIComponent(address)}`);
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.body || typeof r.body !== 'object') throw new VendorDown(V.toncenter.id, `${V.toncenter.name}: ${str(r.body?.error) || 'unexpected account answer'}`);
    return r.body;
}

export async function tonHistory(http: Http, address: string, maxPages: number): Promise<AccountHistory> {
    const acct = await tonAccount(http, address);
    const feeds: Feed[] = [];
    for (const [name, path, key] of [
        ['transactions', 'transactions?account=', 'transactions'],
        ['jetton_transfers', 'jetton/transfers?owner_address=', 'jetton_transfers'],
    ] as const) {
        const feed: Feed = { name, rows: [], complete: false, oldest: null, examined: 0 };
        for (let page = 0; page < maxPages; page++) {
            const r = await http.get(V.toncenter, `${TONCENTER}${path}${encodeURIComponent(address)}&limit=${TON_PAGE}&offset=${page * TON_PAGE}&sort=desc`);
            const rows = r?.[key];
            if (!Array.isArray(rows)) throw new VendorDown(V.toncenter.id, `${V.toncenter.name}: unexpected ${name} answer`);
            for (const t of rows) {
                feed.examined++;
                const lt = Number(str(name === 'transactions' ? t?.lt : t?.transaction_lt));
                if (Number.isFinite(lt) && (feed.oldest == null || lt < feed.oldest)) feed.oldest = lt;
                const tt = isoTime(name === 'transactions' ? t?.now : t?.transaction_now);
                if (tt && (!feed.newest || tt > feed.newest)) feed.newest = tt;
                if (tt && (!feed.oldestTime || tt < feed.oldestTime)) feed.oldestTime = tt;
                if (name === 'transactions') feed.rows.push(...tonMoves(t));
                else {
                    const m = jettonMove(t, r.metadata);
                    if (m) feed.rows.push(m);
                }
            }
            if (rows.length < TON_PAGE) {
                feed.complete = true;
                break;
            }
            if (http.outOfTime) break;
        }
        feeds.push(feed);
    }
    const facts: Facts = { balance: acct ? (formatUnits(str(acct.balance), 9) ?? undefined) : '0' };
    return { kind: 'account', source: 'toncenter', vendor: V.toncenter.name, feeds, facts };
}

export async function tonTx(http: Http, hash: string): Promise<AccountTx | null> {
    // toncenter takes the hash in hex or base64; the type pack's form is hex.
    const r = await http.get(V.toncenter, `${TONCENTER}transactions?hash=${hash}&limit=1`);
    const t = Array.isArray(r?.transactions) ? r.transactions[0] : null;
    if (!t) return null;
    const fee = str(t.total_fees);
    const aborted = t.description?.aborted === true;
    return {
        tx_hash: tonHash(t.hash) ?? hash,
        block_time: isoTime(t.now),
        status: aborted ? 'failed' : 'success',
        fee: /^\d+$/.test(fee) ? (formatUnits(fee, 9) ?? undefined) : undefined,
        tx_kind: 'transfer',
        // A TON transaction is one account's step, started by a message from someone else (or by
        // an external message to a wallet). The account is not a signer in the EVM sense, so none
        // is named; its value in and out are the moves.
        moves: tonMoves(t),
        extra: { lt: str(t.lt) || undefined },
    };
}
