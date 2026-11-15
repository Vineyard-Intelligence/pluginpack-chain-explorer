// Unit tests for the pure modules: encodings (src/codec.ts), address formats (src/formats.ts), value
// conversions and the exact JSON reader (src/values.ts, src/http.ts), the per-pair flow window
// (src/flows.ts), and the pure readers of vendor answers. No network, no host.
//   Run: node test/pure.test.mjs
//
// The modules are bundled to a temp directory with the same pinned esbuild the pack uses, because
// they are TypeScript and this runs on plain Node. Address vectors come from the vendors' own answers
// (TronGrid's hex, Haskoin's CashAddr, toncenter's user-friendly form) or were computed with an
// independent Python implementation of the format (the Litecoin M… and XRPL X-address vectors).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'chain-explorer-pure-'));
const load = async (path) => {
    const out = join(dir, `${path.replace(/\W/g, '_')}.mjs`);
    execFileSync('npx', ['--yes', 'esbuild@0.25.12', join(root, 'src', `${path}.ts`), '--bundle', '--format=esm', '--platform=neutral', '--log-level=warning', `--outfile=${out}`], { cwd: root });
    return import(pathToFileURL(out).href);
};
const codec = await load('codec');
const f = await load('formats');
const v = await load('values');
const http = await load('http');
const fl = await load('flows');
const tron = await load('vendors/tron');
const led = await load('vendors/ledgers');
const evm = await load('vendors/evm');
const utxo = await load('vendors/utxo');
const tx = await load('transaction');
const identify = await load('identify');

const ok = [];
const fail = [];
const check = (name, cond) => (cond ? ok : fail).push(name);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- codec ------------------------------------------------------------------------------------
for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(200)]) {
    const want = createHash('sha256').update(s).digest('hex');
    check(`sha256 of ${s.length} bytes matches node:crypto`, codec.bytesToHex(codec.sha256(new TextEncoder().encode(s))) === want);
}
check('crc16/xmodem of "123456789" is 0x31c3', codec.crc16(new TextEncoder().encode('123456789')) === 0x31c3);
check('base64url decodes', codec.bytesToHex(codec.base64Decode('_-8') ?? new Uint8Array()) === 'ffef');

// ---- formats: settled by format ---------------------------------------------------------------
const R = (s) => f.readAddress(s);
{
    const t = R('41d1c4bb7b2f39aba5707711719b2236b5b605af2e');
    check('TRON hex is written in Base58 (TronGrid gives this pair)', t.kind === 'settled' && t.network === 'tron' && t.address === 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi');
    check('TRON Base58 settles on tron', R('TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi').network === 'tron');
    check('TRON with a bad checksum is no TRON address', R('TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSj').kind !== 'settled' || R('TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSj').network !== 'tron');
    const b = R('LTC1QFACLLV7M4S2EQUY7993AZ05TZ3RX6ZHDHG5LFY');
    check('upper-case ltc1 is litecoin, written lower case', b.kind === 'settled' && b.network === 'litecoin' && b.address === 'ltc1qfacllv7m4s2equy7993az05tz3rx6zhdhg5lfy');
    const c = R('bitcoincash:qzchaks7lhwcf7lfg3am7uqy8m2yjnywnccd424dcp');
    check('prefixed CashAddr is bitcoin_cash without the prefix', c.network === 'bitcoin_cash' && c.address === 'qzchaks7lhwcf7lfg3am7uqy8m2yjnywnccd424dcp');
    check('bare CashAddr is bitcoin_cash', R('qzchaks7lhwcf7lfg3am7uqy8m2yjnywnccd424dcp').network === 'bitcoin_cash');
    check('an XRPL classic address is xrpl', R('rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w').network === 'xrpl');
    const x = R('XVYUQ3SdUcVnaTNVanDYo1NamrUukPJJSSBS7Zy65iKSxdV');
    check('an X-address splits into the classic address and its tag', x.network === 'xrpl' && x.address === 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w' && x.memo === '12345');
    const x0 = R('XVYUQ3SdUcVnaTNVanDYo1NamrUukPUPeoGMnmvkEExbtrj');
    check('an X-address without a tag has no memo', x0.address === 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w' && x0.memo === undefined);
    const ton = R('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N');
    check('TON user-friendly is written raw (toncenter answers for both)', ton.network === 'ton' && ton.address === '0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8');
    const tonRaw = R('0:83DFD552E63729B472FCBCC8C45EBCC6691702558B68EC7527E1BA403A0F31A8');
    check('raw TON is shared with other TVM chains: decided by activity, lower case', tonRaw.kind === 'shared' && tonRaw.candidates[0].address === '0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8');
    check('Dash X… is dash', R('XqPTFgWrZWV569zmiUQ4WATErsKuGkvxwk').network === 'dash');
    check('Zcash t1 is zcash', R('t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7').network === 'zcash');
    check('a Solana key is solana', R('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM').network === 'solana');
    check('garbage is unreadable', R('hello world').kind === 'unreadable');
}
// ---- formats: shared, decided by activity -----------------------------------------------------
{
    const l = R('1XPTgDRhN8RFnzniWCddobD9iKZatrvH4');
    check('1… is bitcoin, bitcoin_cash and bitcoin_sv', l.kind === 'shared' && eq(l.candidates.map((c) => c.network), ['bitcoin', 'bitcoin_cash', 'bitcoin_sv']));
    check('…with the Bitcoin Cash candidate in CashAddr (Haskoin gives this pair)', l.candidates[1].address === 'qqzm7w36af3ntgu5ns9r28ln4l963p8py5qs3geee5');
    const p = R('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy');
    check('3… adds Litecoin as M…', p.kind === 'shared' && p.candidates.find((c) => c.network === 'litecoin')?.address === 'MQMHBtvnBfxTzt3K2bdxgSE7qZPHSXWsGM');
    const d = R('DTVc1s63gmVbdp9KfTpAda34tAJaWiAfww');
    check('D… is dogecoin and verge', d.kind === 'shared' && eq(d.candidates.map((c) => c.network), ['dogecoin', 'verge']));
    const e = R('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    check('0x… is every EVM chain, written lower case', e.kind === 'shared' && e.candidates.length === 8 && e.candidates.every((c) => c.address === '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'));
}
// ---- formats: canonical on an established network ---------------------------------------------
{
    check('litecoin 3… is written M…', f.canonicalOn('litecoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')?.address === 'MQMHBtvnBfxTzt3K2bdxgSE7qZPHSXWsGM');
    check('bitcoin_cash legacy is written CashAddr', f.canonicalOn('bitcoin_cash', '1XPTgDRhN8RFnzniWCddobD9iKZatrvH4')?.address === 'qqzm7w36af3ntgu5ns9r28ln4l963p8py5qs3geee5');
    check('a TRON address is refused on bitcoin', f.canonicalOn('bitcoin', 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi') === null);
    check('an EVM checksum is folded', f.canonicalOn('ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7')?.address === '0xdac17f958d2ee523a2206206994597c13d831ec7');
    check('a mistyped Bitcoin address is refused', f.canonicalOn('bitcoin', '1XPTgDRhN8RFnzniWCddobD9iKZatrvH5') === null);
    check('script kinds: p2pkh, p2sh, p2wpkh', f.utxoKind('bitcoin', '1XPTgDRhN8RFnzniWCddobD9iKZatrvH4') === 'p2pkh' && f.utxoKind('bitcoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy') === 'p2sh' && f.utxoKind('bitcoin', 'bc1qq2mvrp4g3ugd424dw4xv53rgsf8szkrv853jrc') === 'p2wpkh');
}

// ---- values -----------------------------------------------------------------------------------
{
    check('formatUnits keeps precision past 2^53', v.formatUnits('1234567890123456789012', 18) === '1234.567890123456789012');
    check('formatUnits drops trailing zeros', v.formatUnits('1500000000000000000', 18) === '1.5' && v.formatUnits('100', 2) === '1');
    check('parseUnits reads coins to satoshi', v.parseUnits('0.42635996', 8) === '42635996' && v.parseUnits('1.00001000', 8) === '100001000');
    check('parseUnits takes an exact float and refuses an inexact one', v.parseUnits(1.00001, 8) === '100001000' && v.parseUnits(0.1 + 0.2, 8) === null);
    check('abiString reads a dynamic string', v.abiString('0x' + '20'.padStart(64, '0') + '4'.padStart(64, '0') + Buffer.from('USDT').toString('hex').padEnd(64, '0')) === 'USDT');
    check('abiString reads bytes32', v.abiString('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0')) === 'MKR');
    check('abiBool is strict', v.abiBool('0x' + '1'.padStart(64, '0')) === true && v.abiBool('0x' + '2'.padStart(64, '0')) === undefined);
    check('hexHash keeps each chain’s prefix convention', v.hexHash('ABCD'.repeat(16), true) === '0x' + 'abcd'.repeat(16) && v.hexHash('0x' + 'AB'.repeat(32), false) === 'ab'.repeat(32));
    const big = http.parseExact('{"value":9300003251652038,"n":[1,22222222222222222222.5,"33333333333333333333"],"s":"x\\"99999999999999999999"}');
    check('parseExact keeps a lamport balance past 2^53 exact', big.value === '9300003251652038');
    check('parseExact leaves fractions, short numbers and strings alone', big.n[0] === 1 && big.n[1] === 22222222222222222222.5 && big.n[2] === '33333333333333333333' && big.s === 'x"99999999999999999999');
}

// ---- flows: one window for every list ---------------------------------------------------------
{
    const S = '0xseed';
    const m = (order, from, to, asset = 'native', raw = '1') => ({ tx_hash: `0x${order}`, time: `2026-01-${String(order).padStart(2, '0')}T00:00:00Z`, order, from, to, asset, decimals: 0, raw });
    const feeds = [
        { name: 'transactions', rows: [m(20, S, '0xa'), m(10, S, '0xa'), m(5, S, '0xa')], complete: true, oldest: 5, examined: 3 },
        { name: 'token_transfers', rows: [m(18, '0xb', S, '0xt'), m(12, '0xb', S, '0xt')], complete: false, oldest: 12, examined: 2, oldestTime: '2026-01-12T00:00:00Z' },
    ];
    const r = fl.aggregate(S, feeds);
    check('rows below the deepest point every list covers are not counted', r.counted === 2 && r.beforeWindow === 3);
    check('the window starts where the incomplete list stops', r.window_from === '2026-01-12T00:00:00Z' && r.complete === false);
    const binplorer = fl.aggregate(S, [{ ...feeds[1], floorTime: '2025-12-15T00:00:00Z' }]);
    check('a vendor floor (Binplorer 30 days) is the window start', binplorer.window_from === '2025-12-15T00:00:00Z');
    const memo = fl.aggregate('rX', [{ name: 'payments', rows: [{ ...m(3, 'rX', 'rY'), to_memo: '7' }, { ...m(4, 'rZ', 'rX'), to_memo: '9' }], complete: true, oldest: 3, examined: 2 }]);
    check('a destination tag makes the receiver its own node; toward the seed it is the seed', memo.pairs.find((p) => p.to === 'rY')?.to_memo === '7' && memo.pairs.find((p) => p.to === 'rX')?.to_memo === undefined);
    check('recentFor writes this run’s rows only where no link exists', !!fl.recentFor(undefined, [{ tx_hash: 'a', asset: 'native', amount: '1' }]) && fl.recentFor({ id: 'e' }, []) === undefined);
    const merged = fl.recentFor({ data: { recent: [{ tx_hash: '0xold', asset: 'native', amount: '2', time: '2025-01-01T00:00:00Z' }] } }, [{ tx_hash: '0xnew', asset: 'native', amount: '1', time: '2026-01-01T00:00:00Z' }]);
    check('recentFor merges a visible list instead of replacing it', merged?.length === 2 && merged[0].tx_hash === '0xnew');
}

// ---- TRON activation rule (X-26) --------------------------------------------------------------
{
    const A = 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi';
    const row = (ts, type, value, txID = 'aa'.repeat(32)) => ({ txID, block_timestamp: ts, ret: [{ contractRet: 'SUCCESS' }], raw_data: { contract: [{ type, parameter: { value } }] } });
    const created = 1629452451000;
    const funder = '410583a68a3bcd86c25ab1bee482bac04a216b0261';
    const hit = tron.activationFrom([row(created + 3000, 'TransferContract', { owner_address: funder, to_address: '41d1c4bb7b2f39aba5707711719b2236b5b605af2e', amount: 19000000 })], A, created);
    check('the activation is the transfer in the block after create_time (measured pair)', hit?.funder === 'TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX' && hit?.raw === '19000000');
    check('a transfer AT create_time is not the activation', tron.activationFrom([row(created, 'TransferContract', { owner_address: funder, to_address: '41d1c4bb7b2f39aba5707711719b2236b5b605af2e', amount: 1 })], A, created) === null);
    check('the first incoming transfer far later is "could not tell", not the funder', tron.activationFrom([row(created + 60_000, 'TransferContract', { owner_address: funder, to_address: '41d1c4bb7b2f39aba5707711719b2236b5b605af2e', amount: 1 })], A, created) === null);
    check('a contract call in the activation block is not a funding', tron.activationFrom([row(created + 3000, 'TriggerSmartContract', { owner_address: funder, contract_address: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c' })], A, created) === null);
    const ac = tron.activationFrom([row(created + 3000, 'AccountCreateContract', { owner_address: funder, account_address: '41d1c4bb7b2f39aba5707711719b2236b5b605af2e' })], A, created);
    check('AccountCreateContract names the funder too', ac?.funder === 'TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX' && ac.kind === 'AccountCreateContract');
}

// ---- vendor readers ---------------------------------------------------------------------------
{
    check('iouRaw scales issued amounts to 15 places', led.iouRaw('1.5') === '1500000000000000' && led.iouRaw('1e-5') === '10000000000' && led.iouRaw('1e-20') === null);
    check('a hex XRPL currency code is read as text', led.currencyName('5553444300000000000000000000000000000000') === 'USDC');
    const partial = led.xrplMove(
        { TransactionType: 'Payment', Account: 'rHXgaJLpjDe4jsAiF8atNrRfS6eYrjPYPB', Destination: 'rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w', Amount: '1000000000', DestinationTag: 5, hash: 'AB'.repeat(32), date: 800000000 },
        { TransactionResult: 'tesSUCCESS', delivered_amount: '1' },
        1,
    );
    check('an XRPL payment counts what was delivered, not what it names (partial payments)', partial?.raw === '1' && partial.to_memo === '5');
    check('tonHash turns base64 into hex', led.tonHash('NhLrbvcYuo71VhOkjax/WSfAaf9H4OQWRVvKYe4RlhE=') === '3612eb6ef718ba8ef55613a48dac7f5927c069ff47e0e416455bca61ee119611');
    check('an EIP-7702 delegation is an account, not a contract', evm.isDelegation('0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d') && !evm.isDelegation('0x6080604052'));
    check('Blockscout kind: 7702 is eoa', evm.blockscoutKind({ is_contract: true, proxy_type: 'eip7702' }) === 'eoa' && evm.blockscoutKind({ is_contract: true }) === 'contract');
    const op = utxo.sochainTx('dogecoin', { hash: 'ab'.repeat(32), block_height: 1, time: 1, fee: '0.1', inputs: [], outputs: [{ index: 0, value: '0', address: 'op_return' }] });
    check('an OP_RETURN output has no address', op && op.outputs[0].address === undefined);
    check('ERC-20 Transfer logs are read, ERC-721 ones are not', evm.transferLogs({ logs: [
        { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', topics: [evm.TRANSFER_TOPIC, '0x' + '0'.repeat(24) + 'a'.repeat(40), '0x' + '0'.repeat(24) + 'b'.repeat(40)], data: '0x' + (5).toString(16).padStart(64, '0') },
        { address: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', topics: [evm.TRANSFER_TOPIC, '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + 'b'.repeat(40), '0x' + '1'.padStart(64, '0')], data: '0x' },
    ] }, '0x' + 'cd'.repeat(32), 1).length === 1);
    check('txHashOn: EVM keeps 0x, the Bitcoin family drops it, Solana is exact', tx.txHashOn('ethereum', 'AB'.repeat(32)) === '0x' + 'ab'.repeat(32) && tx.txHashOn('bitcoin', '0x' + 'AB'.repeat(32)) === 'ab'.repeat(32) && tx.txHashOn('solana', 'not a signature') === null);
}

// ---- Identify network: what a node offers ------------------------------------------------------
{
    const t = (type, data) => identify.targetOf({ id: 'n', type, data });
    check('an evm node is a candidate, linked same address on', t('cryptocurrency.crypto_address', { network: 'evm', address: '0x' + 'ab'.repeat(20) }).label === 'same address on');
    // A value no format reads is never decided and draws no link: counted toward "Most nodes per
    // run", it filled every sweep ahead of real addresses.
    check('an unreadable value is not a candidate', typeof t('cryptocurrency.crypto_address', { network: 'unknown', address: '0xab' }) === 'string' && typeof t('financial.crypto_address', { address: 'not-an-address', currency: 'btc' }) === 'string');
    // Spellings the app folds into one identity are one node: "rewriting" one overwrote the
    // original node's address and drew no link.
    check('an EIP-55, upper-case bech32 or bitcoincash: spelling on its network is already canonical', [
        ['ethereum', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'],
        ['bitcoin', 'BC1QQ2MVRP4G3UGD424DW4XV53RGSF8SZKRV853JRC'],
        ['bitcoin_cash', 'bitcoincash:qzchaks7lhwcf7lfg3am7uqy8m2yjnywnccd424dcp'],
        ['ton', '0:83DFD552E63729B472FCBCC8C45EBCC6691702558B68EC7527E1BA403A0F31A8'],
    ].every(([network, address]) => typeof t('cryptocurrency.crypto_address', { network, address }) === 'string'));
    check('a TRON hex or Bitcoin Cash legacy spelling is still rewritten', t('cryptocurrency.crypto_address', { network: 'tron', address: '41d1c4bb7b2f39aba5707711719b2236b5b605af2e' }).label === 'same as' && t('cryptocurrency.crypto_address', { network: 'bitcoin_cash', address: '1XPTgDRhN8RFnzniWCddobD9iKZatrvH4' }).label === 'same as');
    check('identityFold follows the app: hex, bech32 and CashAddr fold, Base58 does not', f.identityFold('0xAbC0000000000000000000000000000000000000') === '0xabc0000000000000000000000000000000000000' && f.identityFold('BITCOINCASH:QZCHAKS7LHWCF7LFG3AM7UQY8M2YJNYWNCCD424DCP') === 'qzchaks7lhwcf7lfg3am7uqy8m2yjnywnccd424dcp' && f.identityFold('TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi') === 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi');
    check('a canonical node on its network is left alone', typeof t('cryptocurrency.crypto_address', { network: 'bitcoin', address: '1XPTgDRhN8RFnzniWCddobD9iKZatrvH4' }) === 'string');
    check('a Litecoin 3… node is rewritten, linked same as', t('cryptocurrency.crypto_address', { network: 'litecoin', address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' }).label === 'same as');
    check('a legacy Financial node carries its label and the currency hint', (() => {
        const r = t('financial.crypto_address', { address: '1XPTgDRhN8RFnzniWCddobD9iKZatrvH4', currency: 'btc', owner_label: 'x' });
        return r.label === 'same as' && r.carry.public_label === 'x' && eq(r.hint.networks, ['bitcoin']);
    })());
    check('a non-payment tracking ID is not a candidate', typeof t('web.tracking_id', { provider: 'google_analytics', kind: 'analytics', value: 'G-1' }) === 'string');
}

// ---- TRON balances past 2^53 -------------------------------------------------------------------
{
    // parseExact hands a 16-digit or longer integer over as a digit string; countOf refused it and
    // 1.0.0 wrote balance "0".
    check('a TRON balance past 2^53 sun stays exact', tron.sunBalance('12345678901234567') === '12345678901.234567' && tron.sunBalance(http.parseExact('{"b":12345678901234567}').b) === '12345678901.234567');
    check('a TRON account with no balance key holds 0, an unreadable one is left out', tron.sunBalance(undefined) === '0' && tron.sunBalance(5_000_000) === '5' && tron.sunBalance('n/a') === undefined && tron.sunBalance(1.5) === undefined);
}

// ---- BlockCypher's height cursor -----------------------------------------------------------------
{
    // `before` keeps heights strictly below it. A page that ended partway through a block made
    // 1.0.0 ask `before=<that height>` and skip the rest of the block, then report the history
    // complete. Served here by a fake that applies the documented rule.
    const ADDR = 'XqPTFgWrZWV569zmiUQ4WATErsKuGkvxwk';
    const mk = (i, height) => ({
        hash: i.toString(16).padStart(64, '0'),
        block_height: height,
        confirmed: '2024-01-01T00:00:00Z',
        fees: 100,
        vin_sz: 1,
        vout_sz: 1,
        inputs: [{ addresses: [ADDR], output_value: 1000, prev_hash: 'ff'.repeat(32), output_index: 0, script_type: 'pay-to-pubkey-hash' }],
        outputs: [{ addresses: [ADDR], value: 900 }],
    });
    const serve = (all) => {
        const asked = [];
        const fetch = async (url) => {
            const u = new URL(url);
            asked.push(u.search);
            const limit = Number(u.searchParams.get('limit'));
            const before = u.searchParams.has('before') ? Number(u.searchParams.get('before')) : Infinity;
            const below = all.filter((t) => t.block_height < before);
            const body = { final_n_tx: all.length, balance: 0, txs: below.slice(0, limit), hasMore: below.length > limit };
            return { ok: true, status: 200, headers: {}, text: async () => JSON.stringify(body) };
        };
        return { fetch, asked };
    };
    const run = async (all, maxTxs) => {
        const s = serve(all);
        const h = new http.Http({ net: { fetch: s.fetch } });
        // No pacing waits in a unit test.
        const real = globalThis.setTimeout;
        globalThis.setTimeout = (fn, _ms, ...a) => real(fn, 0, ...a);
        try {
            return { h: await utxo.blockcypherHistory(h, 'dash', ADDR, maxTxs), asked: s.asked };
        } finally {
            globalThis.setTimeout = real;
        }
    };
    // 49 blocks with one transaction each, then a block with three, then one more block.
    const all = [...Array.from({ length: 49 }, (_, i) => mk(i + 1, 300 - i)), mk(100, 200), mk(101, 200), mk(102, 200), mk(103, 150)];
    const a = await run(all, 500);
    check('BlockCypher: the rest of a block a page ended in is read', a.h.txs.length === all.length && a.h.complete === true);
    // A block holding more of the address's transactions than a page: no progress past it.
    const crowded = Array.from({ length: 60 }, (_, i) => mk(i + 1, 500));
    const b = await run(crowded, 500);
    check('BlockCypher: a block larger than a page stops the history, incomplete, without looping', b.h.txs.length === 50 && b.h.complete === false && b.asked.length === 2);
}

console.log(`${ok.length} passed, ${fail.length} failed`);
for (const x of fail) console.log(`FAIL ${x}`);
process.exit(fail.length ? 1 : 0);
