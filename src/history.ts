// Address History — an address's transfers on its network: `sent to` links on account chains,
// transaction nodes with `input to` / `output to` links on the Bitcoin family.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { noSource } from './chains';
import { ADDRESS, chainName, crypto, E, intParam, LIFECYCLE, PLATFORMS, Report, requireNet, selectedOfType, WRITES } from './common';
import { canonicalOn } from './formats';
import { Links, Nodes } from './graph';
import { abortErr, Http } from './http';
import { hasSource, readHistory, RunState } from './sources';
import { compact, nowIso, str } from './values';
import { writeAccountHistory, writeUtxoHistory } from './write';

export const history = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.chain_explorer_address_history',
        content_type: 'vineyard:plugin',
        name: 'Crypto Address History',
        version: '1.0.0',
        description:
            "Reads each selected Crypto Address's transfers on its network from a keyless source, newest first: Bitcoin, Litecoin, Bitcoin Cash, Dogecoin, Dash, Zcash, Ethereum, Avalanche C-Chain, OP Mainnet, BNB Smart Chain (last 30 days), Ethereum Classic, TRON, Solana, XRP Ledger and TON. On account chains it links the address 'sent to' and from its counterparties, with per-asset figures under summary_<source> and the window they cover; on the Bitcoin family it adds the transactions, linked 'input to' and 'output to'. Writes balance, history_examined and history_complete on the address. Polygon, Arbitrum and Base need a keyed pack.",
        icon: 'history',
        platforms: PLATFORMS,
        io: { consumes: [crypto('crypto_address')], produces: [crypto('crypto_address'), crypto('crypto_transaction')] },
        params: {
            type: 'object',
            properties: {
                max_pages: {
                    type: 'integer',
                    title: 'Pages per list',
                    description: 'How far back to read on sources that answer in pages (100–200 rows each): Ethereum, Avalanche, OP Mainnet, Ethereum Classic, TRON, XRP Ledger, TON.',
                    default: 2,
                    minimum: 1,
                    maximum: 20,
                },
                max_txs: {
                    type: 'integer',
                    title: 'Transactions per address (Bitcoin family, Solana)',
                    description: 'Where each transaction is read on its own, how many of the newest to read.',
                    default: 25,
                    minimum: 1,
                    maximum: 500,
                },
                max_counterparties: {
                    type: 'integer',
                    title: 'Most counterparties linked per address',
                    description: 'Account chains: the busiest pairs are kept, and the summary says how many were left out.',
                    default: 50,
                    minimum: 1,
                    maximum: 500,
                },
                max_parties_per_tx: {
                    type: 'integer',
                    title: 'Most other addresses linked per transaction side',
                    description: 'Bitcoin family: the largest inputs and outputs besides the address itself.',
                    default: 10,
                    minimum: 0,
                    maximum: 200,
                },
            },
        },
        scopes: {
            graph: WRITES,
            network: [
                E.mempool,
                E.blockstream,
                E.litecoinspace,
                E.haskoin,
                E.sochain,
                E.blockcypher_ltc,
                E.blockcypher_doge,
                E.blockcypher_dash,
                E.insight,
                E.routescan_eth,
                E.routescan_avax,
                E.blockscout_eth,
                E.blockscout_op,
                E.blockscout_etc,
                E.binplorer,
                E.trongrid_v1,
                E.tronscan,
                E.solana,
                E.solana_publicnode,
                E.xrplcluster,
                E.xrplws,
                E.toncenter,
            ],
        },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const { nodes: selected, other } = await selectedOfType(ctx, ADDRESS);
        if (!selected.length) return { summary: 'Select Crypto Address nodes first', counts: { checked: 0, read: 0, links: 0 } };
        const lim = { maxPages: intParam(ctx, 'max_pages', 2, 1, 20), maxTxs: intParam(ctx, 'max_txs', 25, 1, 500) };
        const maxPairs = intParam(ctx, 'max_counterparties', 50, 1, 500);
        const maxParties = intParam(ctx, 'max_parties_per_tx', 10, 0, 200);
        const http = new Http(ctx);
        const state = new RunState();
        const links = new Links(ctx);
        const nodes = new Nodes(ctx);
        const report = new Report();

        const targets: Array<{ id: string; network: string; address: string; memo?: string; label: string }> = [];
        for (const n of selected) {
            const network = str(n.data?.network);
            const raw = str(n.data?.address);
            const memo = str(n.data?.memo) || undefined;
            if (!hasSource(network)) {
                report.skip(noSource(network));
                continue;
            }
            const c = canonicalOn(network, raw);
            if (!c) {
                report.skip(`the address is not one ${chainName(network)} accepts`);
                continue;
            }
            // Only XRP Ledger payments say which destination tag they went to here; on any other
            // network a memo node would be given the whole account's history as its own.
            if ((memo ?? c.memo) && network !== 'xrpl') {
                report.skip(`only XRP Ledger payments here say which memo they went to: run it on the ${chainName(network)} address without the memo`);
                continue;
            }
            targets.push({ id: n.id, network, address: c.address, memo: memo ?? c.memo, label: raw || n.id });
            nodes.knowAddress(network, c.address, memo ?? c.memo, n.id);
        }

        const asOf = nowIso();
        let read = 0;
        let incomplete = 0;
        let notLinked = 0;
        let recentKept = 0;
        let truncated = 0;
        const by = new Map<string, number>();
        const fallbacks: string[] = [];
        for (let i = 0; i < targets.length; i++) {
            if (ctx.signal?.aborted) throw abortErr();
            const t = targets[i];
            if (http.outOfTime) {
                report.stopped = `STOPPED: the run reached its time budget; ${targets.length - i} address(es) were not looked up — run them again`;
                break;
            }
            ctx.progress?.set?.({ percent: Math.round((i / targets.length) * 100), message: `${chainName(t.network)}: ${t.address}` });
            try {
                const { history: h, missed } = await readHistory(http, state, t.network, t.address, t.memo, lim);
                if (missed.length) fallbacks.push(...missed);
                const seed = { id: t.id, network: t.network, address: t.address, memo: t.memo };
                const r = h.kind === 'account' ? await writeAccountHistory(seed, h, links, nodes, maxPairs, asOf) : await writeUtxoHistory(seed, h, links, nodes, maxParties, asOf);
                await ctx.graph!.updateNode!(t.id, compact(r.delta));
                read++;
                by.set(h.vendor, (by.get(h.vendor) ?? 0) + 1);
                if (!r.written.complete) incomplete++;
                notLinked += r.written.notLinked;
                recentKept += r.written.recentKept;
                if ('truncated' in r.written) truncated += (r.written as { truncated: number }).truncated;
            } catch (e) {
                if (!report.caught(e, t.label, targets.length - i)) break;
            }
        }
        ctx.progress?.set?.({ percent: 100 });

        report.line(`${read} of ${selected.length} address(es) read${by.size ? ` (${[...by].map(([v, n]) => `${v} ${n}`).join(', ')})` : ''}`);
        if (links.created || links.amended) report.line(`${links.created} new link(s), ${links.amended} existing link(s) given figures`);
        if (nodes.created) report.line(`${nodes.created} node(s) for counterparties and transactions`);
        if (incomplete) report.line(`${incomplete} address(es) have more history than this run read (history_complete: false); raise "Pages per list" or "Transactions per address" for more`);
        if (recentKept) report.line(`${recentKept} existing link(s) kept their recent list as it was: their data was not passed to this run (an older Vineyard does not pass a link's data to plugins), and writing this run's rows alone would replace the ones they hold`);
        if (notLinked) report.line(`${notLinked} counterparties beyond the caps were not linked`);
        if (truncated) report.line(`${truncated} transaction(s) have more inputs or outputs than BlockCypher lists (20 of each); the links show only those listed`);
        if (fallbacks.length) report.line(`fell back to the next source after: ${[...new Set(fallbacks)].slice(0, 3).join('; ')}`);
        if (other) report.line(`${other} selected node(s) are not Crypto Addresses`);
        return {
            summary: report.text(http),
            counts: { checked: selected.length, read, links: links.created + links.amended, skipped: report.skipped, failed: report.failed },
        };
    },
});
