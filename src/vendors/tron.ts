// TRON vendors: TronGrid's keyless tier, then Tronscan's public API.
//
// TronGrid's docs say a keyless request may meet "strict limits or refusal" and give no figure; a
// refusal hands the run to Tronscan. The parse functions are pure for test/pure.test.mjs.
import { NATIVE, TRONGRID, TRONSCAN, V } from '../chains';
import { base58CheckEncode, hexToBytes } from '../codec';
import { tronBase58, tronHex20 } from '../formats';
import type { Http } from '../http';
import { VendorDown } from '../http';
import type { AccountHistory, AccountTx, Facts, Feed, Move } from '../model';
import { abiAddressWord, abiBool, abiString, abiUint, countOf, formatUnits, hexHash, isoTime, str } from '../values';

const SUN = 6;
/** The all-zero TRON address, the caller for read-only contract calls. */
const ZERO_CALLER = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** A TRON address from Base58, hex `41…`, or a 20-byte hex word (ABI arguments, log topics). */
export function tronAddr(v: unknown): string | null {
    const s = str(v);
    if (!s) return null;
    const direct = tronBase58(s);
    if (direct) return direct;
    const m = /^(?:0x)?(?:0{24})?([0-9a-fA-F]{40})$/.exec(s);
    return m ? base58CheckEncode(hexToBytes('41' + m[1])!) : null;
}

const digits = (v: unknown): string | null => {
    const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : str(v);
    return /^\d+$/.test(s) && !/^0+$/.test(s) ? s : null;
};

/**
 * An account's TRX balance from TronGrid. TronGrid leaves `balance` out of an account holding none.
 * Past 2^53 sun (about 9 billion TRX) parseExact hands the amount over as a digit string, which
 * stays exact here; a value that is neither is left out, never written as 0 (1.0.0 wrote "0").
 */
export function sunBalance(v: unknown): string | undefined {
    if (v === undefined || v === null) return '0';
    const s = typeof v === 'number' ? (Number.isSafeInteger(v) ? String(v) : '') : str(v);
    return /^\d+$/.test(s) ? (formatUnits(s, SUN) ?? undefined) : undefined;
}

function feedOf(name: string): Feed {
    return { name, rows: [], complete: false, oldest: null, examined: 0 };
}
function note(feed: Feed, ts: number | undefined) {
    feed.examined++;
    if (ts === undefined) return;
    if (feed.oldest == null || ts < feed.oldest) feed.oldest = ts;
    const t = isoTime(ts, 'ms');
    if (t && (!feed.newest || t > feed.newest)) feed.newest = t;
    if (t && (!feed.oldestTime || t < feed.oldestTime)) feed.oldestTime = t;
}

// ---- TronGrid ---------------------------------------------------------------------------------

/** TRX and TRC-10 transfers from a TronGrid `/v1/accounts/{a}/transactions` row. Pure. */
export function trongridMove(t: any): Move | null {
    if (str(t?.ret?.[0]?.contractRet) !== 'SUCCESS') return null;
    const c = t?.raw_data?.contract?.[0];
    const v = c?.parameter?.value;
    const tx_hash = hexHash(t?.txID, false);
    const ts = countOf(t?.block_timestamp);
    if (!tx_hash || ts === undefined || !v) return null;
    const from = tronAddr(v.owner_address);
    const to = tronAddr(v.to_address);
    const raw = digits(v.amount);
    if (!from || !to || !raw) return null;
    if (c.type === 'TransferContract') return { tx_hash, time: isoTime(ts, 'ms'), order: ts, from, to, asset: NATIVE, symbol: 'TRX', decimals: SUN, raw };
    if (c.type === 'TransferAssetContract') {
        const id = str(v.asset_name);
        // TRC-10 tokens are numbered; TronGrid gives no decimals here, so the amount stays in base units.
        return /^\d+$/.test(id) ? { tx_hash, time: isoTime(ts, 'ms'), order: ts, from, to, asset: `trc10:${id}`, decimals: null, raw } : null;
    }
    return null;
}

/** A TRC-20 transfer from a TronGrid `/transactions/trc20` row. Pure. */
export function trongridTrc20(t: any): Move | null {
    const tx_hash = hexHash(t?.transaction_id, false);
    const ts = countOf(t?.block_timestamp);
    const from = tronAddr(t?.from);
    const to = tronAddr(t?.to);
    const asset = tronAddr(t?.token_info?.address);
    const raw = digits(t?.value);
    if (!tx_hash || ts === undefined || !from || !to || !asset || !raw || (t?.type && str(t.type) !== 'Transfer')) return null;
    const dec = countOf(t.token_info?.decimals);
    return { tx_hash, time: isoTime(ts, 'ms'), order: ts, from, to, asset, symbol: str(t.token_info?.symbol) || undefined, decimals: dec !== undefined && dec <= 255 ? dec : null, raw };
}

export async function trongridAccount(http: Http, address: string): Promise<any | null> {
    const r = await http.get(V.trongrid, `${TRONGRID}v1/accounts/${address}`);
    if (!r || r.success === false) throw new VendorDown(V.trongrid.id, `${V.trongrid.name}: ${str(r?.error) || 'did not answer for the account'}`);
    return Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
}

const TG_PAGE = 200;

async function trongridFeed(http: Http, url: string, name: string, parse: (t: any) => Move | null, maxPages: number): Promise<Feed> {
    const feed = feedOf(name);
    let fingerprint = '';
    for (let page = 0; page < maxPages; page++) {
        const r = await http.get(V.trongrid, `${url}${url.includes('?') ? '&' : '?'}limit=${TG_PAGE}${fingerprint ? `&fingerprint=${encodeURIComponent(fingerprint)}` : ''}`);
        if (!r || r.success === false || !Array.isArray(r.data)) throw new VendorDown(V.trongrid.id, `${V.trongrid.name}: ${str(r?.error) || `unexpected ${name} answer`}`);
        for (const t of r.data) {
            note(feed, countOf(t?.block_timestamp));
            const m = parse(t);
            if (m) feed.rows.push(m);
        }
        fingerprint = str(r.meta?.fingerprint);
        if (!fingerprint || r.data.length < TG_PAGE) {
            feed.complete = true;
            break;
        }
        if (http.outOfTime) break;
    }
    return feed;
}

export async function trongridHistory(http: Http, address: string, maxPages: number): Promise<AccountHistory> {
    const acct = await trongridAccount(http, address);
    const feeds = [
        await trongridFeed(http, `${TRONGRID}v1/accounts/${address}/transactions`, 'transactions', trongridMove, maxPages),
        await trongridFeed(http, `${TRONGRID}v1/accounts/${address}/transactions/trc20`, 'trc20_transfers', trongridTrc20, maxPages),
    ];
    // No activated_at: create_time is the block before the activation, and First Funder writes the
    // activation's own block time; two members writing two times for one field left whichever ran
    // last (review of 1.0.0).
    const facts: Facts = acct ? { balance: sunBalance(acct.balance) } : { balance: '0' };
    return { kind: 'account', source: 'trongrid', vendor: V.trongrid.name, feeds, facts };
}

/** POST to a TronGrid `/wallet/` method. */
async function wallet(http: Http, method: string, body: Record<string, unknown>): Promise<any> {
    const r = await http.post(V.trongrid, `${TRONGRID}wallet/${method}`, body);
    if (r && typeof r === 'object' && r.Error) throw new VendorDown(V.trongrid.id, `${V.trongrid.name}: ${str(r.Error)}`);
    return r;
}

/** `/wallet/getcontract`: the contract's deployer (`origin_address`), or null for an account that is not one. */
export async function tronContract(http: Http, address: string): Promise<{ deployer?: string; name?: string } | null> {
    const r = await wallet(http, 'getcontract', { value: address, visible: true });
    if (!r || typeof r !== 'object' || !r.contract_address) return null;
    return { deployer: tronAddr(r.origin_address) ?? undefined, name: str(r.name) || undefined };
}

/** A read-only call through `/wallet/triggerconstantcontract`; the first result word, or undefined. */
export async function tronCall(http: Http, contract: string, selector: string, parameter = ''): Promise<string | undefined> {
    const r = await wallet(http, 'triggerconstantcontract', {
        owner_address: ZERO_CALLER,
        contract_address: contract,
        function_selector: selector,
        parameter,
        visible: true,
    });
    if (r?.result?.result !== true || !Array.isArray(r.constant_result)) return undefined;
    return str(r.constant_result[0]) || undefined;
}

export async function trc20Meta(http: Http, token: string): Promise<{ name?: string; symbol?: string; decimals?: number }> {
    const n = await tronCall(http, token, 'name()');
    const s = await tronCall(http, token, 'symbol()');
    const d = await tronCall(http, token, 'decimals()');
    return { name: abiString(n), symbol: abiString(s), decimals: abiUint(d, 255) };
}

/** `isBlackListed(address)` on a TRON token, or undefined when it does not answer. */
export async function tronFlag(http: Http, token: string, selector: string, address: string): Promise<boolean | undefined> {
    const hex = tronHex20(address);
    if (!hex) return undefined;
    return abiBool(await tronCall(http, token, selector, abiAddressWord(hex)));
}

/** TRC-20 Transfer events in a transaction's logs (decimals unknown). Pure. */
export function tronTransferLogs(info: any, tx_hash: string, ts: number): Move[] {
    const out: Move[] = [];
    for (const l of Array.isArray(info?.log) ? info.log : []) {
        const t = l?.topics;
        if (!Array.isArray(t) || t.length !== 3 || str(t[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
        const asset = tronAddr(l.address);
        const from = tronAddr(str(t[1]).slice(-40));
        const to = tronAddr(str(t[2]).slice(-40));
        const raw = /^[0-9a-fA-F]{1,64}$/.test(str(l.data)) ? BigInt('0x' + str(l.data)).toString() : null;
        if (!asset || !from || !to || !raw || raw === '0') continue;
        out.push({ tx_hash, time: isoTime(ts, 'ms'), order: ts, from, to, asset, decimals: null, raw });
    }
    return out;
}

export async function trongridTx(http: Http, hash: string): Promise<AccountTx | null> {
    const tx = await wallet(http, 'gettransactionbyid', { value: hash, visible: true });
    if (!tx || !tx.txID) return null;
    const info = await wallet(http, 'gettransactioninfobyid', { value: hash });
    const ts = countOf(info?.blockTimeStamp) ?? countOf(tx.raw_data?.timestamp) ?? 0;
    const ok = str(tx.ret?.[0]?.contractRet) === 'SUCCESS';
    const c = tx.raw_data?.contract?.[0];
    const moves: Move[] = [];
    const direct = trongridMove({ ...tx, block_timestamp: ts });
    if (direct) moves.push(direct);
    if (ok) moves.push(...tronTransferLogs(info, hexHash(hash, false)!, ts));
    const fee = countOf(info?.fee);
    return {
        tx_hash: hexHash(tx.txID, false)!,
        block_height: countOf(info?.blockNumber),
        block_time: isoTime(ts, 'ms'),
        status: !info?.blockNumber ? 'pending' : ok ? 'success' : 'failed',
        fee: fee !== undefined ? (formatUnits(String(fee), SUN) ?? undefined) : undefined,
        tx_kind: c?.type === 'CreateSmartContract' ? 'contract_creation' : c?.type === 'TriggerSmartContract' ? 'contract_call' : /Transfer/.test(str(c?.type)) ? 'transfer' : 'other',
        signer: tronAddr(c?.parameter?.value?.owner_address) ?? undefined,
        moves,
        created_contract: c?.type === 'CreateSmartContract' ? (tronAddr(info?.contract_address) ?? undefined) : undefined,
    };
}

/**
 * Who activated a TRON account: the TronGrid rule of X-26.
 *
 * `create_time` is the time of the block BEFORE the one holding the activation (3 s apart, measured
 * 2026-11-14), so a search at that exact time misses the activation. The activation is a
 * transaction in the first block after `create_time` that pays this address — TRX or TRC-10
 * (`to_address`) — or creates it (`AccountCreateContract`, `account_address`); its sender is the
 * first funder. Anything else is "could not tell": the earliest incoming transfer is not the
 * activation when an address was activated by a contract's internal transfer, and on a burn
 * address an older `CreateSmartContract` by another owner came first (measured 2026-11-14).
 *
 * "First block after" allows one missed slot (6 s): TRON produces a block every 3 s, and the
 * rows only hold blocks with a transaction for this address, so a row further out is not the
 * block after `create_time`.
 */
export function activationFrom(rows: any[], address: string, createTime: number): { funder: string; tx_hash: string; time: string; raw?: string; kind: string } | null {
    const later = rows.filter((t) => (countOf(t?.block_timestamp) ?? 0) > createTime);
    if (!later.length) return null;
    const first = Math.min(...later.map((t) => countOf(t.block_timestamp)!));
    if (first - createTime > 6_000) return null;
    for (const t of later) {
        if (countOf(t.block_timestamp) !== first) continue;
        const c = t?.raw_data?.contract?.[0];
        const v = c?.parameter?.value;
        if (!v || str(t?.ret?.[0]?.contractRet) !== 'SUCCESS') continue;
        const pays = (c.type === 'TransferContract' || c.type === 'TransferAssetContract') && tronAddr(v.to_address) === address;
        const creates = c.type === 'AccountCreateContract' && tronAddr(v.account_address) === address;
        if (!pays && !creates) continue;
        const funder = tronAddr(v.owner_address);
        const tx_hash = hexHash(t.txID, false);
        if (!funder || !tx_hash) continue;
        return {
            funder,
            tx_hash,
            time: isoTime(first, 'ms')!,
            raw: c.type === 'TransferContract' ? (digits(v.amount) ?? undefined) : undefined,
            kind: c.type,
        };
    }
    return null;
}

export async function trongridActivation(http: Http, address: string): Promise<
    | { state: 'inactive' }
    | { state: 'unknown'; created: string; why: string }
    | { state: 'found'; created: string; funder: string; tx_hash: string; time: string; amount?: string; kind: string }
> {
    const acct = await trongridAccount(http, address);
    const created = countOf(acct?.create_time);
    if (!acct || created === undefined) return { state: 'inactive' };
    const r = await http.get(
        V.trongrid,
        `${TRONGRID}v1/accounts/${address}/transactions?only_to=true&min_timestamp=${created}&order_by=block_timestamp,asc&limit=20`,
    );
    if (!r || r.success === false || !Array.isArray(r.data)) throw new VendorDown(V.trongrid.id, `${V.trongrid.name}: unexpected answer for the account's first transactions`);
    const hit = activationFrom(r.data, address, created);
    const createdIso = isoTime(created, 'ms')!;
    if (!hit) return { state: 'unknown', created: createdIso, why: 'no transfer to it or account creation in the block after its creation time (activated by a contract call, or not served)' };
    return { state: 'found', created: createdIso, funder: hit.funder, tx_hash: hit.tx_hash, time: hit.time, amount: hit.raw ? (formatUnits(hit.raw, SUN) ?? undefined) : undefined, kind: hit.kind };
}

// ---- Tronscan ---------------------------------------------------------------------------------

/** TRX and TRC-10 transfers from a Tronscan `/api/transaction` row. Pure. */
export function tronscanMove(t: any): Move | null {
    const tx_hash = hexHash(t?.hash, false);
    const ts = countOf(t?.timestamp);
    if (!tx_hash || ts === undefined || str(t?.contractRet) !== 'SUCCESS' || t?.revert === true) return null;
    const from = tronAddr(t.ownerAddress);
    const to = tronAddr(t.toAddress);
    const raw = digits(t.contractData?.amount);
    if (!from || !to || !raw) return null;
    if (t.contractType === 1) return { tx_hash, time: isoTime(ts, 'ms'), order: ts, from, to, asset: NATIVE, symbol: 'TRX', decimals: SUN, raw };
    if (t.contractType === 2) {
        const id = str(t.contractData?.asset_name);
        const dec = countOf(t.contractData?.tokenInfo?.tokenDecimal);
        return /^\d+$/.test(id)
            ? { tx_hash, time: isoTime(ts, 'ms'), order: ts, from, to, asset: `trc10:${id}`, symbol: str(t.contractData?.tokenInfo?.tokenAbbr) || undefined, decimals: dec ?? null, raw }
            : null;
    }
    return null;
}

/** A TRC-20 transfer from a Tronscan `/api/token_trc20/transfers` row. Pure. */
export function tronscanTrc20(t: any): Move | null {
    const tx_hash = hexHash(t?.transaction_id, false);
    const ts = countOf(t?.block_ts);
    const from = tronAddr(t?.from_address);
    const to = tronAddr(t?.to_address);
    const asset = tronAddr(t?.contract_address);
    const raw = digits(t?.quant);
    if (!tx_hash || ts === undefined || !from || !to || !asset || !raw) return null;
    if (t.finalResult && str(t.finalResult) !== 'SUCCESS') return null;
    if (t.event_type && str(t.event_type) !== 'Transfer') return null;
    const dec = countOf(t.tokenInfo?.tokenDecimal);
    return { tx_hash, time: isoTime(ts, 'ms'), order: ts, from, to, asset, symbol: str(t.tokenInfo?.tokenAbbr) || undefined, decimals: dec ?? null, raw };
}

const TS_PAGE = 50;

export async function tronscanHistory(http: Http, address: string, maxPages: number): Promise<AccountHistory> {
    const v = V.tronscan;
    const feeds: Feed[] = [];
    let tx_count: number | undefined;
    for (const [name, path, key, parse] of [
        ['transactions', 'transaction?sort=-timestamp&count=true&address=', 'data', tronscanMove],
        ['trc20_transfers', 'token_trc20/transfers?sort=-timestamp&relatedAddress=', 'token_transfers', tronscanTrc20],
    ] as const) {
        const feed = feedOf(name);
        for (let page = 0; page < maxPages; page++) {
            const r = await http.get(v, `${TRONSCAN}${path}${address}&limit=${TS_PAGE}&start=${page * TS_PAGE}`);
            const rows = r?.[key];
            if (!Array.isArray(rows)) throw new VendorDown(v.id, `${v.name}: unexpected ${name} answer`);
            if (name === 'transactions' && page === 0) tx_count = countOf(r.rangeTotal) ?? countOf(r.total);
            for (const t of rows) {
                note(feed, countOf(t?.timestamp ?? t?.block_ts));
                const m = (parse as (t: any) => Move | null)(t);
                if (m) feed.rows.push(m);
            }
            if (rows.length < TS_PAGE) {
                feed.complete = true;
                break;
            }
            if (http.outOfTime) break;
        }
        feeds.push(feed);
    }
    return { kind: 'account', source: 'tronscan', vendor: v.name, feeds, facts: { tx_count } };
}

/** Tronscan's public tag for an address ("Binance-Hot 2"), or undefined. */
export async function tronscanTag(http: Http, address: string): Promise<string | undefined> {
    const r = await http.get(V.tronscan, `${TRONSCAN}account/tag?address=${address}`);
    return str(r?.publicTag) || undefined;
}

export async function tronscanTx(http: Http, hash: string): Promise<AccountTx | null> {
    const t = await http.get(V.tronscan, `${TRONSCAN}transaction-info?hash=${hash}`);
    if (!t || !t.hash) return null;
    const ts = countOf(t.timestamp) ?? 0;
    const moves: Move[] = [];
    const direct = tronscanMove(t);
    if (direct) moves.push(direct);
    for (const tr of Array.isArray(t.trc20TransferInfo) ? t.trc20TransferInfo : []) {
        const m = tronscanTrc20({
            transaction_id: t.hash,
            block_ts: ts,
            from_address: tr.from_address,
            to_address: tr.to_address,
            contract_address: tr.contract_address,
            quant: tr.amount_str,
            tokenInfo: { tokenAbbr: tr.symbol, tokenDecimal: tr.decimals },
        });
        if (m) moves.push(m);
    }
    // TRX burnt for bandwidth and energy plus the multi-signature and memo fees: what TronGrid's
    // `fee` sums for the same transaction (345000 sun both ways for f567b655…, 2026-11-15).
    const parts = ['net_fee', 'energy_fee', 'multi_sign_fee', 'memoFee'].map((k) => countOf(t.cost?.[k]));
    const fee = parts.some((x) => x !== undefined) ? parts.reduce<number>((a, x) => a + (x ?? 0), 0) : undefined;
    return {
        tx_hash: hexHash(t.hash, false)!,
        block_height: countOf(t.block),
        block_time: isoTime(ts, 'ms'),
        status: t.confirmed === false ? 'pending' : str(t.contractRet) === 'SUCCESS' && t.revert !== true ? 'success' : 'failed',
        fee: fee !== undefined ? (formatUnits(String(fee), SUN) ?? undefined) : undefined,
        tx_kind: t.contractType === 30 ? 'contract_creation' : t.contractType === 31 ? 'contract_call' : t.contractType === 1 || t.contractType === 2 ? 'transfer' : 'other',
        signer: tronAddr(t.ownerAddress) ?? undefined,
        moves,
    };
}
