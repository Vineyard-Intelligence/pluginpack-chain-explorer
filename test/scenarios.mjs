// The runs live-test.mjs records against the real vendors and test-plugin.mjs replays.
//
// Every vendor path is in here at least once. `block` makes the recorder answer 429 for a host
// without calling it, so the member moves to the next vendor, which IS called live: that is how
// the fallbacks (blockstream.info, SoChain, BlockCypher, insight.dash.org, eth.blockscout.com,
// Tronscan, xrpl.ws) were exercised. Seeds are public addresses and transactions: exchange hot
// wallets, token contracts, well-known early transactions.
//
// `capturedBy: 'curl'`: insight.dash.org sits behind a Cloudflare check that refuses Node's fetch
// (its User-Agent is "node"; 403 "Just a moment", 2026-11-15) and serves curl and browsers. Those
// two fixtures were assembled from curl captures of the same requests, and live-test.mjs leaves
// them alone unless named.

const A = (id, network, address, extra = {}) => ({ id, type: 'cryptocurrency.crypto_address', data: { network, address, ...extra } });
const T = (id, network, tx_hash) => ({ id, type: 'cryptocurrency.crypto_transaction', data: { network, tx_hash } });

const VITALIK = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

export const SCENARIOS = [
    // ---- Identify Crypto Network ------------------------------------------------------------
    {
        name: 'identify-mixed',
        plugin: 'identify_network',
        nodes: [
            A('evm1', 'evm', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'),
            A('unk-legacy', 'unknown', '1XPTgDRhN8RFnzniWCddobD9iKZatrvH4'),
            A('unk-doge', 'unknown', 'DTVc1s63gmVbdp9KfTpAda34tAJaWiAfww'),
            A('unk-tronhex', 'unknown', '41d1c4bb7b2f39aba5707711719b2236b5b605af2e'),
            A('unk-tonraw', 'unknown', '0:83DFD552E63729B472FCBCC8C45EBCC6691702558B68EC7527E1BA403A0F31A8'),
            A('unk-bech', 'unknown', 'LTC1QFACLLV7M4S2EQUY7993AZ05TZ3RX6ZHDHG5LFY'),
            { id: 'legacy-btc', type: 'financial.crypto_address', data: { address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', currency: 'btc', owner_label: 'Example P2SH', balance: 0.5 } },
            { id: 'pay-ltc', type: 'web.tracking_id', data: { provider: 'litecoin', kind: 'payment', value: 'LKcKHmHMYA9n5htDNAAcngSmmgXg8LGpBB' } },
            { id: 'pay-other', type: 'web.tracking_id', data: { provider: 'google_analytics', kind: 'analytics', value: 'G-ABC' } },
        ],
        selection: ['evm1', 'unk-legacy', 'unk-doge', 'unk-tronhex', 'unk-tonraw', 'unk-bech', 'legacy-btc', 'pay-ltc', 'pay-other'],
    },
    {
        name: 'identify-sweep',
        plugin: 'identify_network',
        nodes: [
            A('ltc-p2sh', 'litecoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'),
            A('done', 'unknown', 'bc1qq2mvrp4g3ugd424dw4xv53rgsf8szkrv853jrc'),
            A('btc-new', 'bitcoin', 'bc1qq2mvrp4g3ugd424dw4xv53rgsf8szkrv853jrc'),
            A('evm-fresh', 'evm', '0x00000000000000000000000000000000000c0ffe'),
        ],
        edges: [{ id: 'e1', from_node_id: 'done', to_node_id: 'btc-new', label: 'same address on' }],
        selection: [],
    },
    // ---- Crypto Address History -------------------------------------------------------------
    { name: 'history-bitcoin', plugin: 'address_history', nodes: [A('s', 'bitcoin', '1XPTgDRhN8RFnzniWCddobD9iKZatrvH4')], selection: ['s'], params: { max_txs: 3, max_parties_per_tx: 3 } },
    { name: 'history-litecoin', plugin: 'address_history', nodes: [A('s', 'litecoin', 'LKcKHmHMYA9n5htDNAAcngSmmgXg8LGpBB')], selection: ['s'], params: { max_txs: 3, max_parties_per_tx: 3 } },
    { name: 'history-litecoin-sochain', plugin: 'address_history', block: ['litecoinspace.org'], nodes: [A('s', 'litecoin', 'LKcKHmHMYA9n5htDNAAcngSmmgXg8LGpBB')], selection: ['s'], params: { max_txs: 2 } },
    { name: 'history-litecoin-blockcypher', plugin: 'address_history', block: ['litecoinspace.org', 'sochain.com'], nodes: [A('s', 'litecoin', 'LKcKHmHMYA9n5htDNAAcngSmmgXg8LGpBB')], selection: ['s'], params: { max_txs: 2 } },
    { name: 'history-bitcoin-cash', plugin: 'address_history', nodes: [A('s', 'bitcoin_cash', 'bitcoincash:qzchaks7lhwcf7lfg3am7uqy8m2yjnywnccd424dcp')], selection: ['s'], params: { max_txs: 2, max_parties_per_tx: 2 } },
    { name: 'history-dogecoin', plugin: 'address_history', nodes: [A('s', 'dogecoin', 'DTVc1s63gmVbdp9KfTpAda34tAJaWiAfww')], selection: ['s'], params: { max_txs: 2 } },
    { name: 'history-dash', plugin: 'address_history', nodes: [A('s', 'dash', 'XqPTFgWrZWV569zmiUQ4WATErsKuGkvxwk')], selection: ['s'], params: { max_txs: 5 } },
    { name: 'history-dash-insight', plugin: 'address_history', capturedBy: 'curl', block: ['blockcypher.com'], nodes: [A('s', 'dash', 'XqPTFgWrZWV569zmiUQ4WATErsKuGkvxwk')], selection: ['s'], params: { max_txs: 5 } },
    { name: 'history-zcash', plugin: 'address_history', nodes: [A('s', 'zcash', 't1MKn34KBa8Xh4g8qU8psibBXvURafphVn7')], selection: ['s'], params: { max_txs: 2 } },
    { name: 'history-ethereum', plugin: 'address_history', nodes: [A('s', 'ethereum', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')], selection: ['s'], params: { max_pages: 1, max_counterparties: 5 } },
    { name: 'history-ethereum-blockscout', plugin: 'address_history', block: ['routescan.io'], nodes: [A('s', 'ethereum', '0x5227f603c1ee34ce3c06efe6477003bdfccb2f8c')], selection: ['s'], params: { max_pages: 1, max_counterparties: 5 } },
    { name: 'history-avalanche', plugin: 'address_history', nodes: [A('s', 'avalanche_c', '0x9f8c163cba728e99993abe7495f06c0a3c8ac8b9')], selection: ['s'], params: { max_pages: 1, max_counterparties: 5 } },
    { name: 'history-optimism', plugin: 'address_history', nodes: [A('s', 'optimism', '0xacd03d601e5bb1b275bb94076ff46ed9d753435a')], selection: ['s'], params: { max_pages: 1, max_counterparties: 5 } },
    { name: 'history-bsc', plugin: 'address_history', nodes: [A('s', 'bsc', '0x8894e0a0c962cb723c1976a4421c95949be2d4e3')], selection: ['s'], params: { max_counterparties: 5 } },
    { name: 'history-etc', plugin: 'address_history', nodes: [A('s', 'ethereum_classic', '0x9eab4b0fc468a7f5d46228bf5a76cb52370d068d')], selection: ['s'], params: { max_pages: 1, max_counterparties: 5 } },
    { name: 'history-tron', plugin: 'address_history', nodes: [A('s', 'tron', 'TACcFecYGH2sfsSJcjoYcXCdZFebv2ZKyi')], selection: ['s'], params: { max_pages: 1, max_counterparties: 5 } },
    { name: 'history-tron-tronscan', plugin: 'address_history', block: ['trongrid.io'], nodes: [A('s', 'tron', 'TACcFecYGH2sfsSJcjoYcXCdZFebv2ZKyi')], selection: ['s'], params: { max_pages: 1, max_counterparties: 5 } },
    { name: 'history-solana', plugin: 'address_history', nodes: [A('s', 'solana', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')], selection: ['s'], params: { max_txs: 3, max_counterparties: 5 } },
    { name: 'history-xrpl', plugin: 'address_history', nodes: [A('s', 'xrpl', 'rsnrorxzHhRstuPr25zVqG5SAH2sy7GvNM')], selection: ['s'], params: { max_pages: 1, max_counterparties: 5 } },
    { name: 'history-xrpl-memo', plugin: 'address_history', block: ['xrplcluster.com'], nodes: [A('s', 'xrpl', 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w', { memo: '1' })], selection: ['s'], params: { max_pages: 1, max_counterparties: 5 } },
    { name: 'history-ton', plugin: 'address_history', nodes: [A('s', 'ton', '0:4d7d028d55ce9db037c0dfab4020a0ab274dc3ff570d4e20d39bbf49efe3df8b')], selection: ['s'], params: { max_pages: 1, max_counterparties: 5 } },
    {
        name: 'history-skips',
        plugin: 'address_history',
        nodes: [A('poly', 'polygon', VITALIK), A('evm', 'evm', VITALIK), A('bad', 'bitcoin', '1XPTgDRhN8RFnzniWCddobD9iKZatrvH5'), A('xmr', 'monero', '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge')],
        selection: ['poly', 'evm', 'bad', 'xmr'],
    },
    // ---- Crypto Transaction -----------------------------------------------------------------
    { name: 'tx-bitcoin', plugin: 'transaction', nodes: [T('t', 'bitcoin', 'a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d')], selection: ['t'] },
    { name: 'tx-litecoin', plugin: 'transaction', nodes: [T('t', 'litecoin', '924fff86fe4314b61af07a3a897304e16b18ff022590f7b855715b501f92d425')], selection: ['t'] },
    { name: 'tx-litecoin-sochain', plugin: 'transaction', block: ['litecoinspace.org'], nodes: [T('t', 'litecoin', '924fff86fe4314b61af07a3a897304e16b18ff022590f7b855715b501f92d425')], selection: ['t'] },
    { name: 'tx-litecoin-blockcypher', plugin: 'transaction', block: ['litecoinspace.org', 'sochain.com'], nodes: [T('t', 'litecoin', '924fff86fe4314b61af07a3a897304e16b18ff022590f7b855715b501f92d425')], selection: ['t'] },
    { name: 'tx-bitcoin-cash', plugin: 'transaction', nodes: [T('t', 'bitcoin_cash', '199bd0f35796cfeae748564f957a28cf45a7d58ca878630e0cd979db93066070')], selection: ['t'], params: { max_parties: 5 } },
    { name: 'tx-dogecoin', plugin: 'transaction', nodes: [T('t', 'dogecoin', '95ea20dc882e38f0b0225bcffa416dd24c6d9afd9beb16d9ea618f3dff8ceacc')], selection: ['t'] },
    { name: 'tx-dash', plugin: 'transaction', nodes: [T('t', 'dash', '07ccbcf3b301c0ed1c2383e8643472c2e999751af74429d39a376b12e3980647')], selection: ['t'] },
    { name: 'tx-dash-insight', plugin: 'transaction', capturedBy: 'curl', block: ['blockcypher.com'], nodes: [T('t', 'dash', '07ccbcf3b301c0ed1c2383e8643472c2e999751af74429d39a376b12e3980647')], selection: ['t'] },
    { name: 'tx-zcash', plugin: 'transaction', nodes: [T('t', 'zcash', 'ac4958cc04b2d4ebf14cb1e4d1b9f707f4bf989b376df910c71bb5c3f5d47725')], selection: ['t'] },
    {
        name: 'tx-ethereum',
        plugin: 'transaction',
        nodes: [T('t', 'ethereum', '0xabcd0c3ba3c9befdab0c15189c752fede82819f1c9d5e6cad8e835594579e9a8'), T('u', 'ethereum', '25819640d70466d6a84c02601d930ef6507853938f68724b77c700ed107c539c')],
        selection: ['t', 'u'],
    },
    { name: 'tx-ethereum-blockscout', plugin: 'transaction', block: ['routescan.io'], nodes: [T('u', 'ethereum', '0x25819640d70466d6a84c02601d930ef6507853938f68724b77c700ed107c539c')], selection: ['u'] },
    { name: 'tx-avalanche', plugin: 'transaction', nodes: [T('t', 'avalanche_c', '0x2324d247a34b70d9a75c84b3023bdaf52de1b21fcd196a75f25eb0582d1269f3')], selection: ['t'] },
    { name: 'tx-optimism', plugin: 'transaction', nodes: [T('t', 'optimism', '0x9f769bd2461b77ef125937570d96a3f1c4cd7294b28b6b9e892f0c1b45fc6178')], selection: ['t'] },
    { name: 'tx-bsc', plugin: 'transaction', nodes: [T('t', 'bsc', '0xd7dac5740179cb5913d83786e57879423c63b0b9e837d1a13f2255e77d1cee64')], selection: ['t'] },
    { name: 'tx-etc', plugin: 'transaction', nodes: [T('t', 'ethereum_classic', '0xa57574ced6127af3abdd51f6414cdb7ecd3e6b80ccc772975d4e3c524ece7059')], selection: ['t'] },
    { name: 'tx-tron', plugin: 'transaction', nodes: [T('t', 'tron', 'f567b655e52c924b9b8ef1c7faeda4a2b8de7ac6310f1205c7143e9a0265cec0')], selection: ['t'] },
    { name: 'tx-tron-tronscan', plugin: 'transaction', block: ['trongrid.io'], nodes: [T('t', 'tron', 'f567b655e52c924b9b8ef1c7faeda4a2b8de7ac6310f1205c7143e9a0265cec0')], selection: ['t'] },
    { name: 'tx-solana', plugin: 'transaction', nodes: [T('t', 'solana', 'Ghfsp4gUgCQYLp7L3G2pE7Sk9WXiHWNTVibh2SwRNmjNpbm5p6C3T1zUndDUiNGTRcGXQxpgyEsi4xmqwiUHdWL')], selection: ['t'] },
    { name: 'tx-xrpl', plugin: 'transaction', nodes: [T('t', 'xrpl', 'F7238057FBB9AC698F2E69A11BBC3ADE5A1E131796CDE7AED1A8412DD7EC36FB')], selection: ['t'] },
    { name: 'tx-xrpl-ws', plugin: 'transaction', block: ['xrplcluster.com'], nodes: [T('t', 'xrpl', '8640FDDC85E543F691485936618C8E38BFF271A7A64FB88804C71112DB52E5EB')], selection: ['t'] },
    { name: 'tx-ton', plugin: 'transaction', nodes: [T('t', 'ton', '3612eb6ef718ba8ef55613a48dac7f5927c069ff47e0e416455bca61ee119611')], selection: ['t'] },
    // ---- Activation and First Funder --------------------------------------------------------
    {
        name: 'funder',
        plugin: 'first_funder',
        nodes: [A('tron', 'tron', 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi'), A('xrpl', 'xrpl', 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w'), A('tron-new', 'tron', 'TJmn8YEPzdZLZAwENUNCqKd9y345KbQnSm'), A('eth', 'ethereum', VITALIK)],
        selection: ['tron', 'xrpl', 'tron-new', 'eth'],
    },
    // ---- Contract and Token -----------------------------------------------------------------
    {
        name: 'contract',
        plugin: 'contract_token',
        nodes: [
            A('usdt', 'ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7'),
            A('vitalik', 'ethereum', VITALIK),
            A('avax-usdc', 'avalanche_c', '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7'),
            A('op', 'optimism', '0x4200000000000000000000000000000000000042'),
            A('bsc-usdt', 'bsc', '0x55d398326f99059ff775485246999027b3197955'),
            A('etc-wetc', 'ethereum_classic', '0x1953cab0e5bfa6d4a9bad6e05fd46c1cc6527a5a'),
            A('tron-usdt', 'tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
            A('tron-eoa', 'tron', 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi'),
            A('sol-usdc', 'solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
            A('sol-wallet', 'solana', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'),
            A('btc', 'bitcoin', '1XPTgDRhN8RFnzniWCddobD9iKZatrvH4'),
        ],
        selection: ['usdt', 'vitalik', 'avax-usdc', 'op', 'bsc-usdt', 'etc-wetc', 'tron-usdt', 'tron-eoa', 'sol-usdc', 'sol-wallet', 'btc'],
    },
    { name: 'contract-blockscout-deployer', plugin: 'contract_token', block: ['routescan.io'], nodes: [A('usdt', 'ethereum', '0xdac17f958d2ee523a2206206994597c13d831ec7')], selection: ['usdt'] },
    // ---- Public Labels ----------------------------------------------------------------------
    {
        name: 'labels',
        plugin: 'public_labels',
        nodes: [A('tron', 'tron', 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi'), A('eth', 'ethereum', VITALIK), A('xrpl', 'xrpl', 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w'), A('etc', 'ethereum_classic', '0x9eab4b0fc468a7f5d46228bf5a76cb52370d068d'), A('btc', 'bitcoin', '1XPTgDRhN8RFnzniWCddobD9iKZatrvH4')],
        selection: ['tron', 'eth', 'xrpl', 'etc', 'btc'],
    },
    // ---- Stablecoin Freeze Status -----------------------------------------------------------
    {
        name: 'freeze',
        plugin: 'freeze_status',
        nodes: [
            A('usdt-frozen', 'ethereum', '0x5227f603c1ee34ce3c06efe6477003bdfccb2f8c'),
            A('usdc-frozen', 'ethereum', '0x15f9c7149dae4d04e66e031f4cab8cb358a86909'),
            A('clean', 'ethereum', VITALIK, { frozen_by_issuer: 'USDT (Tether)' }),
            A('tron-frozen', 'tron', 'TACcFecYGH2sfsSJcjoYcXCdZFebv2ZKyi'),
            A('tron-clean', 'tron', 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi'),
            A('bsc', 'bsc', VITALIK),
        ],
        selection: ['usdt-frozen', 'usdc-frozen', 'clean', 'tron-frozen', 'tron-clean', 'bsc'],
    },
];
