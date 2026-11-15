// Address encodings: Base58 and Base58Check (Bitcoin and Ripple alphabets), bech32/bech32m
// (SegWit), CashAddr, and the base64 + CRC-16 form of TON addresses.
//
// WHY THE PACK DECODES AT ALL, rather than passing strings through: the Cryptocurrency type pack
// leaves re-encoding to the writer. Its identity rule folds letter case and nothing more, so a
// Bitcoin Cash address written in the legacy `1…` form, a Litecoin P2SH written as `3…`, a TRON
// address written in hex and the same account written canonically (`q…`, `M…`, `T…`) are
// different nodes unless whoever writes them writes the canonical form. Vendors want the canonical
// form too: 3xpl answered a legacy BCH address and an upper-case bech32 one with a silent zero
// (measured 2026-11-14) — the failure that looks like a real negative.
//
// Every decoder checks the checksum, so a mistyped address is refused before it is sent rather
// than costing a request and coming back "never used".
//
// Copied from pluginpack-blockchair (src/codec.ts, 1.0.0) and extended, the way sdk.ts is copied:
// a fix in one copy does not reach the other by itself.
//
// Pure, synchronous and dependency-free: SHA-256 is implemented here because Base58Check needs it
// and the identity work around it is synchronous (crypto.subtle is async). test/pure.test.mjs
// checks it against node:crypto.

// ---- SHA-256 (FIPS 180-4) ---------------------------------------------------------------------

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export function sha256(data: Uint8Array): Uint8Array {
    const H = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const len = data.length;
    const padded = (((len + 9 + 63) >> 6) << 6) >>> 0;
    const buf = new Uint8Array(padded);
    buf.set(data);
    buf[len] = 0x80;
    const view = new DataView(buf.buffer);
    const bits = len * 8;
    view.setUint32(padded - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padded - 4, bits >>> 0);
    const W = new Uint32Array(64);
    for (let off = 0; off < padded; off += 64) {
        for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
            const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
            W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
        }
        let a = H[0];
        let b = H[1];
        let c = H[2];
        let d = H[3];
        let e = H[4];
        let f = H[5];
        let g = H[6];
        let h = H[7];
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            h = g;
            g = f;
            f = e;
            e = (d + t1) | 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) | 0;
        }
        H[0] += a;
        H[1] += b;
        H[2] += c;
        H[3] += d;
        H[4] += e;
        H[5] += f;
        H[6] += g;
        H[7] += h;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
    return out;
}

// ---- Base58 / Base58Check ---------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** XRPL's alphabet: the same scheme with the digits reordered so that account ids start with `r`. */
export const RIPPLE_B58 = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

/** Longest string decoded. A Base58Check address is at most 36 characters (Zcash t-addresses are
 *  35); the bound keeps the quadratic conversion below from being handed a megabyte. */
const MAX_B58 = 64;

export function base58Decode(s: string, alphabet = B58): Uint8Array | null {
    if (!s || s.length > MAX_B58) return null;
    const bytes: number[] = [];
    for (const ch of s) {
        let carry = alphabet.indexOf(ch);
        if (carry < 0) return null;
        for (let j = 0; j < bytes.length; j++) {
            carry += bytes[j] * 58;
            bytes[j] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    let zeros = 0;
    while (zeros < s.length && s[zeros] === alphabet[0]) zeros++;
    const out = new Uint8Array(zeros + bytes.length);
    for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
    return out;
}

export function base58Encode(data: Uint8Array, alphabet = B58): string {
    const digits: number[] = [];
    for (const byte of data) {
        let carry = byte;
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let out = '';
    for (let i = 0; i < data.length && data[i] === 0; i++) out += alphabet[0];
    for (let i = digits.length - 1; i >= 0; i--) out += alphabet[digits[i]];
    return out;
}

const checksum4 = (payload: Uint8Array): Uint8Array => sha256(sha256(payload)).subarray(0, 4);

/** The payload of a Base58Check string (version bytes + hash), or null when the checksum fails. */
export function base58CheckDecode(s: string, alphabet = B58): Uint8Array | null {
    const raw = base58Decode(s, alphabet);
    if (!raw || raw.length < 5) return null;
    const payload = raw.subarray(0, raw.length - 4);
    const sum = checksum4(payload);
    for (let i = 0; i < 4; i++) if (sum[i] !== raw[raw.length - 4 + i]) return null;
    return payload;
}

export function base58CheckEncode(payload: Uint8Array, alphabet = B58): string {
    const out = new Uint8Array(payload.length + 4);
    out.set(payload);
    out.set(checksum4(payload), payload.length);
    return base58Encode(out, alphabet);
}

// ---- bech32 / bech32m (BIP-173, BIP-350) ------------------------------------------------------
// The polymod is the app's own (identity-normalize.ts), so the pack and the identity rule agree on
// what checksums.

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
    let chk = 1;
    for (const v of values) {
        const top = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= BECH32_GEN[i];
    }
    return chk;
}

/** Regroup bits; `pad` false refuses leftover bits the way BIP-173 decoding requires. */
export function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] | null {
    let acc = 0;
    let bits = 0;
    const out: number[] = [];
    const max = (1 << to) - 1;
    for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (v < 0 || v >> from) return null;
        acc = (acc << from) | v;
        bits += from;
        while (bits >= to) {
            bits -= to;
            out.push((acc >> bits) & max);
        }
    }
    if (pad) {
        if (bits) out.push((acc << (to - bits)) & max);
    } else if (bits >= from || (acc << (to - bits)) & max) {
        return null;
    }
    return out;
}

export interface Segwit {
    hrp: string;
    version: number;
    program: Uint8Array;
}

/**
 * A SegWit address under `hrp`, checked as BIP-173/350 require: one letter case, at most 90
 * characters, bech32 for version 0 and bech32m for 1–16, a 2–40 byte program, 20 or 32 for v0.
 */
export function segwitDecode(hrp: string, addr: string): Segwit | null {
    if (addr.length > 90 || (addr !== addr.toLowerCase() && addr !== addr.toUpperCase())) return null;
    const s = addr.toLowerCase();
    const sep = s.lastIndexOf('1');
    if (sep < 1 || s.slice(0, sep) !== hrp || sep + 7 > s.length) return null;
    const values: number[] = [];
    for (let i = 0; i < hrp.length; i++) values.push(hrp.charCodeAt(i) >>> 5);
    values.push(0);
    for (let i = 0; i < hrp.length; i++) values.push(hrp.charCodeAt(i) & 31);
    const data: number[] = [];
    for (let i = sep + 1; i < s.length; i++) {
        const d = B32.indexOf(s[i]);
        if (d < 0) return null;
        data.push(d);
    }
    const pm = bech32Polymod([...values, ...data]);
    const words = data.slice(0, -6);
    if (!words.length) return null;
    const version = words[0];
    if (version > 16) return null;
    if (pm !== (version === 0 ? BECH32_CONST : BECH32M_CONST)) return null;
    const prog = convertBits(words.slice(1), 5, 8, false);
    if (!prog || prog.length < 2 || prog.length > 40) return null;
    if (version === 0 && prog.length !== 20 && prog.length !== 32) return null;
    return { hrp, version, program: Uint8Array.from(prog) };
}

// ---- CashAddr (Bitcoin Cash) -------------------------------------------------------------------
// A 40-bit BCH code, past the 32 bits of JavaScript's bitwise operators — hence BigInt.

const CASH_GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
const CASH_PREFIX = 'bitcoincash';

function cashPolymod(values: number[]): bigint {
    let c = 1n;
    for (const d of values) {
        const top = c >> 35n;
        c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
        for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) c ^= CASH_GEN[i];
    }
    return c ^ 1n;
}

const prefixValues = (prefix: string): number[] => [...[...prefix].map((ch) => ch.charCodeAt(0) & 31), 0];

/** Hash sizes the version byte's low three bits name (CashAddr spec). */
const CASH_SIZES = [20, 24, 28, 32, 40, 48, 56, 64];

export interface CashAddr {
    /** 0 P2PKH, 1 P2SH, 2 token-aware P2PKH, 3 token-aware P2SH. */
    type: number;
    hash: Uint8Array;
}

/** A Bitcoin Cash CashAddr, with or without its `bitcoincash:` prefix, in one letter case. */
export function cashAddrDecode(addr: string): CashAddr | null {
    if (addr.length > 120 || (addr !== addr.toLowerCase() && addr !== addr.toUpperCase())) return null;
    let s = addr.toLowerCase();
    if (s.startsWith(`${CASH_PREFIX}:`)) s = s.slice(CASH_PREFIX.length + 1);
    if (s.includes(':') || s.length < 9) return null;
    const data: number[] = [];
    for (const ch of s) {
        const d = B32.indexOf(ch);
        if (d < 0) return null;
        data.push(d);
    }
    if (cashPolymod([...prefixValues(CASH_PREFIX), ...data]) !== 0n) return null;
    const bytes = convertBits(data.slice(0, -8), 5, 8, false);
    if (!bytes || !bytes.length) return null;
    const version = bytes[0];
    if (version & 0x80) return null;
    const hash = Uint8Array.from(bytes.slice(1));
    if (hash.length !== CASH_SIZES[version & 7]) return null;
    return { type: version >> 3, hash };
}

/** CashAddr without the prefix, lower case: the form the Cryptocurrency type pack stores. */
export function cashAddrEncode(type: number, hash: Uint8Array): string {
    const size = CASH_SIZES.indexOf(hash.length);
    if (size < 0) throw new Error(`no CashAddr size for a ${hash.length}-byte hash`);
    const payload = convertBits([(type << 3) | size, ...hash], 8, 5, true)!;
    const mod = cashPolymod([...prefixValues(CASH_PREFIX), ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
    let out = '';
    for (const v of payload) out += B32[v];
    for (let i = 0; i < 8; i++) out += B32[Number((mod >> BigInt(5 * (7 - i))) & 31n)];
    return out;
}

// ---- hex and base64 ----------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array | null {
    if (hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

export const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard or URL-safe base64, padded or not, to bytes; null for anything else. */
export function base64Decode(s: string): Uint8Array | null {
    const t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]*$/.test(t) || t.length % 4 === 1 || t.length > 4096) return null;
    const out: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const ch of t) {
        acc = (acc << 6) | B64.indexOf(ch);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
        }
    }
    return Uint8Array.from(out);
}

// ---- CRC-16/XMODEM (TON user-friendly addresses) -----------------------------------------------

export function crc16(data: Uint8Array): number {
    let crc = 0;
    for (const byte of data) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}
