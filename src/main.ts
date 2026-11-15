// Chain Explorer pack — keyless blockchain lookups for VINEYARD, one member per task rather than per
// vendor: each member picks the vendor from the node's `network` and falls back to the next one.
//
// KEY MODEL: none. No member takes a key, so the pack never asks for one; the shared Ethplorer /
// Binplorer `freekey` is the same public value for everyone and is no key in that sense. A vendor
// whose keyed tier only raises limits (TronGrid, Routescan, SoChain, BlockCypher, toncenter) is used
// here without a key; its keyed path belongs in a pack of its own, because the app files a key by
// pack and network origins, and a key field here would make this pack's page untrue.
//
// Graph writes are STAGED: nothing reaches the project until the analyst reviews and applies it.
import { definePluginPack } from './sdk';
import type { PluginManifest, VineyardPluginPack } from './sdk';
import { PLATFORMS } from './common';
import { identify } from './identify';
import { history } from './history';
import { transaction } from './transaction';
import { funder } from './funder';
import { contract } from './contract';
import { labels } from './labels';
import { freeze } from './freeze';

// The pack's page in the marketplace drawer, in Markdown. Lines in an array rather than one template
// literal, because the Markdown is full of backticks.
const PAGE = [
    'For following funds with no account or key, on fifteen networks from Bitcoin to TON: an address’s transfers and counterparties, a transaction’s inputs and outputs, which network a bare address is on, TRON and XRP Ledger first funders, contracts, tokens, explorer labels, and Tether and Circle freezes.',
    '',
    '**Needs:** nothing. The free tiers promise no uptime and limit requests.',
    '',
    '**Terms:** Routescan: internal, informational and personal use; commercial decisions need written approval, and non-private use must show “Powered by Routescan.io APIs”. BlockCypher: internal use only. SoChain: no bulk copying or redistribution. XRPSCAN: CC BY-NC-SA 4.0. Ethplorer and Binplorer ask for credit.',
    '',
    '**Who sees it:** each address and transaction goes to the explorers for its network: mempool.space, Blockstream, litecoinspace.org, Haskoin, SoChain, BlockCypher, insight.dash.org, Routescan, Blockscout, Binplorer, PublicNode, TronGrid, Tronscan, Solana Foundation, xrplcluster.com, xrpl.ws, XRPSCAN, toncenter. Not the addresses’ owners.',
    '',
    '**Read results with care:**',
    '',
    '- Figures cover the window each link states: on BNB Smart Chain 30 days at most, on Solana what its public node keeps.',
    '- Explorers can disagree on a balance; each names its source.',
    '- An EVM address that has only received tokens can stay undecided, as can any while a needed explorer is down.',
    '- A label is the explorer’s claim, not an attribution.',
    '',
    '**Source:** https://github.com/Vineyard-Intelligence/pluginpack-chain-explorer (Apache-2.0)',
].join('\n');

const pack: VineyardPluginPack & {
    author: { name: string; url: string };
    license: string;
    icon: string;
    platforms: PluginManifest['platforms'];
} = {
    identifier: 'run.vineyard.pluginpacks.chain_explorer',
    content_type: 'vineyard:pluginpack',
    name: 'Chain Explorer',
    version: '1.0.0',
    summary:
        'Keyless blockchain lookups on fifteen networks: address history and counterparties, transactions, which network an address is on, TRON and XRP Ledger first funders, contracts and tokens, explorer labels and stablecoin freezes. No account or key.',
    description: PAGE,
    author: { name: 'VINEYARD', url: 'https://vineyard.run' },
    license: 'Apache-2.0',
    icon: 'waypoints',
    platforms: PLATFORMS,
    plugins: [identify, history, transaction, funder, contract, labels, freeze],
};

export const chainExplorerPack = definePluginPack(pack);
export default chainExplorerPack;
