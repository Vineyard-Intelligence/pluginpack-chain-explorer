// Replay tests for the Chain Explorer pack — no network, no app.
//   Run: node test-plugin.mjs [bundle] [--dump scenario]     (and node test/pure.test.mjs)
//
// Each scenario in test/scenarios.mjs runs against the vendor answers live-test.mjs recorded
// (test/fixtures/<scenario>.json, trimmed of keys no member reads). A request the bundle makes that
// was not recorded fails the scenario: a changed URL or an extra call shows up here rather than in
// the field. Waits are skipped: the pacing that keeps a run under the vendors' limits would only make
// a replay slow.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeCtx, makeGraph, player, typepackNote } from './test/host.mjs';
import { SCENARIOS } from './test/scenarios.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const dumpAt = args.indexOf('--dump');
const dump = dumpAt >= 0 ? args[dumpAt + 1] : null;
const bundle = args.find((a, i) => !a.startsWith('--') && (dumpAt < 0 || i !== dumpAt + 1));
const pack = (await import(bundle ? pathToFileURL(resolve(bundle)).href : './dist/pack.mjs')).default;
const P = Object.fromEntries(pack.plugins.map((p) => [p.manifest.identifier.replace('run.vineyard.plugins.chain_explorer_', ''), p]));

// No waiting in a replay.
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...a) => realTimeout(fn, 0, ...a);

const ok = [];
const fail = [];
const check = (name, cond) => (cond ? ok : fail).push(name);

async function replay(name, overrides = {}) {
    const s = SCENARIOS.find((x) => x.name === name);
    if (!s) throw new Error(`no scenario ${name}`);
    const { tape } = JSON.parse(readFileSync(join(here, 'test', 'fixtures', `${name}.json`), 'utf8'));
    const p = player(tape);
    const graph = makeGraph(overrides.nodes ?? s.nodes, overrides.edges ?? s.edges ?? [], { edgeData: overrides.edgeData, refuse: overrides.refuse });
    // `wrap`: a test's own answers in front of the recorded ones (a vendor refusing, say).
    const net = overrides.wrap ? overrides.wrap(p.fetch) : p.fetch;
    const { ctx } = makeCtx({ graph, selection: overrides.selection ?? s.selection, params: { ...(s.params ?? {}), ...(overrides.params ?? {}) }, net });
    let result;
    let error;
    try {
        result = await P[s.plugin].run(ctx);
    } catch (e) {
        error = e;
    }
    const nodes = [...graph.nodes.values()];
    const byAddr = (network, address, memo) => nodes.find((n) => n.type === 'cryptocurrency.crypto_address' && n.data.network === network && n.data.address === address && (n.data.memo ?? '') === (memo ?? ''));
    const edge = (from, to) => graph.live.find((e) => e.from_node_id === from && e.to_node_id === to);
    const out = { s, graph, result, error, missing: p.missing, nodes, byAddr, edge, summary: result?.summary ?? '' };
    if (dump === name) {
        console.log(JSON.stringify({ summary: out.summary, error: String(error ?? ''), missing: p.missing, errors: graph.errors, created: graph.created, updates: graph.updates, edges: graph.live }, null, 1));
    }
    return out;
}

/** Every scenario: ran, asked only what was recorded, broke no host rule. */
async function base(name) {
    const r = await replay(name);
    check(`${name}: did not throw (${r.error?.message ?? ''})`, !r.error);
    check(`${name}: every request was recorded (${r.missing.slice(0, 2).join(' | ')})`, r.missing.length === 0);
    check(`${name}: no host rule broken (${r.graph.errors.slice(0, 3).join(' | ')})`, r.graph.errors.length === 0);
    return r;
}

console.log(typepackNote);
const results = {};
for (const s of SCENARIOS) results[s.name] = await base(s.name);

// The pack page is the catalog's About: about 1,500 characters, and a summary of at most 250.
check(`pack: the page fits 1,500 characters (${pack.description.length}) and the summary 250`, pack.description.length <= 1500 && pack.summary.length <= 250);

// What each member must have written, and the rules it must hold: test/assertions.mjs.
const { default: assertions } = await import('./test/assertions.mjs');
await assertions({ replay, results, check });
globalThis.setTimeout = realTimeout;

console.log(`\n${ok.length} passed, ${fail.length} failed`);
for (const f of fail) console.log(`FAIL ${f}`);
process.exit(fail.length ? 1 : 0);
