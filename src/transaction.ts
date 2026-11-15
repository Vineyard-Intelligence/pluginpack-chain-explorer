// Transaction — one transaction's inputs and outputs, amounts and block time, on any network with
// a keyless source.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { CHAINS, noSource } from './chains';
import { chainName, crypto, E, EVM_RPC_SCOPES, intParam, LIFECYCLE, PLATFORMS, Report, requireNet, selectedOfType, TRANSACTION, WRITES } from './common';
import { Links, Nodes } from './graph';
import { abortErr, Http } from './http';
import { hasSource, readTx, RunState } from './sources';
import { tonHash } from './vendors/ledgers';
import { compact, hexHash, SOLANA_SIGNATURE, str } from './values';
import { accountParties, partyData, writeUtxoTx } from './write';

/** The hash as the pack queries and writes it on `network`, or null when it cannot be one there. */
export function txHashOn(network: string, raw: string): string | null {
    const fam = CHAINS[network]?.family;
    if (fam === 'evm') return hexHash(raw, true);
    if (fam === 'solana') return SOLANA_SIGNATURE.test(raw) ? raw : null;
    if (fam === 'ton') return tonHash(raw);
    return hexHash(raw, false);
}

export const transaction = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.chain_explorer_transaction',
        content_type: 'vineyard:plugin',
        name: 'Crypto Transaction',
        version: '1.0.0',
        description:
            "Reads each selected Crypto Transaction on its network from a keyless source and writes its block, time, status, fee and kind. Links every address that paid into it 'input to' the transaction and every address it paid 'output to', with the amounts (on the Bitcoin family, each input and output). Same networks as Crypto Address History; a token amount whose decimals the token does not give stays in base units and the link says base_units.",
        icon: 'arrow-left-right',
        platforms: PLATFORMS,
        io: { consumes: [crypto('crypto_transaction')], produces: [crypto('crypto_transaction'), crypto('crypto_address')] },
        params: {
            type: 'object',
            properties: {
                max_parties: {
                    type: 'integer',
                    title: 'Most addresses linked per side',
                    description: 'Largest amounts first. A batch payout can pay hundreds of addresses.',
                    default: 50,
                    minimum: 1,
                    maximum: 500,
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
                ...EVM_RPC_SCOPES,
                E.trongrid_wallet,
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
        const { nodes: selected, other } = await selectedOfType(ctx, TRANSACTION);
        if (!selected.length) return { summary: 'Select Crypto Transaction nodes first', counts: { checked: 0, read: 0, links: 0 } };
        const maxParties = intParam(ctx, 'max_parties', 50, 1, 500);
        const http = new Http(ctx);
        const state = new RunState();
        const links = new Links(ctx);
        const nodes = new Nodes(ctx);
        const report = new Report();
        let read = 0;
        let notFound = 0;
        let notLinked = 0;
        for (let i = 0; i < selected.length; i++) {
            if (ctx.signal?.aborted) throw abortErr();
            const n = selected[i];
            const network = str(n.data?.network);
            const raw = str(n.data?.tx_hash);
            if (http.outOfTime) {
                report.stopped = `STOPPED: the run reached its time budget; ${selected.length - i} transaction(s) were not looked up — run them again`;
                break;
            }
            if (!hasSource(network)) {
                report.skip(noSource(network));
                continue;
            }
            const hash = txHashOn(network, raw);
            if (!hash) {
                report.skip(`not a transaction hash ${chainName(network)} uses`);
                continue;
            }
            nodes.knowTx(network, hash, n.id);
            ctx.progress?.set?.({ percent: Math.round((i / selected.length) * 100), message: `${chainName(network)}: ${hash}` });
            try {
                const { found } = await readTx(http, state, network, hash);
                if (!found) {
                    notFound++;
                    continue;
                }
                read++;
                if (found.kind === 'utxo') {
                    const t = found.tx;
                    // The selected node is known to `nodes`, so writeUtxoTx links it without
                    // writing its fields: they go on as a delta here.
                    await ctx.graph!.updateNode!(
                        n.id,
                        compact({ block_height: t.block_height, block_time: t.block_time, status: t.confirmed ? 'success' : 'pending', fee: t.fee, tx_kind: t.coinbase ? 'coinbase' : 'transfer' }),
                    );
                    const r = await writeUtxoTx(network, t, links, nodes, maxParties);
                    notLinked += r.notLinked;
                    continue;
                }
                const tx = found.tx;
                await ctx.graph!.updateNode!(
                    n.id,
                    compact({ block_height: tx.block_height, block_time: tx.block_time, status: tx.status, fee: tx.fee, tx_kind: tx.tx_kind, ...(tx.extra ?? {}) }),
                );
                const { senders, receivers } = accountParties(tx.moves);
                // The signer pays the fee and starts the transaction even when it moves no value.
                if (tx.signer && !senders.has(tx.signer)) senders.set(tx.signer, []);
                const pick = <T>(m: Map<string, T[]>) => [...m].sort((a, b) => b[1].length - a[1].length).slice(0, maxParties);
                notLinked += Math.max(0, senders.size - maxParties) + Math.max(0, receivers.size - maxParties);
                for (const [address, moves] of pick(senders)) {
                    const id = await nodes.address(network, address);
                    await links.put(id, n.id, 'input to', moves.length ? partyData(moves) : { role: 'signer' });
                }
                for (const [key, moves] of pick(receivers)) {
                    const [address, memo] = key.split('|');
                    const id = await nodes.address(network, address, {}, memo || undefined);
                    await links.put(n.id, id, 'output to', partyData(moves));
                }
                if (tx.created_contract) {
                    const id = await nodes.address(network, tx.created_contract, { address_kind: 'contract' });
                    if (!links.wrote(n.id, id)) await links.put(n.id, id, 'output to', { created: true });
                }
            } catch (e) {
                if (!report.caught(e, raw || n.id, selected.length - i)) break;
            }
        }
        ctx.progress?.set?.({ percent: 100 });
        report.line(`${read} of ${selected.length} transaction(s) read`);
        if (notFound) report.line(`${notFound} not found on their network by its sources`);
        if (links.created || links.amended) report.line(`${links.created} new link(s), ${links.amended} existing link(s) given figures`);
        if (nodes.created) report.line(`${nodes.created} node(s) added`);
        if (notLinked) report.line(`${notLinked} address(es) beyond "Most addresses linked per side" were not linked`);
        if (other) report.line(`${other} selected node(s) are not Crypto Transactions`);
        return { summary: report.text(http), counts: { checked: selected.length, read, links: links.created + links.amended, skipped: report.skipped, failed: report.failed } };
    },
});
