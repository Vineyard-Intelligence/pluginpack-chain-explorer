// Turning one address's moves into `sent to` links: per-pair summaries, the window they cover, and
// the recent-transfer list.
//
// Pure and dependency-free so test/pure.test.mjs can import it.
//
// The link rules are the Cryptocurrency type pack's: one link per ordered pair, labelled `sent to`,
// each source's figures under its own top-level key (`summary_routescan`) because commit merges
// link data one top-level key at a time, and a `recent` list of the latest 20 transfers that every
// collector shares. Adapted from pluginpack-blockscout-pro (src/flows.ts, 1.0.0): the same window
// rule, generalised from block numbers to whatever orders a chain's rows.
import type { Feed, Move } from './model';
import { formatUnits } from './values';

export interface AssetSummary {
    asset: string;
    symbol?: string;
    count: number;
    total: string;
    /** Present, and true, when the total is in base units because the decimals are unknown. */
    base_units?: true;
    first?: string;
    last?: string;
}

export interface RecentRow {
    tx_hash: string;
    asset: string;
    symbol?: string;
    amount: string;
    time?: string;
}

export interface PairFlow {
    from: string;
    to: string;
    /** XRPL: the destination tag the receiving side was paid under. */
    to_memo?: string;
    assets: AssetSummary[];
    assets_omitted: number;
    recent: RecentRow[];
    transfers: number;
    lastTime?: string;
}

export interface FlowResult {
    pairs: PairFlow[];
    window_from?: string;
    /** Times of the earliest and latest row counted (the seed's own, inside the window). */
    first?: string;
    last?: string;
    complete: boolean;
    counted: number;
    beforeWindow: number;
    zeroAddress: number;
    selfTransfers: number;
}

export const RECENT_MAX = 20;
export const ASSETS_MAX = 25;
const ZERO_EVM = '0x0000000000000000000000000000000000000000';

/**
 * Aggregate one address's feeds into per-pair flows.
 *
 * THE WINDOW IS THE SAME FOR EVERY PAIR. Each list is read newest first and may stop at the page
 * limit, each at a different depth: four pages of transactions can reach back a year while four of
 * token transfers reach back a week. A summary that counted every row would mix a year of ETH with
 * a week of USDC under one window. So rows are counted only above the deepest point EVERY list
 * covers: an incomplete list covers what is above its oldest row (that row's block only in part,
 * since the next page may hold more of it), a complete list covers everything. `window_from` is
 * that point's time — or a vendor's own floor, such as the free Binplorer key's 30 days.
 */
export function aggregate(seed: string, feeds: Feed[], seedMemo?: string): FlowResult {
    const incomplete = feeds.filter((f) => !f.complete);
    const cutoff = incomplete.length
        ? Math.max(...incomplete.map((f) => (f.oldest == null ? Number.POSITIVE_INFINITY : f.oldest)))
        : Number.NEGATIVE_INFINITY;
    const cutFeed = incomplete.find((f) => (f.oldest ?? Number.POSITIVE_INFINITY) === cutoff);

    let beforeWindow = 0;
    let zeroAddress = 0;
    let selfTransfers = 0;
    let counted = 0;
    let earliest: string | undefined;
    let newest: string | undefined;

    type Acc = {
        from: string;
        to: string;
        to_memo?: string;
        assets: Map<string, { asset: string; symbol?: string; decimals: number | null; count: number; total: bigint; first?: string; last?: string }>;
        recent: Map<string, { tx_hash: string; asset: string; symbol?: string; decimals: number | null; raw: bigint; time?: string; order: number }>;
        transfers: number;
        lastTime?: string;
    };
    const pairs = new Map<string, Acc>();

    for (const f of feeds) {
        for (const r of f.rows) {
            if (!(r.order > cutoff)) {
                beforeWindow++;
                continue;
            }
            if (r.from === ZERO_EVM || r.to === ZERO_EVM) {
                zeroAddress++;
                continue;
            }
            if (r.from === r.to && (r.to_memo ?? '') === '') {
                selfTransfers++;
                continue;
            }
            if (r.from !== seed && r.to !== seed) continue;
            counted++;
            if (r.time && (!earliest || r.time < earliest)) earliest = r.time;
            if (r.time && (!newest || r.time > newest)) newest = r.time;
            // Toward the seed, the receiving side is the seed node itself (its own memo, if any);
            // away from it, a destination tag makes the receiver its own node.
            const toMemo = r.to === seed ? seedMemo : r.to_memo;
            const key = `${r.from}>${r.to}|${toMemo ?? ''}`;
            let p = pairs.get(key);
            if (!p) {
                p = { from: r.from, to: r.to, to_memo: toMemo, assets: new Map(), recent: new Map(), transfers: 0 };
                pairs.set(key, p);
            }
            p.transfers++;
            if (r.time && (!p.lastTime || r.time > p.lastTime)) p.lastTime = r.time;
            let a = p.assets.get(r.asset);
            if (!a) {
                a = { asset: r.asset, symbol: r.symbol, decimals: r.decimals, count: 0, total: 0n };
                p.assets.set(r.asset, a);
            }
            a.count++;
            a.total += BigInt(r.raw);
            if (r.time && (!a.first || r.time < a.first)) a.first = r.time;
            if (r.time && (!a.last || r.time > a.last)) a.last = r.time;
            // One row per transaction and asset: a swap that moves USDC twice between the same two
            // accounts is one transfer of the sum, which is what the shared list keys on.
            const rk = `${r.tx_hash}|${r.asset}`;
            const prev = p.recent.get(rk);
            if (prev) prev.raw += BigInt(r.raw);
            else p.recent.set(rk, { tx_hash: r.tx_hash, asset: r.asset, symbol: r.symbol, decimals: r.decimals, raw: BigInt(r.raw), time: r.time, order: r.order });
        }
    }

    const amount = (raw: bigint, decimals: number | null) => (decimals == null ? raw.toString() : (formatUnits(raw, decimals) ?? raw.toString()));
    const out: PairFlow[] = [...pairs.values()].map((p) => {
        const assets = [...p.assets.values()].sort((x, y) => y.count - x.count || (x.asset < y.asset ? -1 : 1));
        const recent = [...p.recent.values()]
            .sort((x, y) => y.order - x.order || (x.tx_hash < y.tx_hash ? -1 : 1))
            .slice(0, RECENT_MAX)
            .map((r) => clean({ tx_hash: r.tx_hash, asset: r.asset, symbol: r.symbol, amount: amount(r.raw, r.decimals), time: r.time }) as RecentRow);
        return {
            from: p.from,
            to: p.to,
            to_memo: p.to_memo,
            assets: assets.slice(0, ASSETS_MAX).map(
                (a) =>
                    clean({
                        asset: a.asset,
                        symbol: a.symbol,
                        count: a.count,
                        total: amount(a.total, a.decimals),
                        base_units: a.decimals == null ? true : undefined,
                        first: a.first,
                        last: a.last,
                    }) as AssetSummary,
            ),
            assets_omitted: Math.max(0, assets.length - ASSETS_MAX),
            recent,
            transfers: p.transfers,
            lastTime: p.lastTime,
        };
    });
    out.sort((x, y) => y.transfers - x.transfers || ((y.lastTime ?? '') > (x.lastTime ?? '') ? 1 : -1));
    return {
        pairs: out,
        window_from: cutFeed ? (cutFeed.floorTime ?? cutFeed.oldestTime ?? earliest) : earliest,
        first: earliest,
        last: newest,
        complete: incomplete.length === 0,
        counted,
        beforeWindow,
        zeroAddress,
        selfTransfers,
    };
}

function clean<T extends Record<string, unknown>>(o: T): T {
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
}

/**
 * The link's `recent` list after this run: what it held with this run's rows laid over it, merged
 * by transaction hash and asset so another collector's rows are kept. Newest first.
 */
export function mergeRecent(existing: unknown, ours: RecentRow[], max = RECENT_MAX): RecentRow[] {
    const byKey = new Map<string, RecentRow>();
    const key = (r: { tx_hash: string; asset?: unknown }) => `${r.tx_hash.toLowerCase().replace(/^0x/, '')}|${String(r.asset ?? '').toLowerCase()}`;
    if (Array.isArray(existing)) {
        for (const r of existing) {
            if (r && typeof r === 'object' && typeof (r as any).tx_hash === 'string' && (r as any).tx_hash) byKey.set(key(r as RecentRow), r as RecentRow);
        }
    }
    for (const r of ours) byKey.set(key(r), r);
    return [...byKey.values()]
        .sort((x, y) => {
            const tx = typeof x.time === 'string' ? x.time : '';
            const ty = typeof y.time === 'string' ? y.time : '';
            if (tx !== ty) return tx < ty ? 1 : -1;
            return x.tx_hash < y.tx_hash ? -1 : 1;
        })
        .slice(0, max);
}

/**
 * The `recent` list to write on a pair's link, or undefined to leave the key as it is.
 *
 * No link yet: this run's rows. A link whose data the host shows: those rows merged with ours. A
 * link whose data the host does NOT show: nothing, because commit replaces the key whole, and a
 * list built from this run alone would wipe the rows other collectors and earlier runs left there.
 * The app's `graph.edges()` carries each link's data (host-bridge.ts toEdge, frontend main
 * 2026-11-16), so a re-run merges into the list a link holds. An older app's carried none (read
 * 2026-11-15); there an existing link's list is left alone and the summary says so.
 */
export function recentFor(link: { data?: unknown } | undefined, ours: RecentRow[]): RecentRow[] | undefined {
    if (!link) return mergeRecent(undefined, ours);
    const d = link.data;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
    return mergeRecent((d as Record<string, unknown>).recent, ours);
}
