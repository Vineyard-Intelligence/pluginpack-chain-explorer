// Runs the members against the real vendors and records their answers as test fixtures.
//
//   node live-test.mjs [scenario-name …]      (all scenarios when none is named)
//
// Every request goes out with a browser's Origin header, as the app's do, and nothing else: no
// member takes a key. Answers are trimmed of keys no member reads (scripts, signatures, ABIs,
// prices; test/host.mjs) and written to test/fixtures/<scenario>.json for test-plugin.mjs to replay.
// Volume is low on purpose — a few requests per vendor — and the vendors' own pacing applies.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCtx, makeGraph, recorder, typepackNote } from './test/host.mjs';
import { SCENARIOS } from './test/scenarios.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const pack = (await import('./dist/pack.mjs')).default;
const P = Object.fromEntries(pack.plugins.map((p) => [p.manifest.identifier.replace('run.vineyard.plugins.chain_explorer_', ''), p]));
const wanted = new Set(process.argv.slice(2));
mkdirSync(join(here, 'test', 'fixtures'), { recursive: true });
console.log(typepackNote);

let bad = 0;
for (const s of SCENARIOS) {
    if (wanted.size && !wanted.has(s.name)) continue;
    if (s.capturedBy && !wanted.has(s.name)) {
        console.log(`\n== ${s.name}: kept as captured with ${s.capturedBy} (see test/scenarios.mjs)`);
        continue;
    }
    const tape = [];
    const graph = makeGraph(s.nodes, s.edges ?? []);
    const { ctx, log } = makeCtx({ graph, selection: s.selection, params: s.params ?? {}, net: recorder(tape, { block: s.block ?? [] }) });
    const started = Date.now();
    let result;
    let error;
    try {
        result = await P[s.plugin].run(ctx);
    } catch (e) {
        error = String(e?.message ?? e);
        bad++;
    }
    if (graph.errors.length) bad++;
    writeFileSync(join(here, 'test', 'fixtures', `${s.name}.json`), JSON.stringify({ scenario: s.name, recorded: new Date().toISOString().slice(0, 10), tape }, null, 1) + '\n');
    console.log(`\n== ${s.name} (${tape.length} requests, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    if (error) console.log(`THREW: ${error}`);
    if (result) console.log(result.summary);
    if (graph.errors.length) console.log(`HOST ERRORS: ${graph.errors.join(' | ')}`);
    for (const l of log.slice(0, 5)) console.log(`  log: ${l}`);
}
console.log(bad ? `\n${bad} scenario(s) threw or broke a host rule` : '\nall scenarios ran');
process.exit(bad ? 1 : 0);
