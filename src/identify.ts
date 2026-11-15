// Identify Network — decide which network an address is on, and write it there in canonical form.
//
// INPUTS: a Crypto Address whose network is `evm` or `unknown` (or not written canonically), a
// legacy Financial `crypto_address`, and a payment `web.tracking_id` from Ad Tags before 1.4.0.
//
// WHY THIS MEMBER TAKES NO DECLARED INPUT TYPE. The run panel offers a plugin only nodes of the types
// its `io.consumes` names, and the registry's CI requires every type there to be one a published
// Type Pack defines. The legacy Financial types will be removed in a later major release, and a
// plugin that named them would then fail CI; nor could an analyst with only legacy nodes ever run
// it. So it declares none: it runs on whatever is selected and, with nothing selected, finds the
// candidates in the project itself (`graph.list`).
//
// The original node is never changed or removed: what the source said (no network, or a legacy
// type) and what was decided stay apart, linked by `same address on` or `same as` with the reason.
import { definePlugin } from './sdk';
import type { GraphNode, HostContext, RunResult } from './sdk';
import { CHAINS } from './chains';
import { ADDRESS, chainName, crypto, E, EVM_RPC_SCOPES, intParam, LIFECYCLE, PLATFORMS, Report, requireNet, WRITES } from './common';
import { canonicalOn, identityFold, readAddress, utxoKind, type Candidate, type Network } from './formats';
import { Links, Nodes } from './graph';
import { abortErr, firstAnswer, Http, VendorDown } from './http';
import { evmActivity, isDelegation } from './vendors/evm';
import { tonAccount } from './vendors/ledgers';
import { blockcypherUsed, esploraUsed, haskoinUsed, sochainUsed } from './vendors/utxo';
import { compact, formatUnits, nowIso, str } from './values';

const LEGACY = 'financial.crypto_address';
const TRACKING = 'web.tracking_id';

/** What a legacy `currency` or a payment provider says about the network. */
const CURRENCY_HINT: Record<string, Network[]> = {
    btc: ['bitcoin'],
    ltc: ['litecoin'],
    trx: ['tron'],
    sol: ['solana'],
    xmr: ['monero'],
    // ETH is the native coin of these; USDT and "other" say nothing about the chain.
    eth: ['ethereum', 'optimism', 'arbitrum', 'base'],
    bnb: ['bsc', 'bnb_beacon'],
};
/** Ad Tags' payment-link schemes before 1.4.0. `ethereum:` carried no chain id in those nodes. */
const PROVIDER_HINT: Record<string, Network[]> = {
    bitcoin: ['bitcoin'],
    bitcoincash: ['bitcoin_cash'],
    litecoin: ['litecoin'],
    dogecoin: ['dogecoin'],
    monero: ['monero'],
};
const PAYMENT_PROVIDERS = new Set([...Object.keys(PROVIDER_HINT), 'ethereum']);

interface Target {
    node: GraphNode;
    raw: string;
    memo?: string;
    /** The link from the original node to the decided one. */
    label: 'same address on' | 'same as';
    hint?: { networks: Network[]; said: string };
    /** Fields carried over from a legacy node. */
    carry?: Record<string, unknown>;
    /** The network the original node already names, when it is established. */
    established?: string;
}

/**
 * Why a value cannot be read, or null. Checked before a sweep fills "Most nodes per run": a value
 * no format reads is never decided and draws no link, so a sweep that counted it would take it
 * again first every time and never reach the nodes behind it (review of 1.0.0).
 */
const unreadable = (raw: string): string | null => {
    const r = readAddress(raw);
    return r.kind === 'unreadable' ? r.reason : null;
};

/** What to do with one node, or why not. Pure. */
export function targetOf(n: GraphNode): Target | string {
    const d = n.data ?? {};
    if (n.type === ADDRESS) {
        const network = str(d.network);
        const raw = str(d.address);
        if (!raw) return 'no address';
        if (network === 'evm' || network === 'unknown' || !network) {
            const bad = unreadable(raw);
            if (bad) return bad;
            return { node: n, raw, memo: str(d.memo) || undefined, label: 'same address on', hint: network === 'evm' ? { networks: ['ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism', 'base', 'avalanche_c', 'ethereum_classic'], said: 'the node says evm' } : undefined };
        }
        const c = canonicalOn(network, raw);
        if (!c) return `the address is not one ${chainName(network)} accepts`;
        // Letter case and a `bitcoincash:` prefix are one node to the app: nothing to rewrite.
        if (identityFold(c.address) === identityFold(raw) && (c.memo ?? '') === '') return 'its network is established and the address is written canonically';
        return { node: n, raw, memo: str(d.memo) || c.memo, label: 'same as', established: network };
    }
    if (n.type === LEGACY) {
        const raw = str(d.address);
        if (!raw) return 'no address';
        const bad = unreadable(raw);
        if (bad) return bad;
        const cur = str(d.currency).toLowerCase();
        const carry: Record<string, unknown> = {};
        if (str(d.owner_label)) {
            carry.public_label = str(d.owner_label);
            carry.label_source = 'legacy Financial node';
        }
        if (str(d.first_seen)) carry.first_seen = str(d.first_seen);
        if (typeof d.balance === 'number' && Number.isFinite(d.balance) && d.balance >= 0) carry.legacy_balance = d.balance;
        return { node: n, raw, label: 'same as', hint: CURRENCY_HINT[cur] ? { networks: CURRENCY_HINT[cur], said: `its currency is ${cur}` } : undefined, carry };
    }
    if (n.type === TRACKING) {
        const provider = str(d.provider).toLowerCase();
        if (str(d.kind) !== 'payment' || !PAYMENT_PROVIDERS.has(provider)) return 'not a cryptocurrency payment tracking ID';
        const raw = str(d.value);
        if (!raw) return 'no value';
        const bad = unreadable(raw);
        if (bad) return bad;
        return { node: n, raw, label: 'same as', hint: PROVIDER_HINT[provider] ? { networks: PROVIDER_HINT[provider], said: `it was found in a ${provider}: payment link` } : undefined };
    }
    return 'not an address node';
}

/** Native coin symbol per network, to carry a legacy balance only onto the coin it was counted in. */
const LEGACY_BALANCE_COIN: Record<string, string> = { btc: 'BTC', ltc: 'LTC', trx: 'TRX', sol: 'SOL', eth: 'ETH', bnb: 'BNB' };

type Probe = { state: 'active'; evidence: string; fields?: Record<string, unknown> } | { state: 'none'; evidence: string } | { state: 'unknown'; evidence: string };

/** Ask one network whether the address has activity there. */
async function probe(http: Http, c: Candidate): Promise<Probe> {
    const chain = CHAINS[c.network];
    if (chain?.family === 'evm') {
        const a = await evmActivity(http, c.network, c.address);
        const hasCode = !!a.code && a.code !== '0x';
        const bal = a.balance && a.balance !== '0' ? formatUnits(a.balance, 18) : null;
        const parts = [a.nonce ? `${a.nonce} transaction(s) sent` : '', bal ? `balance ${bal} ${chain.native}` : '', hasCode ? (isDelegation(a.code!) ? 'EIP-7702 delegation' : 'contract code') : ''].filter(Boolean);
        if (parts.length) {
            // A sent transaction or a delegation proves a key-holding account, code a contract; a
            // balance alone proves neither (a contract address can be paid before it is deployed).
            const kind = hasCode ? (isDelegation(a.code!) ? 'eoa' : 'contract') : a.nonce ? 'eoa' : undefined;
            return { state: 'active', evidence: parts.join(', '), fields: kind ? { address_kind: kind } : undefined };
        }
        // A nonce counts sent transactions only: an address that has only received tokens looks
        // empty to these three calls. That is "could not tell", not "unused".
        return { state: 'unknown', evidence: 'no transaction sent, no balance and no code, which an address that only received tokens also shows' };
    }
    const used = (n: number | null, who: string): Probe =>
        n === null ? { state: 'unknown', evidence: `${who} did not know the address` } : n > 0 ? { state: 'active', evidence: `${n} transaction(s) on ${who}` } : { state: 'none', evidence: `no transactions on ${who}` };
    switch (c.network) {
        case 'bitcoin': {
            const r = await firstAnswer([
                { vendor: 'mempool.space', run: () => esploraUsed(http, 'mempool', c.address) },
                { vendor: 'blockstream.info', run: () => esploraUsed(http, 'blockstream', c.address) },
            ]);
            return used(r.value, r.vendor);
        }
        case 'litecoin': {
            const r = await firstAnswer([
                { vendor: 'litecoinspace.org', run: () => esploraUsed(http, 'litecoinspace', c.address) },
                { vendor: 'SoChain', run: () => sochainUsed(http, 'litecoin', c.address) },
                { vendor: 'BlockCypher', run: () => blockcypherUsed(http, 'litecoin', c.address) },
            ]);
            return used(r.value, r.vendor);
        }
        case 'dogecoin': {
            const r = await firstAnswer([
                { vendor: 'SoChain', run: () => sochainUsed(http, 'dogecoin', c.address) },
                { vendor: 'BlockCypher', run: () => blockcypherUsed(http, 'dogecoin', c.address) },
            ]);
            return used(r.value, r.vendor);
        }
        case 'bitcoin_cash':
            return used(await haskoinUsed(http, c.address), 'Haskoin');
        case 'ton': {
            const a = await tonAccount(http, c.address);
            const status = str(a?.status);
            const bal = str(a?.balance);
            if (status === 'active' || status === 'frozen' || (/^\d+$/.test(bal) && bal !== '0')) return { state: 'active', evidence: `toncenter: account ${status || 'with a balance'}` };
            return { state: 'none', evidence: `toncenter: account ${status || 'not found'}` };
        }
    }
    return { state: 'unknown', evidence: `no keyless source checks ${chainName(c.network)}` };
}

export const identify = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.chain_explorer_identify_network',
        content_type: 'vineyard:plugin',
        name: 'Identify Crypto Network',
        version: '1.0.0',
        description:
            "Decides the network of crypto addresses that do not name one — Crypto Addresses on evm or unknown, legacy Financial crypto addresses, and payment tracking IDs — and writes a Crypto Address on each network it finds, in canonical form, linked from the original by 'same address on' (or 'same as' for a legacy node) with the reason. A format that names one network settles it; a format several share (1…/3…, D…, 0x…) is decided by asking each network for activity, and linked only once every one of them has answered: a node an explorer did not answer for is left for the next run. Runs on the selection, or on up to 'Most nodes per run' candidates in the project when nothing is selected. The original node is left as it is.",
        icon: 'scan-search',
        platforms: PLATFORMS,
        io: { consumes: [], produces: [crypto('crypto_address')] },
        params: {
            type: 'object',
            properties: {
                max_nodes: {
                    type: 'integer',
                    title: 'Most nodes per run',
                    description: 'With nothing selected: how many candidates in the project to take.',
                    default: 50,
                    minimum: 1,
                    maximum: 500,
                },
            },
        },
        scopes: {
            graph: WRITES,
            network: [E.mempool, E.blockstream, E.litecoinspace, E.haskoin, E.sochain, E.blockcypher_ltc, E.blockcypher_doge, ...EVM_RPC_SCOPES, E.toncenter],
        },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const maxNodes = intParam(ctx, 'max_nodes', 50, 1, 500);
        const http = new Http(ctx);
        const links = new Links(ctx);
        const nodes = new Nodes(ctx);
        const report = new Report();

        const picked: GraphNode[] = [];
        const selection = ctx.input?.selection ?? [];
        const sweep = selection.length === 0;
        if (!sweep) {
            for (const id of selection) {
                const n = await ctx.graph?.get?.(id);
                if (n) picked.push(n);
            }
        } else {
            // A node that already links out with `same address on` / `same as` to a Crypto Address
            // was decided by an earlier run; a sweep leaves it alone (select it to decide it again).
            // That holds only because a run draws those links from a complete answer: see below.
            const all = (await ctx.graph?.list?.())?.nodes ?? [];
            const isAddress = new Set(all.filter((n) => n.type === ADDRESS).map((n) => n.id));
            const decided = new Set<string>();
            for (const e of (await ctx.graph?.edges?.()) ?? []) {
                if ((e.label === 'same address on' || e.label === 'same as') && isAddress.has(e.to_node_id)) decided.add(e.from_node_id);
            }
            picked.push(...all.filter((n) => !decided.has(n.id) && typeof targetOf(n) !== 'string'));
        }
        const targets: Target[] = [];
        for (const n of picked) {
            const t = targetOf(n);
            if (typeof t === 'string') report.skip(t);
            else targets.push(t);
        }
        // "Most nodes per run" bounds a sweep only: an explicit selection is what the analyst asked
        // for, and the run's time budget still stops it (and says so) if it is too large.
        const left = sweep ? Math.max(0, targets.length - maxNodes) : 0;
        if (sweep) targets.splice(maxNodes);
        if (!targets.length) {
            report.line(sweep ? 'No address in the project needs its network decided' : 'Nothing selected needs its network decided');
            return { summary: report.text(http), counts: { checked: picked.length, decided: 0 } };
        }

        const asOf = nowIso();
        let byFormat = 0;
        let byActivity = 0;
        let bySource = 0;
        let established = 0;
        let canonical = 0;
        let undecided = 0;
        let unused = 0;
        let unanswered = 0;
        const conflicts: string[] = [];
        const undecidedEx: string[] = [];
        const unansweredEx: string[] = [];
        for (let i = 0; i < targets.length; i++) {
            if (ctx.signal?.aborted) throw abortErr();
            if (http.outOfTime) {
                report.stopped = `STOPPED: the run reached its time budget; ${targets.length - i} node(s) were not decided — run again`;
                break;
            }
            const t = targets[i];
            ctx.progress?.set?.({ percent: Math.round((i / targets.length) * 100), message: t.raw });
            try {
                const decided: Array<{ c: Candidate; basis: string; fields?: Record<string, unknown> }> = [];
                if (t.established) {
                    const c = canonicalOn(t.established, t.raw)!;
                    decided.push({ c: { network: t.established as Network, address: c.address, memo: t.memo ?? c.memo }, basis: `the canonical form on ${chainName(t.established)}` });
                    established++;
                } else {
                    const r = readAddress(t.raw);
                    if (r.kind === 'unreadable') {
                        report.skip(`${r.reason}`);
                        continue;
                    }
                    if (r.kind === 'settled') {
                        if (t.hint && !t.hint.networks.includes(r.network)) conflicts.push(`${t.raw}: ${t.hint.said}, but the format is ${chainName(r.network)}'s`);
                        decided.push({ c: { network: r.network, address: r.address, memo: t.memo ?? r.memo }, basis: `format: ${r.basis}` });
                        byFormat++;
                    } else {
                        const narrowed = t.hint ? r.candidates.filter((c) => t.hint!.networks.includes(c.network)) : [];
                        if (narrowed.length === 1 && t.hint!.networks.length === 1) {
                            decided.push({ c: { ...narrowed[0], memo: t.memo }, basis: `${t.hint!.said}; format: ${r.basis}` });
                            bySource++;
                        } else {
                            const ask = narrowed.length ? narrowed : r.candidates;
                            let unknown = 0;
                            const down: Array<{ network: string; why: string }> = [];
                            for (const c of ask) {
                                let p: Probe;
                                try {
                                    p = await probe(http, c);
                                } catch (e) {
                                    if (!(e instanceof VendorDown)) throw e;
                                    down.push({ network: c.network, why: e.message });
                                    continue;
                                }
                                if (p.state === 'active') decided.push({ c: { ...c, memo: t.memo }, basis: `activity: ${p.evidence} (${r.basis})`, fields: p.fields });
                                else if (p.state === 'unknown') unknown++;
                            }
                            // ALL OR NOTHING. A network whose source did not answer was not asked, and
                            // the links drawn here are what tells a later sweep the node is done: a
                            // node decided on Bitcoin Cash while mempool.space and blockstream.info
                            // were refusing was never looked at on Bitcoin again (review of 1.0.0).
                            // So a node with an unanswered network gets no link this run; the summary
                            // names what was missing and what was seen, and the next run asks again.
                            if (down.length) {
                                unanswered++;
                                if (unansweredEx.length < 2) {
                                    const seen = decided.length ? `; activity on ${decided.map((d) => chainName(d.c.network)).join(', ')}` : '';
                                    unansweredEx.push(`${t.raw}: ${down.map((x) => chainName(x.network)).join(', ')} not checked (${down[0].why})${seen}`);
                                }
                                continue;
                            }
                            if (decided.length) byActivity++;
                            else if (unknown) {
                                undecided++;
                                if (undecidedEx.length < 2) undecidedEx.push(`${t.raw} (${ask.map((c) => chainName(c.network)).join(', ')})`);
                            } else unused++;
                        }
                    }
                }
                // A legacy balance was counted in the node's currency, which is the network's own
                // coin only for some (a USDT balance is not an ETH one), and one balance belongs to
                // one network: an `eth` node active on Ethereum and Arbitrum says which of the two
                // it counted no more than the node does. It stays on the original either way.
                const coin = LEGACY_BALANCE_COIN[str(t.node.data?.currency).toLowerCase()];
                const onCoin = coin ? decided.filter((d) => CHAINS[d.c.network]?.native === coin) : [];
                for (const d of decided) {
                    const fields: Record<string, unknown> = { ...(d.fields ?? {}) };
                    const kind = CHAINS[d.c.network]?.family === 'utxo' ? utxoKind(d.c.network, d.c.address) : undefined;
                    if (kind) fields.address_kind = kind;
                    if (t.carry) {
                        const { legacy_balance, ...rest } = t.carry;
                        Object.assign(fields, rest);
                        if (typeof legacy_balance === 'number' && onCoin.length === 1 && onCoin[0] === d) {
                            const s = String(legacy_balance);
                            if (/^\d+(\.\d+)?$/.test(s)) Object.assign(fields, { balance: s, balance_source: 'legacy Financial node' });
                        }
                    }
                    const id = await nodes.address(d.c.network, d.c.address, compact(fields), d.c.memo);
                    if (id === t.node.id) continue;
                    const put = await links.put(t.node.id, id, t.label, { basis: d.basis, decided_at: asOf });
                    if (t.established && put !== 'skipped') canonical++;
                }
            } catch (e) {
                if (!report.caught(e, t.raw, targets.length - i)) break;
            }
        }
        ctx.progress?.set?.({ percent: 100 });
        const decidedCount = byFormat + bySource + byActivity;
        report.line(`${decidedCount} of ${targets.length - established} address(es) given a network: ${byFormat} by format, ${bySource} by what the source said, ${byActivity} by activity`);
        if (canonical) report.line(`${canonical} address(es) on an established network rewritten in canonical form, linked 'same as'`);
        // Links, not nodes: the host hands back an existing node for an address already in the
        // project, so a count of creates would count those too.
        if (links.created || links.amended) {
            report.line(`${links.created} new link(s) from the original nodes to Crypto Addresses${links.amended ? `, ${links.amended} existing link(s) given the basis again` : ''}`);
        }
        if (unanswered) {
            report.line(`${unanswered} not decided this run because a network they may be on did not answer, so no link was drawn, e.g. ${unansweredEx.join('; ')} — run again`);
        }
        if (unused) report.line(`${unused} address(es) show no activity on any network their format fits, so no network was written`);
        if (undecided) {
            report.line(`${undecided} could not be decided, e.g. ${undecidedEx.join('; ')}: the EVM calls see only sent transactions and balances, and some networks have no keyless source`);
        }
        if (conflicts.length) report.line(`format overruled the source for ${conflicts.length}: ${conflicts.slice(0, 2).join('; ')}`);
        if (left) {
            // A node left undecided draws no link, so the next sweep takes it again, in the same
            // order and ahead of the ones not reached: "run again" would repeat this run.
            const stay = unanswered + unused + undecided + report.failed;
            report.line(
                stay
                    ? `${left} more candidate(s) beyond "Most nodes per run" were not taken, and the next sweep takes the ${stay} left undecided here first again: raise "Most nodes per run" (up to 500) or select the rest`
                    : `${left} more candidate(s) beyond "Most nodes per run" — run again`,
            );
        }
        return { summary: report.text(http), counts: { checked: targets.length, decided: decidedCount, links: links.created + links.amended, failed: report.failed } };
    },
});
