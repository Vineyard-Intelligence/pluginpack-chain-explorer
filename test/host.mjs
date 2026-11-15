// A host that behaves like the app's closely enough for the pack's tests, and the recorder and
// player for vendor answers. Shared by live-test.mjs (records) and test-plugin.mjs (replays).
//
// Node data is checked against the Cryptocurrency type pack's declared properties (enum values,
// regex validators, types), read from ../typepack-cryptocurrency or CRYPTO_TYPEPACK — the refusal the
// app makes in validate-node.ts. Identity folds the way the app's identity-normalize.ts does for the
// values this pack writes.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const typepackPath = process.env.CRYPTO_TYPEPACK ?? join(here, '..', 'typepack-cryptocurrency', 'typepacks', 'cryptocurrency.json');
export const TYPES = existsSync(typepackPath)
    ? Object.fromEntries(JSON.parse(readFileSync(typepackPath, 'utf8')).types.map((t) => [`${t.category}.${t.name}`, t]))
    : null;
export const typepackNote = TYPES ? `type pack: ${typepackPath}` : `SKIP property validation: ${typepackPath} not found (set CRYPTO_TYPEPACK)`;

const STRINGY = new Set(['string', 'text', 'hash', 'url', 'date', 'datetime']);
export function invalid(type, data, { delta = false } = {}) {
    if (!type.startsWith('cryptocurrency.')) return null;
    if (!TYPES) return null;
    const t = TYPES[type];
    if (!t) return `type ${type} is not in the Cryptocurrency type pack`;
    for (const [k, val] of Object.entries(data)) {
        const def = t.properties[k];
        if (!def || val == null || val === '') continue; // undeclared keys pass, as in the app
        // Worded as the app's validate-node.ts words it: the members recognise the refusal by it.
        if (def.type === 'enum' && !def.enum.includes(val)) return `${type}: ${k} must be one of ${def.enum.map((o) => JSON.stringify(o)).join(', ')} — got "${val}"`;
        if (STRINGY.has(def.type) && typeof val !== 'string') return `${type}.${k}: not a string`;
        if (def.type === 'integer' && !Number.isInteger(val)) return `${type}.${k}: not an integer`;
        if (def.type === 'boolean' && typeof val !== 'boolean') return `${type}.${k}: not a boolean`;
        if (def.type === 'array' && !Array.isArray(val)) return `${type}.${k}: not an array`;
        if (def.type === 'datetime' && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(val)) return `${type}.${k}: "${val}" is not an ISO time`;
        if (def.validator?.regex && !new RegExp(def.validator.regex).test(String(val))) return `${type}.${k}: "${val}" fails ${def.validator.regex}`;
        if (typeof def.validator?.min === 'number' && val < def.validator.min) return `${type}.${k}: below ${def.validator.min}`;
    }
    for (const k of delta ? [] : (t.identity_properties ?? [t.label_property])) {
        if (t.properties[k]?.optional === false && (data[k] == null || data[k] === '')) return `${type}: required ${k} missing`;
    }
    return null;
}

/** The app's `crypto_address` fold for the values this pack writes: hex, bech32, CashAddr, TON raw. */
function foldAddress(s) {
    if (typeof s !== 'string') return s;
    if (/^0x[0-9a-fA-F]{40}$/.test(s) || /^-?\d+:[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
    if (/^(bc|ltc|btg|bnb|addr|stake)1[02-9ac-hj-np-z]+$/i.test(s) && (s === s.toLowerCase() || s === s.toUpperCase())) return s.toLowerCase();
    const cash = /^(?:bitcoincash:)?([qpzr][02-9ac-hj-np-z]{41}|[qpzr][02-9ac-hj-np-z]{60})$/i.exec(s);
    if (cash && (s === s.toLowerCase() || s === s.toUpperCase())) return cash[1].toLowerCase();
    return s;
}
const foldHex = (s) => (typeof s === 'string' && /^(?:0x)?[0-9a-fA-F]{64}$/.test(s) ? s.replace(/^0x/i, '').toLowerCase() : s);

export function identity(type, d) {
    if (type === 'cryptocurrency.crypto_address') return `${type}|${d.network}|${foldAddress(d.address)}|${d.memo ?? ''}`;
    if (type === 'cryptocurrency.crypto_transaction') return `${type}|${d.network}|${foldHex(d.tx_hash)}`;
    if (type === 'cryptocurrency.crypto_token') return `${type}|${d.network}|${foldAddress(d.contract_address)}`;
    return null;
}

/**
 * The graph a plugin sees. `edgeData`: whether graph.edges() hands back each link's data. The app's
 * does (host-bridge.ts toEdge, frontend main 2026-11-16), so that is the default; false strips it,
 * as an older app's toEdge did (id, endpoints and label only, read 2026-11-15).
 */
export function makeGraph(nodeList = [], edgeList = [], { edgeData = true, refuse = null } = {}) {
    const nodes = new Map(nodeList.map((n) => [n.id, structuredClone(n)]));
    const live = edgeList.map((e) => structuredClone(e));
    const g = { created: [], updates: [], edgeCreates: [], edgeUpdates: [], errors: [], nodes, live };
    let seq = 0;
    Object.assign(g, {
        async get(id) {
            return nodes.get(id) ?? null;
        },
        async list() {
            return { nodes: [...nodes.values()] };
        },
        async edges() {
            return live.map(({ data, ...e }) => (edgeData ? { ...e, ...(data != null ? { data: structuredClone(data) } : {}) } : e));
        },
        async createNode(d) {
            const bad = (refuse && refuse(d.type, d.data)) || invalid(d.type, d.data);
            if (bad) {
                g.errors.push(bad);
                throw new Error(bad);
            }
            const key = identity(d.type, d.data);
            const hit = key && [...nodes.values()].find((n) => identity(n.type, n.data) === key);
            if (hit) {
                for (const [k, v] of Object.entries(d.data)) if (v != null && v !== '') hit.data[k] = v;
                return hit;
            }
            const n = { id: `staged_${++seq}`, type: d.type, data: { ...d.data } };
            nodes.set(n.id, n);
            g.created.push(n);
            return n;
        },
        async updateNode(id, data) {
            const n = nodes.get(id);
            const bad = n ? invalid(n.type, data, { delta: true }) : `no node ${id}`;
            if (bad) {
                g.errors.push(bad);
                throw new Error(bad);
            }
            g.updates.push({ id, data });
            for (const [k, v] of Object.entries(data)) if (v != null && v !== '') n.data[k] = v;
        },
        async createEdge(e) {
            const have = live.find((x) => x.from_node_id === e.from && x.to_node_id === e.to);
            if (have && have.label !== e.label) g.errors.push(`relabel ${have.label} -> ${e.label}`);
            if (have) {
                g.errors.push(`createEdge on a linked pair ${e.from}>${e.to}`);
                return;
            }
            for (const k of ['confidence', 'confidence_source', 'label_source', 'corroborated_by']) if (e.data && k in e.data) g.errors.push(`reserved edge key ${k}`);
            const edge = { id: `edge_${live.length + 1}`, from_node_id: e.from, to_node_id: e.to, label: e.label, data: { ...(e.data ?? {}) } };
            live.push(edge);
            g.edgeCreates.push(e);
        },
        async updateEdge(id, patch) {
            const e = live.find((x) => x.id === id);
            if (!e) {
                g.errors.push(`no edge ${id}`);
                throw new Error(`no edge ${id}`);
            }
            g.edgeUpdates.push({ id, patch });
            Object.assign(e.data, patch.data ?? {});
        },
    });
    return g;
}

export function makeCtx({ graph, selection = [], params = {}, net, signal, platform = 'web' }) {
    const log = [];
    return {
        log,
        ctx: {
            run: { runId: 'test', projectId: 'test', pluginId: 'test', grantedScopes: {}, platform },
            input: { selection },
            params,
            config: {},
            graph,
            net: net ? { fetch: net } : undefined,
            progress: { set() {}, log: (l) => log.push(l), status() {} },
            signal,
            onCancel() {},
        },
    };
}

// ---- recording and replay ---------------------------------------------------------------------

/** Keys no member reads that make recorded answers large: scripts, signatures, ABIs, prices. */
const HEAVY = new Set([
    'witness',
    'scriptsig',
    'scriptsig_asm',
    'scriptpubkey_asm',
    'inner_redeemscript_asm',
    'inner_witnessscript_asm',
    'abi',
    'bytecode',
    'raw_data_hex',
    'logsBloom',
    'raw_input',
    'decoded_input',
    'TxnSignature',
    'SigningPubKey',
    'Memos',
    'AffectedNodes',
    'message_content',
    'init_state',
    'scriptSig',
    'price',
    'usdValue',
    'tokenLogo',
    'icon_url',
    'exchange_rate',
    'historic_exchange_rate',
    'tokens',
    'witnesses',
    'contractMap',
    'contractInfo',
    'normalAddressInfo',
    'address_book',
    'gas_price',
    'gas_limit',
    'gas_used',
    'max_fee_per_gas',
    'max_priority_fee_per_gas',
    'priority_fee',
    'base_fee_per_gas',
    'transaction_burnt_fee',
    'confirmation_duration',
    'authorization_list',
    'implementations',
    'watchlist_names',
    'private_tags',
    'holders_count',
    'circulating_market_cap',
    'volume_24h',
    'total_supply',
    'circulating_supply',
    'storage_ph',
    'compute_ph',
    'action',
    'credit_ph',
    'block_ref',
    'trace_id',
    'mc_block_seqno',
    'energy_penalty_total',
]);

export function trim(v) {
    if (Array.isArray(v)) return v.map(trim);
    if (v && typeof v === 'object') {
        const out = {};
        // A Blockscout tag's `meta` holds styling, inline SVG icons among it; TronGrid's `meta`
        // (the paging fingerprint) is read and stays.
        const tag = 'tagType' in v;
        // An Etherscan-style list row's `input` is never read (the transaction lookup's is); TronGrid
        // signs with an array of signatures, where Solana's `signature` is the row's own id.
        const row = 'functionName' in v;
        for (const [k, x] of Object.entries(v)) {
            if (HEAVY.has(k) || (tag && k === 'meta') || (row && (k === 'input' || k === 'functionName')) || (k === 'signature' && Array.isArray(x))) continue;
            out[k] = trim(x);
        }
        return out;
    }
    return v;
}

export const keyOf = (url, init) => `${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`;

/** A real fetch with a browser's Origin header, recording each answer (trimmed) into `tape`. */
export function recorder(tape, { block = [] } = {}) {
    return async (url, init = {}) => {
        const k = keyOf(url, init);
        const host = new URL(url).host;
        if (block.some((b) => host.includes(b) || url.includes(b))) {
            const r = { key: k, status: 429, body: '{"error":"blocked by the test to exercise the next vendor"}' };
            tape.push(r);
            return mkResponse(r);
        }
        let res;
        try {
            res = await fetch(url, {
                method: init.method ?? 'GET',
                headers: { ...(init.headers ?? {}), Origin: 'https://app.vineyard.run' },
                body: init.body,
                signal: AbortSignal.timeout(Math.min(init.timeoutMs ?? 45000, 60000)),
            });
        } catch (e) {
            tape.push({ key: k, error: e?.name === 'TimeoutError' ? 'TimeoutError' : 'NetworkError' });
            const err = new Error('network error');
            err.name = e?.name === 'TimeoutError' ? 'TimeoutError' : 'TypeError';
            throw err;
        }
        let text = await res.text();
        let body = text;
        try {
            body = JSON.stringify(trim(JSON.parse(text)));
        } catch {
            // not JSON: kept as it came
        }
        const r = { key: k, status: res.status, body };
        tape.push(r);
        return mkResponse(r);
    };
}

function mkResponse(r) {
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: {}, text: async () => r.body, json: async () => JSON.parse(r.body) };
}

/** Replays a tape: each request must have been recorded, and identical requests replay in order. */
export function player(tape) {
    const queues = new Map();
    for (const r of tape) {
        if (!queues.has(r.key)) queues.set(r.key, []);
        queues.get(r.key).push(r);
    }
    const missing = [];
    const fetch = async (url, init = {}) => {
        const k = keyOf(url, init);
        const q = queues.get(k);
        const r = q && (q.length > 1 ? q.shift() : q[0]);
        if (!r) {
            missing.push(k);
            const err = new Error(`not recorded: ${k}`);
            err.name = 'TypeError';
            throw err;
        }
        if (r.error) {
            const err = new Error('network error');
            err.name = r.error === 'TimeoutError' ? 'TimeoutError' : 'TypeError';
            throw err;
        }
        return mkResponse(r);
    };
    return { fetch, missing };
}
