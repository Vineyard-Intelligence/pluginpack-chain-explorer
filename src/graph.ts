// Graph writes shared by the members: address, transaction and token nodes, and links that follow
// the Cryptocurrency type pack's rule of one link per pair.
//
// Adapted from pluginpack-blockscout-pro (src/graph.ts, 1.0.0), with memos and transaction nodes.
import type { GraphEdge, HostContext } from './sdk';
import { ADDRESS, TOKEN, TRANSACTION } from './common';

/**
 * Links as the project holds them, by ordered pair, plus the pairs this run has written.
 *
 * WHY READ BEFORE WRITING. A pair has one link (the backend's unique constraint), and `createEdge`
 * against a pair that already has one is a proposal to RELABEL it (host-bridge.ts). The type pack's
 * rule for collectors is never to relabel: an analyst's `controlled by` between two addresses stays
 * `controlled by`, and this pack's figures are added to it as data. So an existing link is amended
 * by id with `updateEdge`, which leaves its label and grade alone, and only a pair with no link
 * gets `createEdge`.
 *
 * Each pair is written once per run: every member aggregates first and writes after, because a
 * second create for a pair this run already staged would not see the first (staged links are not
 * in the project yet) and would stage a duplicate.
 */
export class Links {
    private byPair: Map<string, GraphEdge> | null = null;
    private readonly written = new Set<string>();
    created = 0;
    amended = 0;

    constructor(private readonly ctx: HostContext) {}

    private async index(): Promise<Map<string, GraphEdge>> {
        if (!this.byPair) {
            this.byPair = new Map();
            for (const e of (await this.ctx.graph?.edges?.()) ?? []) this.byPair.set(`${e.from_node_id}\0${e.to_node_id}`, e);
        }
        return this.byPair;
    }

    async existing(from: string, to: string): Promise<GraphEdge | undefined> {
        return (await this.index()).get(`${from}\0${to}`);
    }

    /** Whether this run already wrote the pair. */
    wrote(from: string, to: string): boolean {
        return this.written.has(`${from}\0${to}`);
    }

    /**
     * Add `data` to the pair's link, or create it with `label` when the pair has none. `data` may be
     * a function of the existing link, for keys that merge (the recent list).
     */
    async put(
        from: string,
        to: string,
        label: string,
        data: Record<string, unknown> | ((existing: GraphEdge | undefined) => Record<string, unknown>),
    ): Promise<'created' | 'amended' | 'skipped'> {
        const key = `${from}\0${to}`;
        if (this.written.has(key) || from === to) return 'skipped';
        this.written.add(key);
        const have = await this.existing(from, to);
        const payload = typeof data === 'function' ? data(have) : data;
        if (have) {
            if (!Object.keys(payload).length) return 'skipped';
            if (this.ctx.graph?.updateEdge) await this.ctx.graph.updateEdge(have.id, { data: payload });
            // An older host without updateEdge: restating the link's own label with data is the same
            // amendment (host-bridge.ts stages it with no label change).
            else await this.ctx.graph!.createEdge!({ from, to, label: have.label, data: payload });
            this.amended++;
            return 'amended';
        }
        await this.ctx.graph!.createEdge!({ from, to, label, data: payload });
        this.created++;
        return 'created';
    }
}

/**
 * Nodes created at most once per identity per run. The host de-duplicates by the type pack's
 * identity (network + address + memo, hex folded), so an address already in the project comes back
 * as that node with the fields merged in.
 */
export class Nodes {
    private readonly ids = new Map<string, string>();
    created = 0;

    constructor(private readonly ctx: HostContext) {}

    /** Ids already known: the seed, so a transfer to itself never makes a second node. */
    knowAddress(network: string, address: string, memo: string | undefined, id: string): void {
        this.ids.set(`a|${network}|${address}|${memo ?? ''}`, id);
    }

    knowTx(network: string, hash: string, id: string): void {
        this.ids.set(`t|${network}|${hash}`, id);
    }

    private async ensure(key: string, type: string, data: Record<string, unknown>): Promise<string> {
        const have = this.ids.get(key);
        if (have) return have;
        const n = await this.ctx.graph!.createNode!({ type, data });
        this.ids.set(key, n.id);
        this.created++;
        return n.id;
    }

    address(network: string, address: string, fields: Record<string, unknown> = {}, memo?: string): Promise<string> {
        return this.ensure(`a|${network}|${address}|${memo ?? ''}`, ADDRESS, { ...fields, network, address, ...(memo ? { memo } : {}) });
    }

    transaction(network: string, tx_hash: string, fields: Record<string, unknown> = {}): Promise<string> {
        return this.ensure(`t|${network}|${tx_hash}`, TRANSACTION, { ...fields, network, tx_hash });
    }

    token(network: string, contract_address: string, fields: Record<string, unknown> = {}): Promise<string> {
        return this.ensure(`k|${network}|${contract_address}`, TOKEN, { ...fields, network, contract_address });
    }
}
