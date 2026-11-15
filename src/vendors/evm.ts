// EVM vendors: Routescan (Etherscan-compatible), Blockscout's public explorers, Binplorer with the
// shared free key, and public JSON-RPC nodes.
//
// The parse functions are pure so test/pure.test.mjs can feed them recorded answers.
import { BINPLORER, BLOCKSCOUT, CHAINS, NATIVE, ROUTESCAN, RPC, V } from '../chains';
import type { Http } from '../http';
import { VendorDown } from '../http';
import type { AccountHistory, AccountTx, Facts, Feed, Move } from '../model';
import { abiAddressWord, abiBool, abiString, abiUint, countOf, evmAddress, formatUnits, hexHash, hexQuantity, isoTime, str, ZERO_ADDRESS } from '../values';

const digits = (v: unknown): string | null => {
    const s = str(v);
    return /^\d+$/.test(s) ? s : null;
};
const positive = (raw: string | null): raw is string => !!raw && !/^0+$/.test(raw);

function newFeed(name: string): Feed {
    return { name, rows: [], complete: false, oldest: null, examined: 0 };
}

function note(feed: Feed, order: number | null, time: string | undefined) {
    feed.examined++;
    if (order != null && (feed.oldest == null || order < feed.oldest)) feed.oldest = order;
    if (time && (!feed.newest || time > feed.newest)) feed.newest = time;
    if (time && (!feed.oldestTime || time < feed.oldestTime)) feed.oldestTime = time;
}

// ---- Routescan --------------------------------------------------------------------------------

/** Etherscan-style rows (txlist, txlistinternal, tokentx) as moves. Pure. */
export function routescanMove(feed: 'transactions' | 'internal' | 'token_transfers', it: any, native: string): Move | null {
    const order = countOf(it?.blockNumber);
    const tx_hash = hexHash(it?.hash, true);
    if (order === undefined || !tx_hash) return null;
    if (str(it.isError) === '1' || str(it.txreceipt_status) === '0') return null;
    const raw = digits(it.value);
    if (!positive(raw)) return null;
    const from = evmAddress(it.from);
    // Value sent with a contract creation goes to the new contract.
    const to = feed === 'token_transfers' ? evmAddress(it.to) : (evmAddress(it.to) ?? evmAddress(it.contractAddress));
    if (!from || !to) return null;
    const time = isoTime(it.timeStamp);
    if (feed === 'token_transfers') {
        const asset = evmAddress(it.contractAddress);
        if (!asset) return null;
        const dec = countOf(it.tokenDecimal);
        return { tx_hash, time, order, from, to, asset, symbol: str(it.tokenSymbol) || undefined, decimals: dec !== undefined && dec <= 255 ? dec : null, raw };
    }
    return { tx_hash, time, order, from, to, asset: NATIVE, symbol: native, decimals: 18, raw };
}

const ROUTESCAN_PAGE = 100;

async function routescan(http: Http, chainId: number, query: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(query).toString();
    const r = await http.get(V.routescan, `${ROUTESCAN(chainId)}?${qs}`);
    if (!r || typeof r !== 'object') throw new VendorDown(V.routescan.id, `${V.routescan.name}: unexpected answer`);
    // Etherscan's convention: status "0" with a string result is an error, and the message says
    // which. "No transactions found" is an empty list, not an error.
    if (str(r.status) === '0' && typeof r.result === 'string') {
        if (/rate limit/i.test(r.result)) throw http.giveUp(V.routescan, `rate limit (${r.result})`);
        throw new VendorDown(V.routescan.id, `${V.routescan.name}: ${r.result}`);
    }
    return r.result;
}

export async function routescanHistory(http: Http, network: string, address: string, maxPages: number): Promise<AccountHistory> {
    const chain = CHAINS[network];
    const chainId = chain.chainId!;
    const feeds: Feed[] = [];
    for (const [name, action] of [
        ['transactions', 'txlist'],
        ['token_transfers', 'tokentx'],
        ['internal', 'txlistinternal'],
    ] as const) {
        const feed = newFeed(name);
        for (let page = 1; page <= maxPages; page++) {
            const rows = await routescan(http, chainId, { module: 'account', action, address, page: String(page), offset: String(ROUTESCAN_PAGE), sort: 'desc' });
            if (!Array.isArray(rows)) throw new VendorDown(V.routescan.id, `${V.routescan.name}: unexpected ${action} answer`);
            for (const it of rows) {
                note(feed, countOf(it?.blockNumber) ?? null, isoTime(it?.timeStamp));
                const m = routescanMove(name, it, chain.native);
                if (m) feed.rows.push(m);
            }
            if (rows.length < ROUTESCAN_PAGE) {
                feed.complete = true;
                break;
            }
            if (http.outOfTime) break;
        }
        feeds.push(feed);
    }
    const bal = await routescan(http, chainId, { module: 'account', action: 'balance', address, tag: 'latest' });
    const facts: Facts = { balance: formatUnits(digits(bal) ?? '', 18) ?? undefined };
    return { kind: 'account', source: 'routescan', vendor: V.routescan.name, feeds, facts };
}

/** Contract creator and creation transaction, or null for an account that is not a contract. */
export async function routescanCreation(http: Http, network: string, address: string): Promise<{ deployer: string; tx_hash?: string } | null> {
    const r = await routescan(http, CHAINS[network].chainId!, { module: 'contract', action: 'getcontractcreation', contractaddresses: address });
    const row = Array.isArray(r) ? r[0] : null;
    const deployer = evmAddress(row?.contractCreator);
    return deployer ? { deployer, tx_hash: hexHash(row?.txHash, true) ?? undefined } : null;
}

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** ERC-20 Transfer logs of a receipt as moves (decimals unknown: the caller fills them). Pure. */
export function transferLogs(receipt: any, tx_hash: string, order: number, time: string | undefined): Move[] {
    const out: Move[] = [];
    for (const l of Array.isArray(receipt?.logs) ? receipt.logs : []) {
        const t = l?.topics;
        // Three topics: ERC-20. ERC-721 puts the token id in a fourth and moves no amount.
        if (!Array.isArray(t) || t.length !== 3 || str(t[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
        const asset = evmAddress(l.address);
        const from = evmAddress('0x' + str(t[1]).slice(-40));
        const to = evmAddress('0x' + str(t[2]).slice(-40));
        const raw = hexQuantity(str(l.data) === '0x' ? '0x0' : l.data);
        if (!asset || !from || !to || !positive(raw)) continue;
        out.push({ tx_hash, time, order, from, to, asset, decimals: null, raw });
    }
    return out;
}

export async function routescanTx(http: Http, network: string, hash: string): Promise<AccountTx | null> {
    const chain = CHAINS[network];
    const id = chain.chainId!;
    const tx = await routescan(http, id, { module: 'proxy', action: 'eth_getTransactionByHash', txhash: hash });
    if (!tx || typeof tx !== 'object') return null;
    const receipt = await routescan(http, id, { module: 'proxy', action: 'eth_getTransactionReceipt', txhash: hash });
    const block = hexQuantity(tx.blockNumber);
    let time: string | undefined;
    if (block) {
        const b = await routescan(http, id, { module: 'proxy', action: 'eth_getBlockByNumber', tag: tx.blockNumber, boolean: 'false' });
        time = isoTime(hexQuantity(b?.timestamp));
    }
    const order = block ? Number(block) : 0;
    const from = evmAddress(tx.from);
    const created = evmAddress(receipt?.contractAddress) ?? undefined;
    const to = evmAddress(tx.to) ?? created;
    const status = !block ? 'pending' : receipt?.status === '0x1' ? 'success' : receipt?.status === '0x0' ? 'failed' : undefined;
    const moves: Move[] = [];
    const value = hexQuantity(tx.value);
    if (status !== 'failed' && from && to && positive(value)) moves.push({ tx_hash: hash, time, order, from, to, asset: NATIVE, symbol: chain.native, decimals: 18, raw: value });
    if (status === 'success') moves.push(...transferLogs(receipt, hash, order, time));
    // Coin a contract paid out inside the transaction.
    if (status === 'success') {
        const internal = await routescan(http, id, { module: 'account', action: 'txlistinternal', txhash: hash });
        for (const it of Array.isArray(internal) ? internal : []) {
            const m = routescanMove('internal', { ...it, hash, blockNumber: String(order), timeStamp: it?.timeStamp }, chain.native);
            if (m) moves.push({ ...m, time: m.time ?? time });
        }
    }
    const gasUsed = hexQuantity(receipt?.gasUsed);
    const price = hexQuantity(receipt?.effectiveGasPrice ?? tx.gasPrice);
    return {
        tx_hash: hash,
        block_height: block ? Number(block) : undefined,
        block_time: time,
        status,
        fee: gasUsed && price ? (formatUnits((BigInt(gasUsed) * BigInt(price)).toString(), 18) ?? undefined) : undefined,
        // Call data alone does not make a contract call: a message sent to an EOA carries it too
        // (2026-11-10, a birthday note to vitalik.eth). Logs do.
        tx_kind: created ? 'contract_creation' : Array.isArray(receipt?.logs) && receipt.logs.length ? 'contract_call' : positive(value) ? 'transfer' : 'other',
        signer: from ?? undefined,
        moves,
        created_contract: created,
    };
}

// ---- Blockscout (eth.blockscout.com, explorer.optimism.io, etc.blockscout.com) ------------------

const bsBlock = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** A native move from a Blockscout transaction row. Pure. */
export function blockscoutTransaction(it: any, native: string): Move | null {
    const order = bsBlock(it?.block_number);
    const tx_hash = hexHash(it?.hash, true);
    if (order == null || !tx_hash) return null;
    if (it.status !== 'ok' && it.result !== 'success') return null;
    const raw = digits(it.value);
    if (!positive(raw)) return null;
    const from = evmAddress(it.from?.hash);
    const to = evmAddress(it.to?.hash) ?? evmAddress(it.created_contract?.hash);
    if (!from || !to) return null;
    return { tx_hash, time: isoTime(it.timestamp), order, from, to, asset: NATIVE, symbol: native, decimals: 18, raw };
}

/** An ERC-20 move from a Blockscout token-transfer row. Pure. */
export function blockscoutTokenTransfer(it: any): Move | null {
    const order = bsBlock(it?.block_number);
    const tx_hash = hexHash(it?.transaction_hash, true);
    const asset = evmAddress(it?.token?.address_hash ?? it?.token?.address);
    if (order == null || !tx_hash || !asset) return null;
    if (str(it.token_type || it.token?.type).toUpperCase() !== 'ERC-20') return null;
    const raw = digits(it.total?.value);
    if (!positive(raw)) return null;
    const from = evmAddress(it.from?.hash);
    const to = evmAddress(it.to?.hash);
    if (!from || !to) return null;
    const dec = countOf(it.total?.decimals) ?? countOf(it.token?.decimals);
    return { tx_hash, time: isoTime(it.timestamp), order, from, to, asset, symbol: str(it.token?.symbol) || undefined, decimals: dec !== undefined && dec <= 255 ? dec : null, raw };
}

/** A native move from a Blockscout internal-transaction row. Pure. */
export function blockscoutInternal(it: any, native: string): Move | null {
    const order = bsBlock(it?.block_number);
    const tx_hash = hexHash(it?.transaction_hash, true);
    if (order == null || !tx_hash || it.success === false || it.error) return null;
    const raw = digits(it.value);
    if (!positive(raw)) return null;
    const from = evmAddress(it.from?.hash);
    const to = evmAddress(it.to?.hash) ?? evmAddress(it.created_contract?.hash);
    if (!from || !to) return null;
    return { tx_hash, time: isoTime(it.timestamp), order, from, to, asset: NATIVE, symbol: native, decimals: 18, raw };
}

/**
 * Public labels from a Blockscout address object: the `name` aliases of its metadata (Blockscout's
 * metadata service, e.g. "Binance 14"), then `public_tags` (instances before v12). Pure.
 *
 * Anonymous requests to the public instances return `metadata: null` on the address itself for
 * labelled wallets (measured 2026-11-15 on Binance 14), while the same metadata is embedded in the
 * address objects of every list row; so a caller also reads the address's own entry in a row.
 */
export function blockscoutLabel(a: any): string | undefined {
    const names: Array<{ name: string; ordinal: number }> = [];
    for (const t of Array.isArray(a?.metadata?.tags) ? a.metadata.tags : []) {
        if (str(t?.tagType) === 'name' && str(t?.name)) names.push({ name: str(t.name), ordinal: typeof t.ordinal === 'number' ? t.ordinal : 0 });
    }
    const out = names.sort((x, y) => y.ordinal - x.ordinal).map((t) => t.name);
    for (const t of Array.isArray(a?.public_tags) ? a.public_tags : []) {
        const n = str(t?.display_name) || str(t?.label);
        if (n && !out.includes(n)) out.push(n);
    }
    return out.length ? out.slice(0, 3).join('; ') : undefined;
}

/**
 * Account kind from a Blockscout address object. An EOA that delegated to code under EIP-7702 is
 * reported `is_contract: true` with `proxy_type: "eip7702"`, and is still an EOA: it holds a key
 * and signs (pluginpack-blockscout-pro measured the same on OP Mainnet).
 */
export function blockscoutKind(a: any): 'eoa' | 'contract' | undefined {
    if (a?.is_contract === true) return a.proxy_type === 'eip7702' ? 'eoa' : 'contract';
    if (a?.is_contract === false) return 'eoa';
    return undefined;
}

function partyFields(a: any): Record<string, unknown> {
    const label = blockscoutLabel(a);
    const kind = blockscoutKind(a);
    const out: Record<string, unknown> = {};
    if (kind) out.address_kind = kind;
    if (label) {
        out.public_label = label;
        out.label_source = 'Blockscout';
    }
    return out;
}

export async function blockscoutAddress(http: Http, network: string, address: string): Promise<any | null> {
    const b = BLOCKSCOUT[network];
    return http.get(b.vendor, `${b.base}addresses/${address}`);
}

const BS_FEEDS = [
    { name: 'transactions', path: 'transactions', query: '' },
    { name: 'token_transfers', path: 'token-transfers', query: 'type=ERC-20' },
    { name: 'internal', path: 'internal-transactions', query: '' },
] as const;

export async function blockscoutHistory(http: Http, network: string, address: string, maxPages: number): Promise<AccountHistory> {
    const b = BLOCKSCOUT[network];
    const native = CHAINS[network].native;
    const info = await blockscoutAddress(http, network, address);
    if (!info || typeof info !== 'object' || !('hash' in info)) throw new VendorDown(b.vendor.id, `${b.vendor.name}: did not recognise the address`);
    const parties = new Map<string, Record<string, unknown>>();
    const feeds: Feed[] = [];
    let ownLabel = blockscoutLabel(info);
    for (const spec of BS_FEEDS) {
        const feed = newFeed(spec.name);
        let params: string = spec.query;
        for (let page = 0; page < maxPages; page++) {
            const r = await http.get(b.vendor, `${b.base}addresses/${address}/${spec.path}${params ? `?${params}` : ''}`);
            if (!r || !Array.isArray(r.items)) throw new VendorDown(b.vendor.id, `${b.vendor.name}: unexpected ${spec.path} answer`);
            for (const it of r.items) {
                note(feed, bsBlock(it?.block_number), isoTime(it?.timestamp));
                const m =
                    spec.name === 'transactions' ? blockscoutTransaction(it, native) : spec.name === 'token_transfers' ? blockscoutTokenTransfer(it) : blockscoutInternal(it, native);
                if (m) feed.rows.push(m);
                for (const a of [it?.from, it?.to, it?.created_contract]) {
                    const k = evmAddress(a?.hash);
                    if (!k) continue;
                    if (k === address) ownLabel ??= blockscoutLabel(a);
                    else if (!parties.has(k)) parties.set(k, partyFields(a));
                }
            }
            const next = r.next_page_params;
            if (!next || typeof next !== 'object') {
                feed.complete = true;
                break;
            }
            if (http.outOfTime) break;
            const qs = new URLSearchParams(spec.query);
            for (const [k, v] of Object.entries(next)) if (v !== null && v !== undefined) qs.set(k, String(v));
            params = qs.toString();
        }
        feeds.push(feed);
    }
    const facts: Facts = {
        balance: formatUnits(digits(info.coin_balance) ?? '', 18) ?? undefined,
        address_kind: blockscoutKind(info),
        public_label: ownLabel,
        label_source: ownLabel ? 'Blockscout' : undefined,
    };
    return { kind: 'account', source: b.source, vendor: b.vendor.name, feeds, facts, parties };
}

export async function blockscoutTx(http: Http, network: string, hash: string): Promise<AccountTx | null> {
    const b = BLOCKSCOUT[network];
    const native = CHAINS[network].native;
    const t = await http.get(b.vendor, `${b.base}transactions/${hash}`);
    if (!t || typeof t !== 'object' || !t.hash) return null;
    const order = bsBlock(t.block_number ?? t.block) ?? 0;
    const time = isoTime(t.timestamp);
    const moves: Move[] = [];
    const nat = blockscoutTransaction({ ...t, block_number: order }, native);
    if (nat) moves.push(nat);
    // Token transfers come in the transaction answer, up to a cap Blockscout marks as overflow.
    for (const tt of Array.isArray(t.token_transfers) ? t.token_transfers : []) {
        const m = blockscoutTokenTransfer({ ...tt, block_number: order, transaction_hash: t.hash, timestamp: t.timestamp });
        if (m) moves.push(m);
    }
    if (t.result === 'success' || t.status === 'ok') {
        const it = await http.get(b.vendor, `${b.base}transactions/${hash}/internal-transactions`);
        for (const row of Array.isArray(it?.items) ? it.items : []) {
            const m = blockscoutInternal({ ...row, block_number: order, transaction_hash: t.hash, timestamp: t.timestamp }, native);
            if (m) moves.push(m);
        }
    }
    const created = evmAddress(t.created_contract?.hash) ?? undefined;
    const fee = digits(t.fee?.value);
    return {
        tx_hash: hexHash(t.hash, true)!,
        block_height: order || undefined,
        block_time: time,
        status: t.status === 'ok' ? 'success' : t.status === 'error' ? 'failed' : t.result === 'pending' ? 'pending' : undefined,
        fee: fee ? (formatUnits(fee, 18) ?? undefined) : undefined,
        tx_kind: created ? 'contract_creation' : Array.isArray(t.transaction_types) && t.transaction_types.includes('contract_call') ? 'contract_call' : 'transfer',
        signer: evmAddress(t.from?.hash) ?? undefined,
        moves,
        created_contract: created,
    };
}

// ---- Binplorer (BNB Smart Chain, shared free key) ---------------------------------------------

const FREEKEY = 'freekey';
const BINPLORER_LIMIT = 100;
const THIRTY_DAYS_MS = 30 * 86_400_000;

export function binplorerOperation(op: any): Move | null {
    const tx_hash = hexHash(op?.transactionHash, true);
    const ts = countOf(op?.timestamp);
    const asset = evmAddress(op?.tokenInfo?.address);
    const from = evmAddress(op?.from);
    const to = evmAddress(op?.to);
    const raw = digits(op?.value);
    if (!tx_hash || ts === undefined || !asset || !from || !to || !positive(raw) || str(op?.type) !== 'transfer') return null;
    const dec = countOf(op.tokenInfo.decimals);
    return { tx_hash, time: isoTime(ts), order: ts, from, to, asset, symbol: str(op.tokenInfo.symbol) || undefined, decimals: dec !== undefined && dec <= 255 ? dec : null, raw };
}

export function binplorerTransaction(t: any): Move | null {
    const tx_hash = hexHash(t?.hash, true);
    const ts = countOf(t?.timestamp);
    const from = evmAddress(t?.from);
    const to = evmAddress(t?.to);
    const raw = digits(t?.rawValue);
    if (!tx_hash || ts === undefined || !from || !to || !positive(raw) || t?.success === false) return null;
    return { tx_hash, time: isoTime(ts), order: ts, from, to, asset: NATIVE, symbol: 'BNB', decimals: 18, raw };
}

function binplorerError(r: any): string | null {
    return r && typeof r === 'object' && r.error ? str(r.error.message) || 'error' : null;
}

export async function binplorerHistory(http: Http, address: string): Promise<AccountHistory> {
    const v = V.binplorer;
    const info = await http.get(v, `${BINPLORER}getAddressInfo/${address}?apiKey=${FREEKEY}`);
    const err = binplorerError(info);
    if (!info || err) throw new VendorDown(v.id, `${v.name}: ${err ?? 'did not recognise the address'}`);
    // The free key reaches 30 days back and 100 rows an answer: the window is the later of the two.
    const floor = isoTime(Date.now() - THIRTY_DAYS_MS, 'ms');
    const feeds: Feed[] = [];
    for (const [name, url] of [
        ['token_transfers', `${BINPLORER}getAddressHistory/${address}?apiKey=${FREEKEY}&type=transfer&limit=${BINPLORER_LIMIT}`],
        ['transactions', `${BINPLORER}getAddressTransactions/${address}?apiKey=${FREEKEY}&limit=${BINPLORER_LIMIT}`],
    ] as const) {
        const r = await http.get(v, url);
        const e = binplorerError(r);
        if (e) throw new VendorDown(v.id, `${v.name}: ${e}`);
        const rows = name === 'token_transfers' ? r?.operations : r;
        if (!Array.isArray(rows)) throw new VendorDown(v.id, `${v.name}: unexpected ${name} answer`);
        const feed = newFeed(name);
        for (const it of rows) {
            const ts = countOf(it?.timestamp);
            note(feed, ts ?? null, isoTime(ts));
            const m = name === 'token_transfers' ? binplorerOperation(it) : binplorerTransaction(it);
            if (m) feed.rows.push(m);
        }
        // Never complete: whatever came back, nothing older than 30 days could have.
        feed.complete = false;
        if (rows.length < BINPLORER_LIMIT) {
            feed.oldest = Math.floor((Date.now() - THIRTY_DAYS_MS) / 1000);
            feed.floorTime = floor;
        }
        feeds.push(feed);
    }
    const facts: Facts = { balance: formatUnits(digits(info?.ETH?.rawBalance) ?? '', 18) ?? undefined, tx_count: countOf(info?.countTxs) };
    return { kind: 'account', source: 'binplorer', vendor: v.name, feeds, facts };
}

export async function binplorerTx(http: Http, hash: string): Promise<AccountTx | null> {
    const v = V.binplorer;
    const t = await http.get(v, `${BINPLORER}getTxInfo/${hash}?apiKey=${FREEKEY}`);
    if (!t || binplorerError(t) || !t.hash) return null;
    const ts = countOf(t.timestamp) ?? 0;
    const moves: Move[] = [];
    const nat = binplorerTransaction({ ...t, rawValue: t.rawValue ?? undefined });
    if (nat) moves.push({ ...nat, order: countOf(t.blockNumber) ?? ts });
    for (const op of Array.isArray(t.operations) ? t.operations : []) {
        const m = binplorerOperation({ ...op, transactionHash: t.hash, timestamp: op?.timestamp ?? ts });
        if (m) moves.push({ ...m, order: countOf(t.blockNumber) ?? ts });
    }
    const gas = countOf(t.gasUsed);
    const price = digits(t.gasPrice);
    return {
        tx_hash: hexHash(t.hash, true)!,
        block_height: countOf(t.blockNumber),
        block_time: isoTime(ts),
        status: t.success === true ? 'success' : t.success === false ? 'failed' : undefined,
        fee: gas !== undefined && price ? (formatUnits((BigInt(gas) * BigInt(price)).toString(), 18) ?? undefined) : undefined,
        signer: evmAddress(t.from) ?? undefined,
        tx_kind: moves.some((m) => m.asset !== NATIVE) ? 'contract_call' : 'transfer',
        moves,
    };
}

// ---- public JSON-RPC --------------------------------------------------------------------------

export interface RpcCall {
    method: string;
    params: unknown[];
}

/** One batch of JSON-RPC calls; results in order, or undefined for a call that errored. */
export async function rpc(http: Http, network: string, calls: RpcCall[]): Promise<Array<any | undefined>> {
    const node = RPC[network];
    const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
    const r = await http.post(node.vendor, node.url, calls.length === 1 ? body[0] : body);
    const list = Array.isArray(r) ? r : r ? [r] : [];
    if (!list.length) throw new VendorDown(node.vendor.id, `${node.vendor.name}: no JSON-RPC answer for ${network}`);
    return calls.map((_, i) => {
        const hit = list.find((x: any) => x?.id === i + 1);
        return hit && !hit.error ? hit.result : undefined;
    });
}

/** Nonce, balance and code: what Identify network asks each EVM chain. */
export async function evmActivity(http: Http, network: string, address: string): Promise<{ nonce?: number; balance?: string; code?: string }> {
    const [n, b, c] = await rpc(http, network, [
        { method: 'eth_getTransactionCount', params: [address, 'latest'] },
        { method: 'eth_getBalance', params: [address, 'latest'] },
        { method: 'eth_getCode', params: [address, 'latest'] },
    ]);
    const nonce = hexQuantity(n);
    // None of the three can fail for a well-formed address, so three errors are the node's own
    // (a JSON-RPC rate limit arrives as HTTP 200 with an error per call), not "nothing here":
    // Identify network would otherwise read a throttled chain as an address with no activity.
    if (nonce === null && hexQuantity(b) === null && typeof c !== 'string') {
        const node = RPC[network];
        throw new VendorDown(node.vendor.id, `${node.vendor.name}: answered none of nonce, balance and code`);
    }
    return { nonce: nonce !== null ? Number(nonce) : undefined, balance: hexQuantity(b) ?? undefined, code: typeof c === 'string' ? c : undefined };
}

/** EIP-7702 delegation designator: code `0xef0100` + 20-byte address. The account is still an EOA. */
export const isDelegation = (code: string): boolean => /^0xef0100[0-9a-fA-F]{40}$/.test(code);

const SEL = { name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567' } as const;

/** ERC-20 metadata by eth_call, or undefined fields when the contract does not answer them. */
export async function erc20Meta(http: Http, network: string, token: string): Promise<{ name?: string; symbol?: string; decimals?: number }> {
    const [n, s, d] = await rpc(
        http,
        network,
        (['name', 'symbol', 'decimals'] as const).map((k) => ({ method: 'eth_call', params: [{ to: token, data: SEL[k] }, 'latest'] })),
    );
    return { name: abiString(n), symbol: abiString(s), decimals: abiUint(d, 255) };
}

/** A boolean view function `selector(address)` of `contract`, or undefined when it does not answer. */
export async function evmFlag(http: Http, network: string, contract: string, selector: string, address: string): Promise<boolean | undefined> {
    const [r] = await rpc(http, network, [{ method: 'eth_call', params: [{ to: contract, data: selector + abiAddressWord(address) }, 'latest'] }]);
    return abiBool(r);
}

export { ZERO_ADDRESS };
