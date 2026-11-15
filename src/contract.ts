// Contract and Token — whether an address is a contract or an ordinary account, a token's symbol and
// decimals, and who deployed a contract, where a keyless source says.
import { definePlugin } from './sdk';
import type { HostContext, RunResult } from './sdk';
import { CHAINS } from './chains';
import { ADDRESS, chainName, crypto, E, EVM_RPC_SCOPES, LIFECYCLE, PLATFORMS, Report, requireNet, selectedOfType, WRITES } from './common';
import { canonicalOn } from './formats';
import { Links, Nodes } from './graph';
import { abortErr, firstAnswer, Http, VendorDown } from './http';
import { onSolana, RunState } from './sources';
import { blockscoutAddress, erc20Meta, isDelegation, routescanCreation, rpc } from './vendors/evm';
import { solanaAccount } from './vendors/solana';
import { trc20Meta, tronAddr, tronContract } from './vendors/tron';
import { compact, evmAddress, hexHash, str } from './values';

const SPL_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * Who deployed a contract, by network, in the order tried (X-1): Routescan's
 * `getcontractcreation` for Ethereum and Avalanche C-Chain, Blockscout's `creator_address_hash` for
 * Ethereum and OP Mainnet (both read without a key, 2026-11-14). The other EVM chains need a key.
 */
export const DEPLOYER_SOURCES: Readonly<Record<string, readonly ('routescan' | 'blockscout')[]>> = {
    ethereum: ['routescan', 'blockscout'],
    avalanche_c: ['routescan'],
    optimism: ['blockscout'],
};

async function evmDeployer(http: Http, network: string, address: string): Promise<{ deployer: string; tx_hash?: string; source: string } | null> {
    const order = DEPLOYER_SOURCES[network];
    if (!order) return null;
    const r = await firstAnswer(
        order.map((v) => ({
            vendor: v,
            run: async () => {
                if (v === 'routescan') {
                    const c = await routescanCreation(http, network, address);
                    return c ? { ...c, source: 'Routescan' } : null;
                }
                const a = await blockscoutAddress(http, network, address);
                const deployer = evmAddress(a?.creator_address_hash);
                return deployer ? { deployer, tx_hash: hexHash(a?.creation_transaction_hash, true) ?? undefined, source: 'Blockscout' } : null;
            },
        })),
    );
    return r.value;
}

export const contract = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.chain_explorer_contract_token',
        content_type: 'vineyard:plugin',
        name: 'Crypto Contract and Token',
        version: '1.0.0',
        description:
            "Says whether each selected Crypto Address is a contract or an ordinary account (address_kind; an EIP-7702 delegated wallet stays an account), and for a token contract writes a Crypto Token with its standard, symbol, name and decimals, linked 'token contract'. For a contract it adds the deployer and deployment transaction where a keyless source has them — Ethereum, Avalanche C-Chain, OP Mainnet and TRON — linking the deployer 'deployed'. EVM chains (all eight), TRON and Solana.",
        icon: 'file-code',
        platforms: PLATFORMS,
        io: { consumes: [crypto('crypto_address')], produces: [crypto('crypto_address'), crypto('crypto_token')] },
        scopes: { graph: WRITES, network: [...EVM_RPC_SCOPES, E.routescan_eth, E.routescan_avax, E.blockscout_eth, E.blockscout_op, E.trongrid_wallet, E.solana, E.solana_publicnode] },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        requireNet(ctx);
        const { nodes: selected, other } = await selectedOfType(ctx, ADDRESS);
        if (!selected.length) return { summary: 'Select Crypto Address nodes first', counts: { checked: 0, read: 0 } };
        const http = new Http(ctx);
        const state = new RunState();
        const links = new Links(ctx);
        const nodes = new Nodes(ctx);
        const report = new Report();
        let read = 0;
        let contracts = 0;
        let tokens = 0;
        let deployers = 0;
        const noDeployer = new Set<string>();
        for (let i = 0; i < selected.length; i++) {
            if (ctx.signal?.aborted) throw abortErr();
            if (http.outOfTime) {
                report.stopped = `STOPPED: the run reached its time budget; ${selected.length - i} address(es) were not looked up — run them again`;
                break;
            }
            const n = selected[i];
            const network = str(n.data?.network);
            const fam = CHAINS[network]?.family;
            if (fam !== 'evm' && fam !== 'tron' && fam !== 'solana') {
                report.skip(network === 'evm' || network === 'unknown' ? `its network is "${network}": run Identify Crypto Network first` : `${chainName(network)} has no contracts this plugin reads`);
                continue;
            }
            const c = canonicalOn(network, n.data?.address);
            if (!c) {
                report.skip(`the address is not one ${chainName(network)} accepts`);
                continue;
            }
            const address = c.address;
            nodes.knowAddress(network, address, str(n.data?.memo) || undefined, n.id);
            ctx.progress?.set?.({ percent: Math.round((i / selected.length) * 100), message: `${chainName(network)}: ${address}` });
            try {
                const delta: Record<string, unknown> = {};
                let token: { standard: string; symbol?: string; name?: string; decimals?: number } | null = null;
                let dep: { deployer: string; tx_hash?: string; source: string } | null = null;
                if (fam === 'evm') {
                    const [code] = await rpc(http, network, [{ method: 'eth_getCode', params: [address, 'latest'] }]);
                    if (typeof code !== 'string') throw new VendorDown('rpc', `${chainName(network)} JSON-RPC gave no code for the address`);
                    if (code === '0x' || isDelegation(code)) {
                        delta.address_kind = 'eoa';
                        if (isDelegation(code)) delta.eip7702_delegate = `0x${code.slice(8).toLowerCase()}`;
                    } else {
                        delta.address_kind = 'contract';
                        contracts++;
                        const m = await erc20Meta(http, network, address);
                        if (m.decimals !== undefined && (m.symbol || m.name)) token = { standard: 'erc20', ...m };
                        if (DEPLOYER_SOURCES[network]) dep = await evmDeployer(http, network, address);
                        else noDeployer.add(chainName(network));
                    }
                } else if (fam === 'tron') {
                    const k = await tronContract(http, address);
                    if (!k) delta.address_kind = 'eoa';
                    else {
                        delta.address_kind = 'contract';
                        contracts++;
                        const m = await trc20Meta(http, address);
                        if (m.decimals !== undefined && (m.symbol || m.name)) token = { standard: 'trc20', ...m };
                        if (k.deployer) dep = { deployer: k.deployer, source: 'TronGrid' };
                    }
                } else {
                    const acct = await onSolana(http, state, (node) => solanaAccount(http, node, address));
                    if (!acct) {
                        report.skip('no Solana account at the address (never funded, or closed)');
                        continue;
                    }
                    const owner = str(acct.owner);
                    const parsed = acct.data?.parsed;
                    if (acct.executable === true) {
                        delta.address_kind = 'contract';
                        contracts++;
                    } else if (SPL_PROGRAMS.has(owner) && parsed?.type === 'mint') {
                        const dec = parsed.info?.decimals;
                        token = { standard: 'spl', decimals: Number.isInteger(dec) ? dec : undefined };
                    } else if (SPL_PROGRAMS.has(owner) && parsed?.type === 'account') {
                        delta.address_kind = 'token_account';
                        const holder = str(parsed.info?.owner);
                        if (holder) delta.token_account_owner = holder;
                    } else if (owner === SYSTEM_PROGRAM) {
                        delta.address_kind = 'eoa';
                    }
                }
                if (dep) {
                    delta.deployer = dep.deployer;
                    if (dep.tx_hash) delta.deployment_tx = dep.tx_hash;
                    const did = await nodes.address(network, network === 'tron' ? (tronAddr(dep.deployer) ?? dep.deployer) : dep.deployer);
                    // A pair already linked (the deployer also paid the contract) gets `deployment`
                    // added; only a pair with no link is labelled `deployed`.
                    await links.put(did, n.id, 'deployed', { deployment: compact({ tx_hash: dep.tx_hash, source: dep.source }) });
                    deployers++;
                }
                if (Object.keys(delta).length) await ctx.graph!.updateNode!(n.id, delta);
                if (token) {
                    const tid = await nodes.token(network, address, compact({ standard: token.standard, symbol: token.symbol, name: token.name, decimals: token.decimals }));
                    await links.put(n.id, tid, 'token contract', {});
                    tokens++;
                }
                read++;
            } catch (e) {
                if (!report.caught(e, address, selected.length - i)) break;
            }
        }
        report.line(`${read} of ${selected.length} address(es) read: ${contracts} contract(s), ${tokens} token(s), ${deployers} deployer(s)`);
        if (noDeployer.size) report.line(`deployers were not read on ${[...noDeployer].join(', ')}: this pack reads them on Ethereum, Avalanche C-Chain, OP Mainnet and TRON`);
        if (other) report.line(`${other} selected node(s) are not Crypto Addresses`);
        return { summary: report.text(http), counts: { checked: selected.length, read, tokens, skipped: report.skipped, failed: report.failed } };
    },
});

