// Requests to the keyless vendors: pacing per vendor, one retry, and the line between "this vendor
// did not answer" (try the next one) and "this vendor answered" (use it, even when it says nothing).
//
// WHY A SHARED CLIENT. Every vendor here is free and unkeyed, so its limit is per IP and most do
// not publish one. A run that meets a 429 has lost that vendor for a while, so the client spaces
// requests to stay under what is known (Routescan 2 a second, toncenter 1, the Ethplorer free key
// 20 a minute) and stops calling a vendor once a run has spent a share of a small hourly budget
// (BlockCypher 100 an hour, Binplorer 100 an hour), leaving the rest of the hour to the next run.
import type { HostContext } from './sdk';

export interface VendorSpec {
    id: string;
    /** As the summary names it. */
    name: string;
    /** Smallest gap between two requests to this vendor. */
    gapMs: number;
    /** Most requests one run sends, for vendors with a small hourly or daily budget. */
    perRun?: number;
    /**
     * Vendors that share one limit and so one spacing, when they are refused apart (PublicNode's
     * per-chain endpoints). Defaults to `id`.
     */
    pace?: string;
}

/** The vendor gave no usable answer: down, refused, rate-limited, a challenge page, an unknown shape. */
export class VendorDown extends Error {
    constructor(
        readonly vendor: string,
        reason: string,
    ) {
        super(reason);
    }
}

/** The run is out of time: stop taking new work and return what was found. */
export class OutOfTime extends Error {}

export const abortErr = (): Error => new Error('cancelled');

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (ms <= 0) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }
        function onAbort() {
            clearTimeout(timer);
            reject(abortErr());
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });

// The host ends a run at its budget (10 minutes when the manifest names none, worker-host.ts) and
// discards everything it staged. So nothing new starts after RUN_BUDGET_MS and no request is sent
// after HARD_BUDGET_MS, and each request's own deadline ends by HARD_BUDGET_MS + SETTLE_MS: the
// host's clock started earlier than this one, when the worker was created.
export const RUN_BUDGET_MS = 7 * 60_000;
export const HARD_BUDGET_MS = 9 * 60_000;
const SETTLE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * JSON.parse, with every integer too long for a double kept as a digit string.
 *
 * Lamport and wei amounts arrive as bare JSON numbers from some vendors, and a Solana wallet's
 * balance passes 2^53 at nine million SOL (measured 2026-11-15: 9,300,003,251,652,038 lamports on
 * one exchange wallet), which JSON.parse would round. Integers of 16 digits or more outside
 * strings are quoted before parsing; the amount readers here all accept digit strings.
 */
export function parseExact(text: string): any {
    let out = '';
    let i = 0;
    let last = 0;
    const n = text.length;
    while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 34) {
            // Skip a string, escapes included.
            i++;
            while (i < n) {
                const d = text.charCodeAt(i);
                if (d === 92) i += 2;
                else if (d === 34) break;
                else i++;
            }
            i++;
            continue;
        }
        if ((c >= 48 && c <= 57) || c === 45) {
            // One whole number token: sign, integer part, fraction, exponent.
            const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
            const tok = m ? m[0] : text[i];
            if (m && !m[1] && !m[2] && tok.replace('-', '').length >= 16) {
                out += text.slice(last, i) + '"' + tok + '"';
                last = i + tok.length;
            }
            i += tok.length;
            continue;
        }
        i++;
    }
    return JSON.parse(last ? out + text.slice(last) : text);
}

export interface Got {
    status: number;
    body: any;
}

export class Http {
    readonly used = new Map<string, number>();
    readonly refused = new Map<string, string>();
    private readonly last = new Map<string, number>();
    readonly startedAt = Date.now();

    constructor(private readonly ctx: HostContext) {}

    get outOfTime(): boolean {
        return Date.now() - this.startedAt > RUN_BUDGET_MS;
    }

    /** Requests sent so far, per vendor name, for the summary. */
    usage(): string {
        return [...this.used].map(([k, n]) => `${k} ${n}`).join(', ');
    }

    /** Mark a vendor as out for the rest of this run (its refusals cost a request each). */
    giveUp(v: VendorSpec, why: string): VendorDown {
        if (!this.refused.has(v.id)) this.refused.set(v.id, why);
        return new VendorDown(v.id, `${v.name}: ${why}`);
    }

    /**
     * One request. Resolves with the status and decoded JSON for any answer the vendor meant —
     * 200, and 400/404 with a JSON body, which callers read as "no such thing". Throws VendorDown
     * for everything that is not an answer, so the caller moves to the next vendor.
     */
    async request(v: VendorSpec, url: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<Got> {
        const prior = this.refused.get(v.id);
        if (prior) throw new VendorDown(v.id, `${v.name}: ${prior} earlier in this run`);
        const n = this.used.get(v.name) ?? 0;
        if (v.perRun && n >= v.perRun) throw this.giveUp(v, `this run's share of its free limit (${v.perRun} requests) is used`);
        for (let attempt = 0; ; attempt++) {
            if (this.ctx.signal?.aborted) throw abortErr();
            const elapsed = Date.now() - this.startedAt;
            if (elapsed > HARD_BUDGET_MS) throw new OutOfTime('the run reached its time budget');
            const pace = v.pace ?? v.id;
            await sleep((this.last.get(pace) ?? 0) + v.gapMs - Date.now(), this.ctx.signal);
            this.last.set(pace, Date.now());
            this.used.set(v.name, (this.used.get(v.name) ?? 0) + 1);
            const headers: Record<string, string> = { Accept: 'application/json' };
            let body: string | undefined;
            if (init.body !== undefined) {
                headers['Content-Type'] = 'application/json';
                body = JSON.stringify(init.body);
            }
            let res;
            try {
                res = await this.ctx.net!.fetch!(url, {
                    method: init.method ?? (body ? 'POST' : 'GET'),
                    headers,
                    body,
                    timeoutMs: Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, HARD_BUDGET_MS + SETTLE_MS - (Date.now() - this.startedAt))),
                } as any);
            } catch (e) {
                if (this.ctx.signal?.aborted) throw abortErr();
                if (attempt < 1) {
                    await sleep(1500, this.ctx.signal);
                    continue;
                }
                throw new VendorDown(v.id, `${v.name}: no answer (${(e as Error)?.name === 'TimeoutError' ? 'timed out' : 'network error'})`);
            }
            const text = await res.text().catch(() => '');
            // A rate limit or a refusal is this vendor's answer for the rest of the run: retrying it
            // costs the vendor's patience and the run's time, and the next vendor may serve.
            if (res.status === 429 && attempt < 1) {
                // One wait for a vendor that only throttled: a keyless tier's window is short, and
                // for TON, Bitcoin Cash or Zcash there is no second vendor to move to.
                await sleep(3000, this.ctx.signal);
                continue;
            }
            if (res.status === 429 || res.status === 430 || res.status === 403 || res.status === 402 || res.status === 401) {
                throw this.giveUp(v, `refused with HTTP ${res.status}`);
            }
            if (res.status >= 500) {
                if (attempt < 1) {
                    // eth.blockscout.com answers the first request for a cold address with a 500 and
                    // the same request a few seconds later with the address (2026-11-15); 2 s was not
                    // enough.
                    await sleep(5000, this.ctx.signal);
                    continue;
                }
                throw new VendorDown(v.id, `${v.name}: HTTP ${res.status}`);
            }
            let json: any;
            let parsed = true;
            try {
                json = text ? parseExact(text) : null;
            } catch {
                parsed = false;
            }
            // "No such address" is often plain text (Esplora: `Invalid Bitcoin address`, 400).
            if (res.status === 400 || res.status === 404 || res.status === 422) return { status: res.status, body: parsed ? json : text };
            if (!parsed) {
                // An HTML page where JSON was asked for is a Cloudflare challenge or an error page.
                throw this.giveUp(v, /<html|<!doctype/i.test(text) ? 'answered with a web page, not data (a bot check)' : 'answered with something that is not JSON');
            }
            if (res.status >= 200 && res.status < 300) return { status: res.status, body: json };
            throw new VendorDown(v.id, `${v.name}: HTTP ${res.status}`);
        }
    }

    /** GET returning the body of a 2xx, or null for a 404/400 ("no such thing"). */
    async get(v: VendorSpec, url: string): Promise<any | null> {
        const r = await this.request(v, url);
        return r.status >= 200 && r.status < 300 ? r.body : null;
    }

    async post(v: VendorSpec, url: string, body: unknown): Promise<any | null> {
        const r = await this.request(v, url, { method: 'POST', body });
        return r.status >= 200 && r.status < 300 ? r.body : null;
    }
}

/**
 * Try `steps` in order and return the first answer. A VendorDown moves to the next step and is
 * remembered for the summary; anything else (cancel, out of time, a bug) propagates.
 */
export async function firstAnswer<T>(steps: Array<{ vendor: string; run: () => Promise<T> }>): Promise<{ value: T; vendor: string; missed: string[] }> {
    const missed: string[] = [];
    for (const s of steps) {
        try {
            return { value: await s.run(), vendor: s.vendor, missed };
        } catch (e) {
            if (e instanceof VendorDown) {
                missed.push(e.message);
                continue;
            }
            throw e;
        }
    }
    throw new VendorDown(steps.map((s) => s.vendor).join('+'), missed.join('; ') || 'no source');
}
