// What a string says about its own network, and the canonical form the type pack wants written.
//
// Pure and dependency-free so test/pure.test.mjs can import it.
//
// THE RULE (X-13, X-1): a format that names one network settles it — `bc1…`, `ltc1…`/`L…`/`M…`, a
// TRON `T…`, a CashAddr, an XRPL `r…`. A format several networks share is decided by asking each
// one whether the address has activity there: `1…`/`3…` are the same bytes on Bitcoin, Bitcoin Cash
// and Bitcoin SV (and a Litecoin `3…` is valid on Bitcoin), `D…` is Dogecoin's and Verge's, and a
// `0x…` address is valid on every EVM chain. Guessing would put an address on a chain where it
// holds nothing, and the type pack keeps the guess apart from the source on purpose: the `evm` or
// `unknown` node stays and links to each network's node with `same address on`.
//
// Re-encoding is the writer's job (the type pack's identity is synchronous and only folds case),
// so this module also turns every accepted spelling into the canonical one: TRON hex → Base58,
// Litecoin `3…` → `M…`, Bitcoin Cash legacy → CashAddr, TON user-friendly → raw, XRPL X-address →
// classic address plus `memo`.
import {
    base58CheckDecode,
    base58CheckEncode,
    base58Decode,
    base64Decode,
    bytesToHex,
    cashAddrDecode,
    cashAddrEncode,
    crc16,
    hexToBytes,
    RIPPLE_B58,
    segwitDecode,
} from './codec';

export type Network =
    | 'bitcoin'
    | 'bitcoin_cash'
    | 'bitcoin_sv'
    | 'bitcoin_gold'
    | 'litecoin'
    | 'dogecoin'
    | 'dash'
    | 'zcash'
    | 'monero'
    | 'verge'
    | 'ethereum'
    | 'ethereum_classic'
    | 'bsc'
    | 'polygon'
    | 'arbitrum'
    | 'optimism'
    | 'base'
    | 'avalanche_c'
    | 'evm'
    | 'tron'
    | 'solana'
    | 'xrpl'
    | 'ton'
    | 'cardano'
    | 'bnb_beacon'
    | 'unknown';

/** Every EVM network the type pack names, in the order Identify network asks them. */
export const EVM_NETWORKS: readonly Network[] = ['ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism', 'base', 'avalanche_c', 'ethereum_classic'];

export interface Candidate {
    network: Network;
    /** The value in that network's canonical form. */
    address: string;
    memo?: string;
}

export type Reading =
    /** The format names one network. */
    | { kind: 'settled'; network: Network; address: string; memo?: string; basis: string }
    /** The format fits several networks: ask each for activity. */
    | { kind: 'shared'; candidates: Candidate[]; basis: string }
    /** Not an address in any format this pack knows. */
    | { kind: 'unreadable'; reason: string };

const b58check = (v: string, len = 21) => {
    const p = base58CheckDecode(v);
    return p && p.length === len ? p : null;
};

/** A TRON address as Base58Check, from either `T…` or hex `41…` (40 hex after the prefix). */
export function tronBase58(v: string): string | null {
    const s = v.trim();
    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) {
        const p = b58check(s);
        return p && p[0] === 0x41 ? s : null;
    }
    const m = /^(?:0x)?(41[0-9a-fA-F]{40})$/.exec(s);
    if (!m) return null;
    return base58CheckEncode(hexToBytes(m[1])!);
}

/** A TRON Base58 address as the 20-byte hex an ABI argument takes, or null. */
export function tronHex20(v: string): string | null {
    const p = b58check(v);
    return p && p[0] === 0x41 ? bytesToHex(p.subarray(1)) : null;
}

/** An XRPL classic address (`r…`, 25–35 characters, Ripple alphabet, version 0). */
export function xrplClassic(v: string): string | null {
    if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(v)) return null;
    const p = base58CheckDecode(v, RIPPLE_B58);
    return p && p.length === 21 && p[0] === 0 ? v : null;
}

/**
 * An XRPL X-address (XLS-5d) split into its classic address and destination tag. Mainnet only:
 * the `T…` testnet form names no account on the network the type pack means by `xrpl`.
 *
 * Layout after Base58Check (Ripple alphabet): 0x05 0x44, the 20-byte account id, a flag (0 no tag,
 * 1 a 32-bit tag), the tag in 8 little-endian bytes of which the upper 4 must be zero.
 */
export function xAddress(v: string): { address: string; memo?: string } | null {
    if (!/^X[1-9A-HJ-NP-Za-km-z]{46}$/.test(v)) return null;
    const p = base58CheckDecode(v, RIPPLE_B58);
    if (!p || p.length !== 31 || p[0] !== 0x05 || p[1] !== 0x44) return null;
    const flag = p[22];
    if (flag > 1) return null;
    for (let i = 27; i < 31; i++) if (p[i] !== 0) return null;
    const tag = p[23] + p[24] * 2 ** 8 + p[25] * 2 ** 16 + p[26] * 2 ** 24;
    if (flag === 0 && tag !== 0) return null;
    const classic = new Uint8Array(21);
    classic.set(p.subarray(2, 22), 1);
    return { address: base58CheckEncode(classic, RIPPLE_B58), memo: flag ? String(tag) : undefined };
}

/** A TON address as raw `workchain:hex64` lower case, from raw or user-friendly (`EQ…`, `UQ…`) form. */
export function tonRaw(v: string): string | null {
    const s = v.trim();
    const raw = /^(-1|0):([0-9a-fA-F]{64})$/.exec(s);
    if (raw) return `${raw[1]}:${raw[2].toLowerCase()}`;
    if (s.length !== 48) return null;
    const b = base64Decode(s);
    if (!b || b.length !== 36) return null;
    // Tag: 0x11 bounceable, 0x51 non-bounceable, +0x80 for testnet-only addresses (refused).
    if (b[0] !== 0x11 && b[0] !== 0x51) return null;
    if (crc16(b.subarray(0, 34)) !== (b[34] << 8) + b[35]) return null;
    const wc = b[1] === 0xff ? -1 : b[1];
    if (wc !== 0 && wc !== -1) return null;
    return `${wc}:${bytesToHex(b.subarray(2, 34))}`;
}

/** A Solana public key: Base58 decoding to exactly 32 bytes. */
export function solanaKey(v: string): string | null {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return null;
    const b = base58Decode(v);
    return b && b.length === 32 ? v : null;
}

const MONERO = /^[48][1-9A-HJ-NP-Za-km-z]{94}$|^4[1-9A-HJ-NP-Za-km-z]{105}$/;

/**
 * Read a string as an address. The basis is the plain-language reason, written on the link
 * Identify network draws so an analyst can check how a network was decided.
 */
export function readAddress(input: string): Reading {
    const v = input.trim();
    if (!v) return { kind: 'unreadable', reason: 'empty' };

    if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
        const a = v.toLowerCase();
        return { kind: 'shared', candidates: EVM_NETWORKS.map((network) => ({ network, address: a })), basis: '0x address, valid on every EVM chain' };
    }

    // bech32 / bech32m with a network's own prefix.
    const lower = v.toLowerCase();
    if (lower.startsWith('bc1') && segwitDecode('bc', v)) return { kind: 'settled', network: 'bitcoin', address: lower, basis: 'bech32 address with prefix bc' };
    if (lower.startsWith('ltc1') && segwitDecode('ltc', v)) return { kind: 'settled', network: 'litecoin', address: lower, basis: 'bech32 address with prefix ltc' };
    if (lower.startsWith('btg1') && segwitDecode('btg', v)) return { kind: 'settled', network: 'bitcoin_gold', address: lower, basis: 'bech32 address with prefix btg' };

    // CashAddr: a `bitcoincash:` prefix, or q/p/z/r and 42 or 61 characters, with the checksum
    // computed under `bitcoincash`. An XRPL `r…` address is mixed case and 25–35 characters, so the
    // two cannot meet.
    if (/^bitcoincash:/i.test(v) || (/^[qpzr]/i.test(v) && (v.length === 42 || v.length === 61))) {
        const c = cashAddrDecode(v);
        if (c) return { kind: 'settled', network: 'bitcoin_cash', address: cashAddrEncode(c.type, c.hash), basis: 'CashAddr' };
    }

    const tron = tronBase58(v);
    if (tron) return { kind: 'settled', network: 'tron', address: tron, basis: tron === v ? 'TRON Base58Check address (version 0x41)' : 'TRON hex address (41…), written in Base58' };

    const xrp = xrplClassic(v);
    if (xrp) return { kind: 'settled', network: 'xrpl', address: xrp, basis: 'XRPL classic address' };
    const xa = xAddress(v);
    if (xa) return { kind: 'settled', network: 'xrpl', address: xa.address, memo: xa.memo, basis: xa.memo ? 'XRPL X-address, split into the classic address and its destination tag' : 'XRPL X-address' };

    const ton = tonRaw(v);
    if (ton) {
        // The user-friendly form carries TON's own tag and CRC-16; a bare `0:<hex>` is also how
        // Everscale and other TVM chains write addresses, so the raw form is decided by activity.
        if (ton !== v.toLowerCase()) return { kind: 'settled', network: 'ton', address: ton, basis: 'TON user-friendly address, written in raw form' };
        return { kind: 'shared', candidates: [{ network: 'ton', address: ton }], basis: 'raw TVM address, the form TON and other TVM chains share' };
    }

    if (MONERO.test(v)) return { kind: 'settled', network: 'monero', address: v, basis: 'Monero address (95 or 106 Base58 characters)' };
    if (/^(addr1|stake1)[02-9ac-hj-np-z]+$/.test(lower) && v === lower) return { kind: 'settled', network: 'cardano', address: lower, basis: 'Cardano bech32 address' };
    if (lower.startsWith('bnb1') && /^bnb1[02-9ac-hj-np-z]{38}$/.test(lower)) return { kind: 'settled', network: 'bnb_beacon', address: lower, basis: 'BNB Beacon Chain bech32 address' };

    // Zcash transparent addresses have a two-byte version.
    const z = base58CheckDecode(v);
    if (z && z.length === 22 && z[0] === 0x1c && (z[1] === 0xb8 || z[1] === 0xbd)) {
        return { kind: 'settled', network: 'zcash', address: v, basis: `Zcash transparent address (${v.slice(0, 2)}…)` };
    }

    const p = b58check(v);
    if (p) {
        const ver = p[0];
        const body = p.subarray(1);
        switch (ver) {
            case 0x00:
            case 0x05: {
                const cash = cashAddrEncode(ver === 0x05 ? 1 : 0, body);
                const c: Candidate[] = [
                    { network: 'bitcoin', address: v },
                    { network: 'bitcoin_cash', address: cash },
                    { network: 'bitcoin_sv', address: v },
                ];
                // `3…` is also Litecoin's old P2SH form; the same script hash is `M…` today.
                if (ver === 0x05) c.push({ network: 'litecoin', address: base58CheckEncode(Uint8Array.from([0x32, ...body])) });
                return { kind: 'shared', candidates: c, basis: `legacy ${ver === 0 ? 'P2PKH (1…)' : 'P2SH (3…)'} address, the same bytes on Bitcoin, Bitcoin Cash and Bitcoin SV${ver === 0x05 ? ', and an old Litecoin P2SH form' : ''}` };
            }
            case 0x30:
            case 0x32:
                return { kind: 'settled', network: 'litecoin', address: v, basis: `Litecoin Base58Check address (${v[0]}…)` };
            case 0x1e:
                return {
                    kind: 'shared',
                    candidates: [
                        { network: 'dogecoin', address: v },
                        { network: 'verge', address: v },
                    ],
                    basis: 'D… address, the format Dogecoin and Verge share',
                };
            case 0x16:
                return { kind: 'settled', network: 'dogecoin', address: v, basis: 'Dogecoin P2SH address' };
            case 0x4c:
            case 0x10:
                return { kind: 'settled', network: 'dash', address: v, basis: `Dash address (${v[0]}…)` };
            case 0x26:
            case 0x17:
                return { kind: 'settled', network: 'bitcoin_gold', address: v, basis: `Bitcoin Gold address (${v[0]}…)` };
        }
    }

    // Solana keys carry no checksum, so this comes after every format that has one.
    if (solanaKey(v)) return { kind: 'settled', network: 'solana', address: v, basis: 'Solana public key (32 bytes in Base58)' };

    return { kind: 'unreadable', reason: 'not an address in any format this pack reads' };
}

/**
 * The canonical form of `raw` on `network`, or null when it is not an address there. For a node
 * whose network is already established: the lookups query, and write back, this form.
 */
export function canonicalOn(network: string, raw: unknown): { address: string; memo?: string } | null {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) return null;
    if ((EVM_NETWORKS as readonly string[]).includes(network) || network === 'evm') {
        return /^0x[0-9a-fA-F]{40}$/.test(v) ? { address: v.toLowerCase() } : null;
    }
    switch (network) {
        case 'bitcoin': {
            if (/^bc1/i.test(v)) return segwitDecode('bc', v) ? { address: v.toLowerCase() } : null;
            const p = b58check(v);
            return p && (p[0] === 0 || p[0] === 5) ? { address: v } : null;
        }
        case 'litecoin': {
            if (/^ltc1/i.test(v)) return segwitDecode('ltc', v) ? { address: v.toLowerCase() } : null;
            const p = b58check(v);
            if (!p) return null;
            if (p[0] === 0x05) return { address: base58CheckEncode(Uint8Array.from([0x32, ...p.subarray(1)])) };
            return p[0] === 0x30 || p[0] === 0x32 ? { address: v } : null;
        }
        case 'bitcoin_cash': {
            const c = cashAddrDecode(v);
            if (c) return { address: cashAddrEncode(c.type, c.hash) };
            const p = b58check(v);
            return p && (p[0] === 0 || p[0] === 5) ? { address: cashAddrEncode(p[0] === 5 ? 1 : 0, p.subarray(1)) } : null;
        }
        case 'dogecoin': {
            const p = b58check(v);
            return p && (p[0] === 0x1e || p[0] === 0x16) ? { address: v } : null;
        }
        case 'dash': {
            const p = b58check(v);
            return p && (p[0] === 0x4c || p[0] === 0x10) ? { address: v } : null;
        }
        case 'zcash': {
            const z = base58CheckDecode(v);
            return z && z.length === 22 && z[0] === 0x1c && (z[1] === 0xb8 || z[1] === 0xbd) ? { address: v } : null;
        }
        case 'tron': {
            const t = tronBase58(v);
            return t ? { address: t } : null;
        }
        case 'solana':
            return solanaKey(v) ? { address: v } : null;
        case 'xrpl': {
            if (xrplClassic(v)) return { address: v };
            const x = xAddress(v);
            return x ? { address: x.address, memo: x.memo } : null;
        }
        case 'ton': {
            const t = tonRaw(v);
            return t ? { address: t } : null;
        }
        default:
            return { address: v };
    }
}

/**
 * The app's identity fold for an address (identity-normalize.ts, `normalize: "crypto_address"`),
 * for the spellings this module accepts: 0x hex, TON raw and bech32 in lower case, CashAddr without
 * its `bitcoincash:` prefix in lower case, everything else as written.
 *
 * Two values that fold alike are ONE node to the app. Identify network once "rewrote" an EIP-55
 * address into lower case: the create landed on the original node, overwrote its address, drew no
 * link and was still reported as a rewrite (review of 1.0.0). Spellings that fold alike are
 * already canonical as far as the graph is concerned.
 */
export function identityFold(v: string): string {
    if (/^0x[0-9a-fA-F]{40}$/.test(v) || /^-?\d+:[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
    const lower = v.toLowerCase();
    for (const hrp of ['bc', 'ltc', 'btg']) if (lower.startsWith(`${hrp}1`) && segwitDecode(hrp, v)) return lower;
    if ((/^bitcoincash:/i.test(v) || (/^[qpzr]/i.test(v) && (v.length === 42 || v.length === 61))) && cashAddrDecode(v)) return lower.replace(/^bitcoincash:/, '');
    return v;
}

/** Script type of a Bitcoin-family address on its network, for `address_kind`. */
export function utxoKind(network: string, address: string): 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | undefined {
    const seg = /^bc1/.test(address) ? segwitDecode('bc', address) : /^ltc1/.test(address) ? segwitDecode('ltc', address) : null;
    if (seg) {
        if (seg.version === 0) return seg.program.length === 20 ? 'p2wpkh' : 'p2wsh';
        if (seg.version === 1 && seg.program.length === 32) return 'p2tr';
        return undefined;
    }
    if (network === 'bitcoin_cash') {
        const c = cashAddrDecode(address);
        return c ? (c.type % 2 === 0 ? 'p2pkh' : 'p2sh') : undefined;
    }
    if (network === 'zcash') {
        const z = base58CheckDecode(address);
        return z && z.length === 22 ? (z[1] === 0xb8 ? 'p2pkh' : 'p2sh') : undefined;
    }
    const p = b58check(address);
    if (!p) return undefined;
    const P2PKH: Record<string, number> = { bitcoin: 0x00, litecoin: 0x30, dogecoin: 0x1e, dash: 0x4c };
    const P2SH: Record<string, number> = { bitcoin: 0x05, litecoin: 0x32, dogecoin: 0x16, dash: 0x10 };
    if (P2PKH[network] === p[0]) return 'p2pkh';
    if (P2SH[network] === p[0]) return 'p2sh';
    return undefined;
}
