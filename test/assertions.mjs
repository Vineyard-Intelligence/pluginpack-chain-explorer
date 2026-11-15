// What each member must write from the recorded answers, and the link and identity rules of the
// Cryptocurrency type pack it must keep. Called by test-plugin.mjs with the replay helper.

const SENT = 'sent to';

export default async function assertions({ replay, results, check }) {
    const R = results;
    const links = (r, label) => r.graph.live.filter((e) => e.label === label);
    const upd = (r, id) => Object.assign({}, ...r.graph.updates.filter((u) => u.id === id).map((u) => u.data));

    // ---- Identify Crypto Network -----------------------------------------------------------
    {
        const r = R['identify-mixed'];
        const from = (id) => r.graph.live.filter((e) => e.from_node_id === id);
        const evm = from('evm1');
        check('identify: an active 0x address gets one node per EVM chain it is active on', evm.length === 8 && evm.every((e) => e.label === 'same address on'));
        check('identify: those nodes are lower case', evm.every((e) => r.graph.nodes.get(e.to_node_id).data.address === '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'));
        check('identify: a balance alone sets no address_kind (Avalanche: no nonce, no code)', r.byAddr('avalanche_c', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045')?.data.address_kind === undefined);
        check('identify: a 7702 delegation on Ethereum is an eoa', r.byAddr('ethereum', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045')?.data.address_kind === 'eoa');
        const legacy = from('unk-legacy').map((e) => r.graph.nodes.get(e.to_node_id).data);
        check('identify: 1… active on Bitcoin and Bitcoin Cash becomes two nodes, BCH in CashAddr', legacy.length === 2 && legacy.some((d) => d.network === 'bitcoin') && legacy.some((d) => d.network === 'bitcoin_cash' && d.address === 'qqzm7w36af3ntgu5ns9r28ln4l963p8py5qs3geee5'));
        check('identify: Bitcoin SV, with no keyless source, gets no node', !r.nodes.some((n) => n.data.network === 'bitcoin_sv'));
        check('identify: TRON hex is written in Base58', !!r.byAddr('tron', 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi') && from('unk-tronhex').length === 1);
        check('identify: raw TON active on toncenter is a ton node, lower case', !!r.byAddr('ton', '0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8'));
        const lb = from('legacy-btc');
        const lbNode = lb[0] && r.graph.nodes.get(lb[0].to_node_id).data;
        check('identify: a legacy Financial node links `same as` and is settled by its currency', lb.length === 1 && lb[0].label === 'same as' && lbNode.network === 'bitcoin' && /currency is btc/.test(lb[0].data.basis));
        check('identify: its owner label and BTC balance move to the new node', lbNode?.public_label === 'Example P2SH' && lbNode?.balance === '0.5');
        check('identify: a payment tracking ID links `same as` on its network', from('pay-ltc').length === 1 && from('pay-ltc')[0].label === 'same as' && !!r.byAddr('litecoin', 'LKcKHmHMYA9n5htDNAAcngSmmgXg8LGpBB'));
        check('identify: a non-payment tracking ID is left out', from('pay-other').length === 0);
        check('identify: every link says why', r.graph.live.every((e) => typeof e.data.basis === 'string' && e.data.basis.length > 10));
        check('identify: the original nodes are never changed', r.graph.updates.length === 0);

        const s = R['identify-sweep'];
        check('identify sweep: an established Litecoin 3… is rewritten M…, `same as`', s.graph.live.some((e) => e.from_node_id === 'ltc-p2sh' && e.label === 'same as') && !!s.byAddr('litecoin', 'MQMHBtvnBfxTzt3K2bdxgSE7qZPHSXWsGM'));
        check('identify sweep: a node already linked `same address on` is left alone', !s.graph.live.some((e) => e.from_node_id === 'done' && e.id !== 'e1'));
        check('identify sweep: an EVM address with no sent transaction, balance or code is undecided, not written', !s.graph.live.some((e) => e.from_node_id === 'evm-fresh') && /could not be decided/.test(s.summary));
    }

    // ---- Identify: a network whose source did not answer -------------------------------------
    {
        const refuse = (hosts, body = '{}', status = 429) => (fetch) => async (url, init) =>
            hosts.some((h) => url.includes(h)) ? { ok: status < 300, status, headers: {}, text: async () => body } : fetch(url, init);
        const legacyOnly = R['identify-mixed'].s.nodes.filter((n) => n.id === 'unk-legacy');
        // mempool.space and blockstream.info refuse: Bitcoin is not asked, Bitcoin Cash answers.
        const one = await replay('identify-mixed', { nodes: legacyOnly, selection: [], wrap: refuse(['mempool.space', 'blockstream.info']) });
        check('identify: a node with an unanswered network gets no link, not a partial decision', one.graph.live.length === 0 && /not decided this run.*: Bitcoin not checked \(mempool\.space: refused.*\); activity on Bitcoin Cash/.test(one.summary));
        // The next sweep takes it again and decides both networks.
        const two = await replay('identify-mixed', { nodes: [...one.nodes], edges: one.graph.live, selection: [] });
        const nets = two.graph.live.filter((e) => e.from_node_id === 'unk-legacy').map((e) => two.graph.nodes.get(e.to_node_id).data.network).sort().join();
        check('identify: the next sweep asks again and decides every network', nets === 'bitcoin,bitcoin_cash');

        // One PublicNode endpoint throttled: only that chain goes unasked (1.0.0 shared one vendor
        // id, so Arbitrum, OP, Base and Avalanche were refused without a request).
        const evm = R['identify-mixed'].s.nodes.filter((n) => n.id === 'evm1');
        const p429 = await replay('identify-mixed', { nodes: evm, selection: ['evm1'], wrap: refuse(['polygon-bor-rpc.publicnode.com']) });
        check('identify: a 429 from one PublicNode endpoint leaves the other chains asked', /e\.g\. 0x[0-9a-fA-F]{40}: Polygon PoS not checked \(/.test(p429.summary) && /arbitrum-one-rpc\.publicnode\.com 1/.test(p429.summary) && p429.graph.live.length === 0);
        // A JSON-RPC rate limit arrives as HTTP 200 with an error per call: not "no activity".
        const rpcErr = JSON.stringify([1, 2, 3].map((id) => ({ jsonrpc: '2.0', id, error: { code: -32005, message: 'rate limit exceeded' } })));
        const pErr = await replay('identify-mixed', { nodes: evm, selection: ['evm1'], wrap: refuse(['polygon-bor-rpc.publicnode.com'], rpcErr, 200) });
        check('identify: an RPC that answers every call with an error did not answer', /Polygon PoS not checked/.test(pErr.summary) && pErr.graph.live.length === 0);

        // A legacy `eth` balance names no single ETH network: it is not copied to each of them.
        const legEth = [{ id: 'leg-eth', type: 'financial.crypto_address', data: { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', currency: 'eth', balance: 12.5 } }];
        const le = await replay('identify-mixed', { nodes: legEth, selection: ['leg-eth'] });
        const leNodes = le.graph.live.filter((e) => e.from_node_id === 'leg-eth').map((e) => le.graph.nodes.get(e.to_node_id).data);
        check('identify: a legacy eth balance is not copied onto several ETH networks', leNodes.length > 1 && leNodes.every((d) => d.balance === undefined));

        // Checksummed, upper-case and prefixed spellings on their network are one node to the app.
        const spell = [
            { id: 'cs', type: 'cryptocurrency.crypto_address', data: { network: 'ethereum', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' } },
            { id: 'up', type: 'cryptocurrency.crypto_address', data: { network: 'bitcoin', address: 'BC1QQ2MVRP4G3UGD424DW4XV53RGSF8SZKRV853JRC' } },
            { id: 'pre', type: 'cryptocurrency.crypto_address', data: { network: 'bitcoin_cash', address: 'bitcoincash:qzchaks7lhwcf7lfg3am7uqy8m2yjnywnccd424dcp' } },
        ];
        const sp = await replay('identify-sweep', { nodes: spell, edges: [], selection: [] });
        check('identify: a spelling the app folds is not rewritten over the original node', sp.graph.created.length === 0 && sp.graph.live.length === 0 && sp.graph.nodes.get('cs').data.address === spell[0].data.address && !/rewritten/.test(sp.summary));

        // "Most nodes per run": unreadable values do not fill it, a selection is not cut by it, and
        // a sweep whose taken nodes stay undecided says that running again repeats them.
        const junk = Array.from({ length: 5 }, (_, i) => ({ id: `junk${i}`, type: 'cryptocurrency.crypto_address', data: { network: 'unknown', address: `not-an-address-${i}` } }));
        const bc = (id) => ({ id, type: 'cryptocurrency.crypto_address', data: { network: 'unknown', address: 'bc1qq2mvrp4g3ugd424dw4xv53rgsf8szkrv853jrc' } });
        const cap = await replay('identify-sweep', { nodes: [...junk, bc('real')], edges: [], selection: [], params: { max_nodes: 5 } });
        check('identify: unreadable values do not take the sweep cap', cap.graph.live.some((e) => e.from_node_id === 'real'));
        const many = Array.from({ length: 7 }, (_, i) => bc(`sel${i}`));
        const sel = await replay('identify-sweep', { nodes: many, edges: [], selection: many.map((n) => n.id), params: { max_nodes: 5 } });
        check('identify: an explicit selection is not cut at "Most nodes per run"', sel.graph.live.length === 7 && !/Most nodes per run/.test(sel.summary));
        const empty = JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x0' }, { jsonrpc: '2.0', id: 2, result: '0x0' }, { jsonrpc: '2.0', id: 3, result: '0x' }]);
        const fresh = Array.from({ length: 3 }, (_, i) => ({ id: `fresh${i}`, type: 'cryptocurrency.crypto_address', data: { network: 'evm', address: '0x' + String(i + 1).padStart(40, '0') } }));
        const stuck = await replay('identify-sweep', { nodes: fresh, edges: [], selection: [], params: { max_nodes: 2 }, wrap: () => async () => ({ ok: true, status: 200, headers: {}, text: async () => empty }) });
        check('identify: a sweep that stays undecided does not say "run again"', /raise "Most nodes per run"/.test(stuck.summary) && !/— run again/.test(stuck.summary));
    }

    // ---- Crypto Address History --------------------------------------------------------------
    for (const [name, key] of [
        ['history-ethereum', 'summary_routescan'],
        ['history-ethereum-blockscout', 'summary_blockscout'],
        ['history-avalanche', 'summary_routescan'],
        ['history-optimism', 'summary_blockscout'],
        ['history-bsc', 'summary_binplorer'],
        ['history-etc', 'summary_blockscout'],
        ['history-tron', 'summary_trongrid'],
        ['history-tron-tronscan', 'summary_tronscan'],
        ['history-solana', 'summary_publicnode'],
        ['history-xrpl', 'summary_xrplcluster'],
        ['history-xrpl-memo', 'summary_xrpl_ws'],
        ['history-ton', 'summary_toncenter'],
    ]) {
        const r = R[name];
        const sent = links(r, SENT);
        check(`${name}: links are 'sent to' with ${key} and the window`, sent.length > 0 && sent.every((e) => e.data[key]?.window_to && e.data[key]?.assets?.length && typeof e.data[key].complete === 'boolean'));
        check(`${name}: every link touches the seed and names its network`, sent.every((e) => (e.from_node_id === 's' || e.to_node_id === 's') && e.data.network === r.s.nodes[0].data.network));
        check(`${name}: recent holds at most 20 rows, newest first`, sent.every((e) => Array.isArray(e.data.recent) && e.data.recent.length <= 20 && e.data.recent.every((x, i, a) => i === 0 || (a[i - 1].time ?? '') >= (x.time ?? ''))));
        const d = upd(r, 's');
        check(`${name}: the seed gets history_examined and history_complete`, Number.isInteger(d.history_examined) && typeof d.history_complete === 'boolean');
        check(`${name}: amounts are decimal strings`, sent.every((e) => e.data[key].assets.every((a) => typeof a.total === 'string' && /^\d+(\.\d+)?$/.test(a.total))));
    }
    {
        const b = R['history-bsc'];
        const s = links(b, SENT)[0]?.data.summary_binplorer;
        check('history bsc: never complete, window no older than 30 days', s?.complete === false && Date.parse(s.window_from) >= Date.parse(s.window_to) - 31 * 86400_000);
        check('history solana: PublicNode keeps recent history only, so it is never complete', upd(R['history-solana'], 's').history_complete === false && !('first_seen' in upd(R['history-solana'], 's')));
        check('history solana: a lamport balance past 2^53 stays exact', upd(R['history-solana'], 's').balance === '9300003.251652038');
        check('history solana: the foundation node refused once, then PublicNode served', /api\.mainnet-beta\.solana\.com 1/.test(R['history-solana'].summary));
        const memo = R['history-xrpl-memo'];
        check('history xrpl memo: a tagged seed sees only payments to its tag, all incoming', links(memo, SENT).every((e) => e.to_node_id === 's'));
        // The account's balance and activity are not one tag's: 1.0.0 wrote an exchange hot
        // wallet's XRP balance and newest transaction onto a customer's deposit tag.
        const md = upd(memo, 's');
        const tagLast = links(memo, SENT).flatMap((e) => e.data.summary_xrpl_ws.assets.map((a) => a.last)).sort().pop();
        check('history xrpl memo: no account balance on a tag node, and last_seen is its own last payment', !('balance' in md) && !('balance_source' in md) && md.last_seen === tagLast);
        // In the recording the account's newest transaction happens to be a payment to tag 1, so a
        // newer payment out of the account is laid in front of it: it is the account's, not the tag's.
        const later = (fetch) => async (url, init) => {
            const res = await fetch(url, init);
            if (!String(init?.body).includes('"account_tx"')) return res;
            const body = JSON.parse(await res.text());
            body.result.transactions.unshift({
                meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '1000000' },
                tx: { Account: 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w', Destination: 'rNbw4ZiGZHhqo22SERYmGqTKdvEV5CjuV8', TransactionType: 'Payment', date: 841536000, hash: 'AB'.repeat(32), ledger_index: 106600000 },
                validated: true,
            });
            const text = JSON.stringify(body);
            return { ...res, text: async () => text };
        };
        const ml = upd(await replay('history-xrpl-memo', { wrap: later }), 's');
        check('history xrpl memo: the account\'s newer activity is not the tag\'s last_seen', ml.last_seen === tagLast && ml.last_seen < '2026-09-01T00:00:00Z');
        const tonMemo = await replay('history-skips', { nodes: [{ id: 'tm', type: 'cryptocurrency.crypto_address', data: { network: 'ton', address: '0:4d7d028d55ce9db037c0dfab4020a0ab274dc3ff570d4e20d39bbf49efe3df8b', memo: 'deposit 7' } }], selection: ['tm'] });
        check('history: a memo node off the XRP Ledger is skipped, not given the account\'s history', /only XRP Ledger payments/.test(tonMemo.summary) && !tonMemo.graph.updates.length && !tonMemo.missing.length);
        // activated_at is First Funder's (the activation's block); create_time is the block before.
        check('history tron: activated_at is left to First Funder', !('activated_at' in upd(R['history-tron'], 's')));
        check('history skips: no keyless source, evm, an invalid address and Monero are each skipped with the reason', /Polygon PoS history/.test(R['history-skips'].summary) && /not established yet/.test(R['history-skips'].summary) && /not one Bitcoin accepts/.test(R['history-skips'].summary) && /Monero/.test(R['history-skips'].summary));
    }
    for (const name of ['history-bitcoin', 'history-litecoin', 'history-litecoin-sochain', 'history-litecoin-blockcypher', 'history-bitcoin-cash', 'history-dogecoin', 'history-dash', 'history-dash-insight', 'history-zcash']) {
        const r = R[name];
        const ins = links(r, 'input to');
        const outs = links(r, 'output to');
        check(`${name}: the Bitcoin family writes transactions linked 'input to' / 'output to'`, ins.length + outs.length > 0 && !links(r, SENT).length);
        check(`${name}: each link's amount is the sum of its inputs or outputs`, [...ins, ...outs].every((e) => {
            const parts = e.data.inputs ?? e.data.outputs;
            const sum = parts.reduce((a, p) => a + BigInt(p.amount.replace('.', '').padEnd(p.amount.includes('.') ? p.amount.indexOf('.') + 8 : p.amount.length + 8, '0')), 0n);
            const tot = e.data.amount;
            const want = BigInt(tot.replace('.', '').padEnd(tot.includes('.') ? tot.indexOf('.') + 8 : tot.length + 8, '0'));
            return sum === want;
        }));
        check(`${name}: the seed is on every transaction the history wrote`, r.nodes.filter((n) => n.type === 'cryptocurrency.crypto_transaction').every((t) => r.graph.live.some((e) => (e.from_node_id === 's' && e.to_node_id === t.id) || (e.from_node_id === t.id && e.to_node_id === 's'))));
    }
    check('history dash (insight): a fully read history writes first_seen and history_complete', upd(R['history-dash-insight'], 's').history_complete === true && !!upd(R['history-dash-insight'], 's').first_seen);
    check('history: each fallback names the vendor that failed', /mempool\.space: no answer/.test(R['history-bitcoin'].summary) && /litecoinspace\.org: refused/.test(R['history-litecoin-sochain'].summary) && /SoChain: refused/.test(R['history-litecoin-blockcypher'].summary));

    // An existing link between the seed and a counterparty: amended, never relabelled, and its
    // recent list left alone when an older app does not show link data.
    {
        const first = await replay('history-ethereum');
        const pair = links(first, SENT)[0];
        const other = pair.from_node_id === 's' ? pair.to_node_id : pair.from_node_id;
        const otherNode = first.graph.nodes.get(other);
        const nodes = [...first.s.nodes, { id: 'cp', type: otherNode.type, data: { ...otherNode.data } }];
        const from = pair.from_node_id === 's' ? 's' : 'cp';
        const to = from === 's' ? 'cp' : 's';
        const edges = [{ id: 'mine', from_node_id: from, to_node_id: to, label: 'controlled by', data: { recent: [{ tx_hash: '0xold', asset: 'native', amount: '9', time: '2020-01-01T00:00:00Z' }] } }];
        const r = await replay('history-ethereum', { nodes, edges, edgeData: false });
        const e = r.graph.live.find((x) => x.id === 'mine');
        check('history: an existing link keeps its label', e.label === 'controlled by' && !r.graph.errors.length);
        check('history: the existing link gets this source’s summary key', !!e.data.summary_routescan);
        check('history: its recent list is left alone when an older app hides link data', e.data.recent.length === 1 && e.data.recent[0].tx_hash === '0xold' && /kept their recent list/.test(r.summary));
        check('history: …and the summary says why without blaming the app as it is now', /their data was not passed to this run \(an older Vineyard does not pass a link's data to plugins\)/.test(r.summary) && !/the app does not show a plugin/.test(r.summary));
        const r2 = await replay('history-ethereum', { nodes, edges });
        const e2 = r2.graph.live.find((x) => x.id === 'mine');
        check('history: a visible recent list is merged by hash, not replaced', e2.data.recent.some((x) => x.tx_hash === '0xold') && e2.data.recent.length > 1 && !/kept their recent list/.test(r2.summary));
    }

    // A re-run over what an earlier run drew: every link is amended by id, none drawn again, and a
    // row the earlier run's list held that this run did not read (an older transfer) is kept.
    {
        const first = await replay('history-ethereum');
        const drawn = links(first, SENT);
        check('re-run: the first run drew sent to links', drawn.length >= 2);
        const old = { tx_hash: '0x' + '0e'.repeat(32), asset: 'native', amount: '1', time: '2019-01-01T00:00:00Z' };
        const live = first.graph.live.map((e) => (e.id === drawn[0].id ? { ...e, data: { ...e.data, recent: [...e.data.recent, old] } } : e));
        const r = await replay('history-ethereum', { nodes: [...first.graph.nodes.values()], edges: live });
        check('re-run: no error, nothing drawn twice, no new node', !r.error && !r.graph.errors.length && r.graph.edgeCreates.length === 0 && r.graph.created.length === 0);
        check('re-run: every link the first run drew is amended by id', drawn.every((d) => r.graph.edgeUpdates.some((u) => u.id === d.id)));
        const again = r.graph.live.find((x) => x.id === drawn[0].id);
        check("re-run: the link's recent list keeps the row it held beside this run's", again.data.recent.some((x) => x.tx_hash === old.tx_hash) && again.data.recent.length === drawn[0].data.recent.length + 1);
        check('re-run: nothing said about kept lists', !/kept their recent list/.test(r.summary));
    }

    // ---- Crypto Transaction ------------------------------------------------------------------
    {
        const p = R['tx-bitcoin'];
        const tnode = upd(p, 't');
        check('tx bitcoin: the pizza transaction is block 57043 with a 0.99 BTC fee', tnode.block_height === 57043 && tnode.fee === '0.99');
        const inn = links(p, 'input to')[0];
        const out = links(p, 'output to')[0];
        check('tx bitcoin: Laszlo paid in 10000.99 BTC over his inputs, 10000 went out', inn?.data.amount === '10000.99' && out?.data.amount === '10000' && inn.data.inputs.every((i) => /^[0-9a-f]{64}$/.test(i.prev_txid)));
        for (const name of ['tx-litecoin', 'tx-litecoin-sochain', 'tx-litecoin-blockcypher']) {
            const r = R[name];
            check(`${name}: three inputs, one output, the same from every source`, links(r, 'input to').length === 3 && links(r, 'output to').length === 1 && links(r, 'output to')[0].data.amount === '0.42651056');
        }
        check('tx bitcoin cash: other parties beyond the cap are left out and said so', links(R['tx-bitcoin-cash'], 'output to').length <= 5 && /not linked/.test(R['tx-bitcoin-cash'].summary));
        check('tx dash: BlockCypher and Insight agree', links(R['tx-dash'], 'output to').length === links(R['tx-dash-insight'], 'output to').length && links(R['tx-dash'], 'input to').length === links(R['tx-dash-insight'], 'input to').length);

        const e = R['tx-ethereum'];
        const banana = links(e, 'input to').map((x) => x.data).find((d) => d.asset === '0x50b674d9521a4f5a59b8ea9c0f70e152bd1ef8b8');
        check('tx ethereum: token decimals come from the token itself when the logs do not say', banana && !banana.base_units && /\./.test(banana.amount) && banana.symbol === 'BANANA');
        check('tx ethereum: a message to an EOA is a transfer, not a contract call', upd(e, 't').tx_kind === 'transfer' && upd(e, 'u').tx_kind === 'contract_call');
        const bs = R['tx-ethereum-blockscout'];
        // Blockscout also lists WETH deposit and withdrawal events as transfers, which Transfer logs
        // do not carry, so the WETH legs differ; the ETH and BANANA legs must not.
        const legs = (r) => links(r, 'output to').filter((x) => x.from_node_id === 'u').flatMap((x) => (x.data.assets ?? [x.data]).filter((a) => a.asset !== '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2').map((a) => `${a.asset}:${a.amount}`)).sort().join();
        check('tx ethereum: Routescan and Blockscout give the same ETH and token legs', legs(bs) === legs(e) && legs(e).length > 0);
        check('tx tron: the TRC-20 transfer reads 5.1 USDT from both sources', [R['tx-tron'], R['tx-tron-tronscan']].every((r) => links(r, 'output to')[0]?.data.amount === '5.1' && links(r, 'output to')[0].data.symbol === 'USDT'));
        check('tx tron: the fee is 0.345 TRX from both sources', upd(R['tx-tron'], 't').fee === '0.345' && upd(R['tx-tron-tronscan'], 't').fee === '0.345');
        check('tx xrpl: a destination tag makes the receiver its own node', links(R['tx-xrpl'], 'output to').some((x) => R['tx-xrpl'].graph.nodes.get(x.to_node_id).data.memo === '1'));
        check('tx ton: no account is called a signer', !links(R['tx-ton'], 'input to').some((x) => x.data.role === 'signer'));
        check('tx solana: a slot is not written as a block height', upd(R['tx-solana'], 't').block_height === undefined && Number.isInteger(upd(R['tx-solana'], 't').slot));
        check('tx bsc: the fee comes from gas used and price', /^\d+\.\d+$/.test(upd(R['tx-bsc'], 't').fee ?? ''));
    }

    // ---- Activation and First Funder --------------------------------------------------------
    {
        const r = R['funder'];
        check('funder tron: the activation transfer names TAUN6F… (X-26 rule)', upd(r, 'tron').first_funder === 'TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX' && upd(r, 'tron').activated_at === '2021-08-20T09:40:54Z');
        check('funder xrpl: XRPSCAN parent and inception', upd(r, 'xrpl').first_funder === 'rNbw4ZiGZHhqo22SERYmGqTKdvEV5CjuV8' && upd(r, 'xrpl').activated_at === '2019-02-21T01:31:21Z');
        check('funder: first_funding sits on the funder\'s sent to link', links(r, SENT).length === 2 && links(r, SENT).every((e) => e.data.first_funding?.tx_hash && e.data.first_funding.source));
        check('funder: an address never activated gets nothing', !r.graph.updates.some((u) => u.id === 'tron-new') && /not activated/.test(r.summary));
        check('funder: EVM is skipped, naming no unlisted pack', /EVM first funders need a keyed source/.test(r.summary) && !/Blockscout PRO|Helius|Etherscan/.test(r.summary));
        // A destination tag behind an exchange account: the account's activator never paid it.
        const tag = await replay('funder', { nodes: [{ id: 'tag', type: 'cryptocurrency.crypto_address', data: { network: 'xrpl', address: 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w', memo: '12345' } }], selection: ['tag'] });
        check('funder: a node with a memo is skipped, no funder and no link written', !tag.graph.updates.length && !tag.graph.live.length && /no activation of its own/.test(tag.summary));
    }

    // ---- Contract and Token -----------------------------------------------------------------
    {
        const r = R['contract'];
        check('contract: USDT is a contract with its deployer and creation tx (Routescan)', upd(r, 'usdt').address_kind === 'contract' && upd(r, 'usdt').deployer === '0x36928500bc1dcd7af6a2b4008875cc336b927d57');
        check('contract: a 7702-delegated wallet stays an eoa', upd(r, 'vitalik').address_kind === 'eoa' && !!upd(r, 'vitalik').eip7702_delegate);
        check('contract: OP Mainnet deployer from Blockscout', upd(r, 'op').deployer === '0xcde47c1a5e2d60b9ff262b0a3b6d486048575ad9');
        check('contract: no deployer where no keyless source has one (BSC)', !upd(r, 'bsc-usdt').deployer && /not read on BNB Smart Chain/.test(r.summary));
        const tokens = r.nodes.filter((n) => n.type === 'cryptocurrency.crypto_token');
        check('contract: tokens with standard, symbol and decimals, linked token contract', tokens.length === 7 && links(r, 'token contract').length === 7 && tokens.some((t) => t.data.standard === 'trc20' && t.data.decimals === 6) && tokens.some((t) => t.data.standard === 'spl'));
        check('contract: deployers are linked `deployed`', links(r, 'deployed').length === 4);
        check('contract: TRON USDT deployed by THPvaU…', upd(r, 'tron-usdt').deployer === 'THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC' && upd(r, 'tron-eoa').address_kind === 'eoa');
        check('contract: Blockscout serves the deployer when Routescan does not', upd(R['contract-blockscout-deployer'], 'usdt').deployer === '0x36928500bc1dcd7af6a2b4008875cc336b927d57');
        // The deployer already paid the contract: the link gets `deployment`, its label stays.
        const nodes = [...r.s.nodes.filter((n) => n.id === 'usdt'), { id: 'dep', type: 'cryptocurrency.crypto_address', data: { network: 'ethereum', address: '0x36928500bc1dcd7af6a2b4008875cc336b927d57' } }];
        const again = await replay('contract', { nodes, selection: ['usdt'], edges: [{ id: 'paid', from_node_id: 'dep', to_node_id: 'usdt', label: 'sent to', data: {} }] });
        const e = again.graph.live.find((x) => x.id === 'paid');
        check('contract: an existing pair is amended with deployment, not relabelled deployed', e.label === 'sent to' && !!e.data.deployment && !again.graph.errors.length);
    }

    // ---- A project whose type pack refuses a value -------------------------------------------
    {
        // An older Cryptocurrency type pack without a network this pack writes: the host refuses
        // the create (validate-node.ts wording). The run must go on and say what to update, not
        // throw away what it staged for the other nodes.
        const refuse = (type, data) => (type === 'cryptocurrency.crypto_address' && data.network === 'ton' ? `cryptocurrency.crypto_address: network must be one of "bitcoin", "ethereum" — got "ton"` : null);
        const r = await replay('identify-mixed', { refuse });
        check('refused write: the run does not throw', !r.error);
        check('refused write: the other nodes are still written', r.graph.live.filter((e) => e.from_node_id === 'evm1').length === 8);
        check('refused write: the summary says to update the type pack', /update the Cryptocurrency type pack/.test(r.summary));
    }

    // ---- Public Labels and Freeze Status -----------------------------------------------------
    {
        const r = R['labels'];
        check('labels: Tronscan public tag', upd(r, 'tron').public_label === 'Binance-Hot 2' && upd(r, 'tron').label_source === 'Tronscan');
        check('labels: Blockscout name tag from the list rows when the address object has none', upd(r, 'eth').public_label === 'Vitalik Buterin');
        check('labels: XRPSCAN verified name', upd(r, 'xrpl').public_label === 'Coinbase' && upd(r, 'xrpl').label_source === 'XRPSCAN (verified)');
        const z = R['freeze'];
        check('freeze: USDT and USDC freezes on Ethereum, USDT on TRON', upd(z, 'usdt-frozen').frozen_by_issuer?.includes('USDT (Tether)') && upd(z, 'usdc-frozen').frozen_by_issuer === 'USDC (Circle)' && upd(z, 'tron-frozen').frozen_by_issuer === 'USDT (Tether)');
        check('freeze: a clean address gets frozen_checked_at only', Object.keys(upd(z, 'tron-clean')).join() === 'frozen_checked_at');
        check('freeze: a stale frozen_by_issuer is pointed out, not cleared', /no longer frozen/.test(z.summary) && !('frozen_by_issuer' in upd(z, 'clean')));
    }
}
