// Stablecoin Freeze Status — whether a stablecoin issuer has frozen an address, read from the
// issuer's own contract: Tether's `isBlackListed` (USDT on Ethereum and TRON) and Circle's
// `isBlacklisted` (USDC on Ethereum). All three answered without a key on 2026-11-14.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { TRON_USDT } from './chains';
import { ADDRESS, chainName, crypto, E, LIFECYCLE, PLATFORMS, READ_ONLY, Report, requireNet, selectedOfType } from './common';
import { canonicalOn } from './formats';
import { abortErr, Http } from './http';
import { evmFlag } from './vendors/evm';
import { tronFlag } from './vendors/tron';
import { nowIso, str } from './values';

/** The freeze lists read, per network: the token, its view function, and how the node names it. */
export const FREEZE_LISTS: Readonly<Record<string, ReadonlyArray<{ token: string; selector: string; label: string }>>> = {
    ethereum: [
        // keccak256("isBlackListed(address)")[:4] and keccak256("isBlacklisted(address)")[:4].
        { token: '0xdac17f958d2ee523a2206206994597c13d831ec7', selector: '0xe47d6060', label: 'USDT (Tether)' },
        { token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', selector: '0xfe575a87', label: 'USDC (Circle)' },
    ],
    tron: [{ token: TRON_USDT, selector: 'isBlackListed(address)', label: 'USDT (Tether)' }],
};

export const freeze = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.chain_explorer_freeze_status',
        content_type: 'vineyard:plugin',
        name: 'Stablecoin Freeze Status',
        version: '1.0.0',
        description:
            "Asks the issuers' contracts whether each selected Crypto Address is frozen: USDT and USDC on Ethereum, USDT on TRON. A frozen address gets frozen_by_issuer (e.g. \"USDT (Tether)\"); every address checked gets frozen_checked_at. An address the issuer has since unfrozen keeps an older frozen_by_issuer, which the summary points out.",
        icon: 'snowflake',
        platforms: PLATFORMS,
        io: { consumes: [crypto('crypto_address')], produces: [crypto('crypto_address')] },
        scopes: { graph: READ_ONLY, network: [E.rpc_ethereum, E.trongrid_wallet] },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const { nodes: selected, other } = await selectedOfType(ctx, ADDRESS);
        if (!selected.length) return { summary: 'Select Crypto Address nodes first', counts: { checked: 0, frozen: 0 } };
        const http = new Http(ctx);
        const report = new Report();
        let checked = 0;
        let frozen = 0;
        const stale: string[] = [];
        const partial: string[] = [];
        for (let i = 0; i < selected.length; i++) {
            if (ctx.signal?.aborted) throw abortErr();
            if (http.outOfTime) {
                report.stopped = `STOPPED: the run reached its time budget; ${selected.length - i} address(es) were not checked — run them again`;
                break;
            }
            const n = selected[i];
            const network = str(n.data?.network);
            const lists = FREEZE_LISTS[network];
            if (!lists) {
                report.skip(network === 'evm' ? 'its network is "evm": run Identify Crypto Network first' : `no issuer freeze list is read on ${chainName(network) || 'this network'}`);
                continue;
            }
            const c = canonicalOn(network, n.data?.address);
            if (!c) {
                report.skip(`the address is not one ${chainName(network)} accepts`);
                continue;
            }
            ctx.progress?.set?.({ percent: Math.round((i / selected.length) * 100), message: `${chainName(network)}: ${c.address}` });
            try {
                const hits: string[] = [];
                let unanswered = 0;
                for (const l of lists) {
                    const f = network === 'tron' ? await tronFlag(http, l.token, l.selector, c.address) : await evmFlag(http, network, l.token, l.selector, c.address);
                    if (f === true) hits.push(l.label);
                    else if (f === undefined) unanswered++;
                }
                if (unanswered === lists.length) {
                    report.fail(c.address, 'no issuer contract answered');
                    continue;
                }
                if (unanswered) partial.push(c.address);
                checked++;
                const delta: Record<string, unknown> = { frozen_checked_at: nowIso() };
                if (hits.length) {
                    delta.frozen_by_issuer = hits.join('; ');
                    frozen++;
                } else if (str(n.data?.frozen_by_issuer)) stale.push(c.address);
                await ctx.graph!.updateNode!(n.id, delta);
            } catch (e) {
                if (!report.caught(e, c.address, selected.length - i)) break;
            }
        }
        report.line(`${checked} of ${selected.length} address(es) checked, ${frozen} frozen`);
        if (partial.length) report.line(`${partial.length} answered by only some of the issuers' contracts`);
        if (stale.length) report.line(`${stale.length} are no longer frozen but still carry an older frozen_by_issuer (${stale.slice(0, 2).join(', ')}): clear it by hand if the issuer lifted the freeze`);
        if (other) report.line(`${other} selected node(s) are not Crypto Addresses`);
        return { summary: report.text(http), counts: { checked, frozen, skipped: report.skipped, failed: report.failed } };
    },
});
