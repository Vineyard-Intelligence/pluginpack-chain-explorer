// Writing what a source answered: `sent to` links for account chains, transaction nodes with
// `input to` / `output to` links for the Bitcoin family. Shared by Address History and Transaction.
import type { Links, Nodes } from './graph';
import { aggregate, recentFor } from './flows';
import { utxoKind } from './formats';
import type { AccountHistory, Feed, Move, Part, UtxoHistory, UtxoTx } from './model';
import { compact, formatUnits } from './values';

const SATS = 8;

export interface Seed {
    id: string;
    network: string;
    address: string;
    memo?: string;
}

export interface Written {
    links: number;
    /** Counterparties beyond the cap, not linked. */
    notLinked: number;
    /** Existing links whose `recent` list was left alone (the host did not show their data). */
    recentKept: number;
    complete: boolean;
    beforeWindow: number;
}

/** `sent to` links for one account-chain history, and the seed's own fields as a delta. */
export async function writeAccountHistory(
    seed: Seed,
    h: AccountHistory,
    links: Links,
    nodes: Nodes,
    maxPairs: number,
    asOf: string,
): Promise<{ written: Written; delta: Record<string, unknown> }> {
    const flow = aggregate(seed.address, h.feeds, seed.memo);
    const kept = flow.pairs.slice(0, maxPairs);
    let recentKept = 0;
    let wrote = 0;
    const summaryKey = `summary_${h.source}`;
    for (const p of kept) {
        const outgoing = p.from === seed.address;
        const other = outgoing ? p.to : p.from;
        const otherMemo = outgoing ? p.to_memo : undefined;
        const otherId = await nodes.address(seed.network, other, h.parties?.get(other) ?? {}, otherMemo);
        const fromId = outgoing ? seed.id : otherId;
        const toId = outgoing ? otherId : seed.id;
        const summary = compact({
            window_from: flow.window_from,
            window_to: asOf,
            complete: flow.complete,
            // Which lists the figures come from: `complete` speaks for these only.
            feeds: h.feeds.map((f) => f.name),
            assets: p.assets,
            assets_omitted: p.assets_omitted || undefined,
        });
        const r = await links.put(fromId, toId, 'sent to', (have) => {
            const recent = recentFor(have, p.recent);
            if (!recent) recentKept++;
            return compact({ network: seed.network, [summaryKey]: summary, recent });
        });
        if (r !== 'skipped') wrote++;
    }
    const examined = h.feeds.reduce((a, f) => a + f.examined, 0);
    // A seed with a memo (an XRPL destination tag) sees only the rows paid to its tag, while the
    // feeds' times are the whole account's: its first and last activity are its own rows'.
    // history_examined stays the account's rows read, which is how far back its payments were
    // looked for (with history_complete).
    const own = seed.memo !== undefined;
    const newest = own ? flow.last : latest(h.feeds.map((f) => f.newest));
    const oldest = own ? flow.first : earliest(h.feeds.map((f) => f.oldestTime));
    const delta = compact({
        ...factsDelta(h.facts, h.vendor, asOf),
        last_seen: h.facts.last_seen ?? newest,
        first_seen: h.facts.first_seen ?? (flow.complete ? oldest : undefined),
        history_examined: examined,
        history_complete: flow.complete,
    });
    return { written: { links: wrote, notLinked: flow.pairs.length - kept.length, recentKept, complete: flow.complete, beforeWindow: flow.beforeWindow }, delta };
}

function factsDelta(f: AccountHistory['facts'], vendor: string, asOf: string): Record<string, unknown> {
    return compact({
        balance: f.balance,
        balance_as_of: f.balance !== undefined ? asOf : undefined,
        balance_source: f.balance !== undefined ? vendor : undefined,
        tx_count: f.tx_count,
        address_kind: f.address_kind,
        activated_at: f.activated_at,
        public_label: f.public_label,
        label_source: f.label_source,
    });
}

const latest = (xs: Array<string | undefined>): string | undefined => xs.filter(Boolean).sort().pop();
const earliest = (xs: Array<string | undefined>): string | undefined => xs.filter(Boolean).sort()[0];

interface Grouped {
    address: string;
    raw: bigint;
    parts: Part[];
}

function group(parts: Part[]): Grouped[] {
    const by = new Map<string, Grouped>();
    for (const p of parts) {
        if (!p.address) continue;
        let g = by.get(p.address);
        if (!g) by.set(p.address, (g = { address: p.address, raw: 0n, parts: [] }));
        g.raw += BigInt(p.raw);
        g.parts.push(p);
    }
    return [...by.values()].sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : a.address < b.address ? -1 : 1));
}

const coins = (raw: bigint | string) => formatUnits(typeof raw === 'bigint' ? raw.toString() : raw, SATS) ?? '0';

/**
 * One Bitcoin-family transaction as a node, with `input to` from each address that funded it and
 * `output to` to each address it paid. A pair has one link however many times the address appears,
 * so the link carries the total and the list of inputs or outputs (the type pack's link table).
 *
 * `focus`, when given, is always linked; the other addresses are capped per side, largest amounts
 * first: an exchange's batch payout pays hundreds.
 */
export async function writeUtxoTx(
    network: string,
    tx: UtxoTx,
    links: Links,
    nodes: Nodes,
    maxParties: number,
    focus?: { id: string; address: string },
): Promise<{ txId: string; links: number; notLinked: number; truncated: boolean }> {
    const txId = await nodes.transaction(
        network,
        tx.txid,
        compact({
            block_height: tx.block_height,
            block_time: tx.block_time,
            status: tx.confirmed ? 'success' : 'pending',
            fee: tx.fee,
            tx_kind: tx.coinbase ? 'coinbase' : 'transfer',
        }),
    );
    let wrote = 0;
    let notLinked = 0;
    const side = async (parts: Part[], dir: 'in' | 'out') => {
        const groups = group(parts);
        const others = groups.filter((g) => g.address !== focus?.address);
        const chosen = [...groups.filter((g) => g.address === focus?.address), ...others.slice(0, maxParties)];
        notLinked += Math.max(0, others.length - maxParties);
        for (const g of chosen) {
            const id = g.address === focus?.address ? focus.id : await nodes.address(network, g.address, compact({ address_kind: utxoKind(network, g.address) }));
            const r =
                dir === 'in'
                    ? await links.put(id, txId, 'input to', {
                          amount: coins(g.raw),
                          inputs: g.parts.map((p) => compact({ index: p.index, amount: coins(p.raw), prev_txid: p.prev_txid, prev_vout: p.prev_vout })),
                      })
                    : await links.put(txId, id, 'output to', { amount: coins(g.raw), outputs: g.parts.map((p) => ({ index: p.index, amount: coins(p.raw) })) });
            if (r !== 'skipped') wrote++;
        }
    };
    await side(tx.inputs, 'in');
    await side(tx.outputs, 'out');
    return { txId, links: wrote, notLinked, truncated: !!tx.truncated };
}

export async function writeUtxoHistory(
    seed: Seed,
    h: UtxoHistory,
    links: Links,
    nodes: Nodes,
    maxParties: number,
    asOf: string,
): Promise<{ written: Written & { truncated: number }; delta: Record<string, unknown> }> {
    let wrote = 0;
    let notLinked = 0;
    let truncated = 0;
    for (const tx of h.txs) {
        const touches = tx.inputs.some((p) => p.address === seed.address) || tx.outputs.some((p) => p.address === seed.address);
        if (!touches) continue;
        const r = await writeUtxoTx(seed.network, tx, links, nodes, maxParties, { id: seed.id, address: seed.address });
        wrote += r.links;
        notLinked += r.notLinked;
        if (r.truncated) truncated++;
    }
    const times = h.txs.map((t) => t.block_time).filter((t): t is string => !!t);
    const delta = compact({
        ...factsDelta(h.facts, h.vendor, asOf),
        address_kind: utxoKind(seed.network, seed.address),
        first_seen: h.facts.first_seen ?? (h.complete ? earliest(times) : undefined),
        last_seen: h.facts.last_seen ?? latest(times),
        history_examined: h.txs.length,
        history_complete: h.complete,
    });
    return { written: { links: wrote, notLinked, recentKept: 0, complete: h.complete, beforeWindow: 0, truncated }, delta };
}

/**
 * An account-chain transaction's parties as `input to` (who paid into it) and `output to` (who it
 * paid), the same shape the Bitcoin family uses, so a transaction node is linked to its parties on
 * every chain. Per party and direction the link holds the amount when one asset moved, or the list
 * of assets and amounts when several did.
 */
export function accountParties(moves: Move[]): { senders: Map<string, Move[]>; receivers: Map<string, Move[]> } {
    const senders = new Map<string, Move[]>();
    const receivers = new Map<string, Move[]>();
    for (const m of moves) {
        const s = senders.get(m.from) ?? [];
        s.push(m);
        senders.set(m.from, s);
        const key = `${m.to}|${m.to_memo ?? ''}`;
        const r = receivers.get(key) ?? [];
        r.push(m);
        receivers.set(key, r);
    }
    return { senders, receivers };
}

/** Link data for one party's moves in one transaction. */
export function partyData(moves: Move[]): Record<string, unknown> {
    const by = new Map<string, { asset: string; symbol?: string; decimals: number | null; raw: bigint }>();
    for (const m of moves) {
        const a = by.get(m.asset) ?? { asset: m.asset, symbol: m.symbol, decimals: m.decimals, raw: 0n };
        a.raw += BigInt(m.raw);
        by.set(m.asset, a);
    }
    const list = [...by.values()].map((a) =>
        compact({
            asset: a.asset,
            symbol: a.symbol,
            amount: a.decimals == null ? a.raw.toString() : (formatUnits(a.raw, a.decimals) ?? a.raw.toString()),
            base_units: a.decimals == null ? true : undefined,
        }),
    );
    return list.length === 1 ? list[0] : { assets: list };
}

export type { Feed };
