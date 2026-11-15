// Value conversions from vendor answers to what the Cryptocurrency type pack stores.
//
// Pure and dependency-free so test/pure.test.mjs can import it.

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** Drops undefined, null and '' so a delta never carries a blank (the host would ignore it anyway). */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
    return out as Partial<T>;
}

/** A non-negative safe integer from a number or a digit string, else undefined. */
export function countOf(v: unknown): number | undefined {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * An integer amount in base units as a decimal string in whole units.
 *
 * BigInt all the way: a wei value passes 2^53 at 0.009 ETH and Dogecoin has no supply cap, so
 * Number would round real amounts. Trailing zeros are dropped and a whole number has no point.
 * Returns null when `raw` is not a non-negative integer.
 */
export function formatUnits(raw: unknown, decimals: number): string | null {
    const s =
        typeof raw === 'bigint'
            ? raw.toString()
            : typeof raw === 'string'
              ? raw.trim()
              : typeof raw === 'number' && Number.isSafeInteger(raw)
                ? String(raw)
                : '';
    if (!/^\d+$/.test(s) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
    const v = BigInt(s);
    if (decimals === 0) return v.toString();
    const base = 10n ** BigInt(decimals);
    const whole = v / base;
    const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * A decimal amount in whole units ("0.42635996", "1.00001000") as an integer string in base units,
 * or null. The reverse of formatUnits, for vendors that answer in coins (SoChain, Insight).
 *
 * A NUMBER is taken only when it is written exactly with at most `decimals` places: Insight gives
 * input values as JSON numbers (1.00001), which print back the way they were sent, but a float
 * that needed rounding to print (0.1 + 0.2) is refused rather than turned into a wrong satoshi.
 */
export function parseUnits(v: unknown, decimals: number): string | null {
    let s = '';
    if (typeof v === 'string') s = v.trim();
    else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        s = String(v);
        if (/e/i.test(s)) return null;
    }
    const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) return null;
    const frac = (m[2] ?? '').replace(/0+$/, '');
    if (frac.length > decimals) return null;
    return (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString();
}

/** A `0x…` hex quantity (JSON-RPC) as a decimal integer string, or null. */
export function hexQuantity(v: unknown): string | null {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!/^0x[0-9a-fA-F]+$/.test(s)) return null;
    return BigInt(s).toString();
}

/** A time as `YYYY-MM-DDTHH:MM:SSZ`: from epoch seconds or milliseconds, or an ISO string. */
export function isoTime(v: unknown, unit: 's' | 'ms' = 's'): string | undefined {
    let t: number;
    if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v.trim()))) {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return undefined;
        t = unit === 's' ? n * 1000 : n;
    } else if (typeof v === 'string' && v.trim()) {
        t = Date.parse(v);
    } else return undefined;
    if (!Number.isFinite(t)) return undefined;
    const d = new Date(t);
    if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2008 || d.getUTCFullYear() > 2200) return undefined;
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A 0x address in any letter case, as the pack writes it: lower case (the type pack's canonical form). */
export function evmAddress(v: unknown): string | null {
    const s = typeof v === 'string' ? v.trim() : '';
    return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * A 64-hex transaction hash as the pack writes it. EVM and TRON vendors print it with or without
 * `0x`; the type pack's `hex` rule makes both one node, and the pack keeps each chain's own
 * convention so the review shows no spelling change: `0x` on EVM chains, bare elsewhere.
 */
export function hexHash(v: unknown, prefix: boolean): string | null {
    const m = typeof v === 'string' ? /^(?:0x)?([0-9a-fA-F]{64})$/.exec(v.trim()) : null;
    if (!m) return null;
    return prefix ? `0x${m[1].toLowerCase()}` : m[1].toLowerCase();
}

/** A Solana signature: Base58, 64 bytes (87 or 88 characters). Compared exactly by the type pack. */
export const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

/** An ABI-encoded string or bytes32 return value (ERC-20 `name()` / `symbol()`), or undefined. */
export function abiString(hex: unknown): string | undefined {
    const s = typeof hex === 'string' ? hex.replace(/^0x/, '') : '';
    if (!s || !/^[0-9a-fA-F]*$/.test(s) || s.length % 2) return undefined;
    const bytes = (h: string) => {
        const out: number[] = [];
        for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
        return out;
    };
    let raw: number[];
    if (s.length === 64) {
        // bytes32 (MKR, SAI and other early tokens): NUL-padded on the right.
        raw = bytes(s);
        while (raw.length && raw[raw.length - 1] === 0) raw.pop();
    } else if (s.length >= 128) {
        const off = Number(BigInt('0x' + s.slice(0, 64)));
        if (!Number.isSafeInteger(off) || off * 2 + 64 > s.length) return undefined;
        const len = Number(BigInt('0x' + s.slice(off * 2, off * 2 + 64)));
        if (!Number.isSafeInteger(len) || len > 256 || off * 2 + 64 + len * 2 > s.length) return undefined;
        raw = bytes(s.slice(off * 2 + 64, off * 2 + 64 + len * 2));
    } else return undefined;
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(raw));
    } catch {
        return undefined;
    }
    // Control characters would land in a label; a symbol made of them is no symbol.
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return clean ? clean.slice(0, 120) : undefined;
}

/** An ABI uint256 return value as a safe integer, or undefined (decimals() past 255 is not decimals). */
export function abiUint(hex: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
    const s = typeof hex === 'string' ? hex.replace(/^0x/, '') : '';
    if (!/^[0-9a-fA-F]{64}$/.test(s)) return undefined;
    const v = BigInt('0x' + s);
    return v <= BigInt(max) ? Number(v) : undefined;
}

/** An ABI bool return value, or undefined for anything that is not exactly 0 or 1. */
export function abiBool(hex: unknown): boolean | undefined {
    const s = typeof hex === 'string' ? hex.replace(/^0x/, '') : '';
    if (!/^[0-9a-fA-F]{64}$/.test(s)) return undefined;
    const v = BigInt('0x' + s);
    return v === 1n ? true : v === 0n ? false : undefined;
}

/** A 20-byte address as one ABI argument word. */
export const abiAddressWord = (hex40: string): string => hex40.replace(/^0x/, '').toLowerCase().padStart(64, '0');
