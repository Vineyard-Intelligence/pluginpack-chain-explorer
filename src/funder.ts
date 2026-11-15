// Activation and First Funder — when an account came to exist and who first paid it, where a
// keyless source can say: TRON (TronGrid, the X-26 rule) and the XRP Ledger (XRPSCAN).
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { ADDRESS, chainName, crypto, E, LIFECYCLE, PLATFORMS, Report, requireNet, selectedOfType, WRITES } from './common';
import { CHAINS } from './chains';
import { canonicalOn, xrplClassic } from './formats';
import { Links, Nodes } from './graph';
import { abortErr, Http } from './http';
import { xrpscanAccount } from './vendors/ledgers';
import { trongridActivation } from './vendors/tron';
import { compact, isoTime, str } from './values';

/** Why a network is not covered. No other pack is named: one not listed in the registry leads nowhere. */
export function funderElsewhere(network: string): string {
    const fam = CHAINS[network]?.family;
    if (fam === 'evm' || network === 'polygon' || network === 'arbitrum' || network === 'base') {
        return 'EVM first funders need a keyed source: no keyless one names them';
    }
    if (fam === 'solana') return 'Solana first funders need a keyed source: the public RPC keeps no full history to search';
    if (fam === 'utxo') return 'the Bitcoin family has no single first funder: a transaction can spend inputs from many addresses, so read the first transaction with Crypto Address History';
    if (network === 'evm' || network === 'unknown') return `its network is "${network}", not established yet: run Identify Crypto Network first`;
    return `no keyless source gives first funders on ${chainName(network)}`;
}

export const funder = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.chain_explorer_first_funder',
        content_type: 'vineyard:plugin',
        name: 'Crypto Activation and First Funder',
        version: '1.0.0',
        description:
            "For TRON and XRP Ledger addresses: when the account was activated and which address first funded it, read without a key. TRON follows the activation, not the earliest incoming transfer; when the activation is not a plain transfer it says 'could not tell' rather than guessing. Writes activated_at, first_funder and first_funding_tx, and adds first_funding to the funder's 'sent to' link. A node with a memo (a destination tag) is skipped, since activation is the account's. EVM and Solana first funders need a keyed pack.",
        icon: 'sprout',
        platforms: PLATFORMS,
        io: { consumes: [crypto('crypto_address')], produces: [crypto('crypto_address')] },
        scopes: { graph: WRITES, network: [E.trongrid_v1, E.xrpscan] },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const { nodes: selected, other } = await selectedOfType(ctx, ADDRESS);
        if (!selected.length) return { summary: 'Select Crypto Address nodes first', counts: { checked: 0, found: 0 } };
        const http = new Http(ctx);
        const links = new Links(ctx);
        const nodes = new Nodes(ctx);
        const report = new Report();
        let found = 0;
        let inactive = 0;
        const unclear: string[] = [];
        for (let i = 0; i < selected.length; i++) {
            if (ctx.signal?.aborted) throw abortErr();
            if (http.outOfTime) {
                report.stopped = `STOPPED: the run reached its time budget; ${selected.length - i} address(es) were not looked up — run them again`;
                break;
            }
            const n = selected[i];
            const network = str(n.data?.network);
            const c = canonicalOn(network, n.data?.address);
            if (network !== 'tron' && network !== 'xrpl') {
                report.skip(funderElsewhere(network));
                continue;
            }
            if (!c) {
                report.skip(`the address is not one ${chainName(network)} accepts`);
                continue;
            }
            // A memo (an XRPL destination tag) is one recipient behind an account, and activation
            // is the account's: written here, the account's activator became the "first funder" of
            // one exchange customer's deposit tag, with a 'sent to' link it never made (review of
            // 1.0.0).
            if (str(n.data?.memo) || c.memo) {
                report.skip('a destination tag or memo has no activation of its own: run it on the address without the memo');
                continue;
            }
            nodes.knowAddress(network, c.address, undefined, n.id);
            ctx.progress?.set?.({ percent: Math.round((i / selected.length) * 100), message: `${chainName(network)}: ${c.address}` });
            try {
                if (network === 'tron') {
                    const a = await trongridActivation(http, c.address);
                    if (a.state === 'inactive') {
                        inactive++;
                        continue;
                    }
                    if (a.state === 'unknown') {
                        // activated_at is the time of the block holding the activation, which was
                        // not found; create_time is the block before it, so it is not written as
                        // activated_at here (nor by Address History) and only named in the summary.
                        unclear.push(`${c.address}: ${a.why}; TronGrid's create_time is ${a.created}`);
                        continue;
                    }
                    await ctx.graph!.updateNode!(n.id, { activated_at: a.time, first_funder: a.funder, first_funding_tx: a.tx_hash });
                    const fid = await nodes.address('tron', a.funder);
                    await links.put(fid, n.id, 'sent to', { network: 'tron', first_funding: compact({ tx_hash: a.tx_hash, time: a.time, amount: a.amount, source: 'trongrid' }) });
                    found++;
                } else {
                    const r = await xrpscanAccount(http, c.address);
                    if (!r) {
                        inactive++;
                        continue;
                    }
                    const parent = xrplClassic(str(r.parent));
                    const tx = /^[0-9a-fA-F]{64}$/.test(str(r.tx_hash)) ? str(r.tx_hash).toLowerCase() : undefined;
                    const time = isoTime(r.inception);
                    if (!parent) {
                        unclear.push(`${c.address}: XRPSCAN names no parent account`);
                        if (time) await ctx.graph!.updateNode!(n.id, { activated_at: time });
                        continue;
                    }
                    await ctx.graph!.updateNode!(n.id, compact({ activated_at: time, first_funder: parent, first_funding_tx: tx }));
                    const fid = await nodes.address('xrpl', parent);
                    const amount = typeof r.initial_balance === 'number' && Number.isFinite(r.initial_balance) && r.initial_balance >= 0 ? String(r.initial_balance) : undefined;
                    await links.put(fid, n.id, 'sent to', { network: 'xrpl', first_funding: compact({ tx_hash: tx, time, amount: amount && /^\d+(\.\d+)?$/.test(amount) ? amount : undefined, source: 'xrpscan' }) });
                    found++;
                }
            } catch (e) {
                if (!report.caught(e, c.address, selected.length - i)) break;
            }
        }
        report.line(`${found} first funder(s) found`);
        if (inactive) report.line(`${inactive} address(es) are not activated on their network`);
        if (unclear.length) report.line(`could not tell for ${unclear.length}, so no funder was written: ${unclear.slice(0, 2).join('; ')}`);
        if (links.created || links.amended) report.line(`${links.created} new 'sent to' link(s), ${links.amended} existing link(s) given first_funding`);
        if (other) report.line(`${other} selected node(s) are not Crypto Addresses`);
        return { summary: report.text(http), counts: { checked: selected.length, found, skipped: report.skipped, failed: report.failed } };
    },
});
