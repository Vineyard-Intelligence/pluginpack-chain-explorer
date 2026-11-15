// Public Labels — the tags block explorers publish for an address: Tronscan's public tag, Blockscout's
// name tags, XRPSCAN's verified account names.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { BLOCKSCOUT } from './chains';
import { ADDRESS, chainName, crypto, E, LIFECYCLE, PLATFORMS, READ_ONLY, Report, requireNet, selectedOfType } from './common';
import { canonicalOn } from './formats';
import { abortErr, Http } from './http';
import { blockscoutAddress, blockscoutLabel } from './vendors/evm';
import { xrpscanAccount } from './vendors/ledgers';
import { tronscanTag } from './vendors/tron';
import { compact, evmAddress, str } from './values';

/**
 * The address's own label from the address objects embedded in a Blockscout list answer. Pure.
 *
 * The public instances return `metadata: null` on the address endpoint for labelled wallets when
 * asked anonymously, and the same labels in every list row's `from` / `to` objects (measured
 * 2026-11-15 on eth.blockscout.com: Binance 14 bare, vitalik.eth named in his own rows).
 */
export function ownLabelInRows(items: unknown, address: string): string | undefined {
    for (const it of Array.isArray(items) ? items : []) {
        for (const a of [(it as any)?.from, (it as any)?.to]) {
            if (evmAddress(a?.hash) === address) {
                const l = blockscoutLabel(a);
                if (l) return l;
            }
        }
    }
    return undefined;
}

export const labels = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.chain_explorer_public_labels',
        content_type: 'vineyard:plugin',
        name: 'Crypto Public Labels',
        version: '1.0.0',
        description:
            "Reads the label a block explorer publishes for each selected Crypto Address and writes it as public_label with label_source: Tronscan's public tag on TRON (e.g. an exchange hot wallet), Blockscout's name tags on Ethereum, OP Mainnet and Ethereum Classic, and XRPSCAN's account names on the XRP Ledger, with whether XRPSCAN verified the name. A label is the explorer's claim, not an attribution.",
        icon: 'tag',
        platforms: PLATFORMS,
        io: { consumes: [crypto('crypto_address')], produces: [crypto('crypto_address')] },
        scopes: { graph: READ_ONLY, network: [E.tronscan, E.blockscout_eth, E.blockscout_op, E.blockscout_etc, E.xrpscan] },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const { nodes: selected, other } = await selectedOfType(ctx, ADDRESS);
        if (!selected.length) return { summary: 'Select Crypto Address nodes first', counts: { checked: 0, labelled: 0 } };
        const http = new Http(ctx);
        const report = new Report();
        let labelled = 0;
        let none = 0;
        for (let i = 0; i < selected.length; i++) {
            if (ctx.signal?.aborted) throw abortErr();
            if (http.outOfTime) {
                report.stopped = `STOPPED: the run reached its time budget; ${selected.length - i} address(es) were not looked up — run them again`;
                break;
            }
            const n = selected[i];
            const network = str(n.data?.network);
            if (network !== 'tron' && network !== 'xrpl' && !BLOCKSCOUT[network]) {
                report.skip(`no keyless source publishes labels for ${chainName(network)}`);
                continue;
            }
            const c = canonicalOn(network, n.data?.address);
            if (!c) {
                report.skip(`the address is not one ${chainName(network)} accepts`);
                continue;
            }
            ctx.progress?.set?.({ percent: Math.round((i / selected.length) * 100), message: `${chainName(network)}: ${c.address}` });
            try {
                let delta: Record<string, unknown> = {};
                if (network === 'tron') {
                    const tag = await tronscanTag(http, c.address);
                    if (tag) delta = { public_label: tag, label_source: 'Tronscan' };
                } else if (network === 'xrpl') {
                    const r = await xrpscanAccount(http, c.address);
                    const name = str(r?.accountName?.name);
                    if (name) {
                        delta = compact({
                            public_label: name,
                            label_source: r.accountName.verified === true ? 'XRPSCAN (verified)' : 'XRPSCAN',
                            label_domain: str(r.accountName.domain) || undefined,
                        });
                    }
                } else {
                    const b = BLOCKSCOUT[network];
                    const a = await blockscoutAddress(http, network, c.address);
                    let label = blockscoutLabel(a);
                    if (!label && a) {
                        const rows = await http.get(b.vendor, `${b.base}addresses/${c.address}/transactions`);
                        label = ownLabelInRows(rows?.items, c.address);
                    }
                    if (label) delta = { public_label: label, label_source: 'Blockscout' };
                }
                if (Object.keys(delta).length) {
                    await ctx.graph!.updateNode!(n.id, delta);
                    labelled++;
                } else none++;
            } catch (e) {
                if (!report.caught(e, c.address, selected.length - i)) break;
            }
        }
        report.line(`${labelled} of ${selected.length} address(es) labelled`);
        if (none) report.line(`${none} have no public label`);
        if (other) report.line(`${other} selected node(s) are not Crypto Addresses`);
        return { summary: report.text(http), counts: { checked: selected.length, labelled, skipped: report.skipped, failed: report.failed } };
    },
});
