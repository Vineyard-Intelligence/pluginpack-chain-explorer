// The shapes every vendor adapter answers in, so the members write one way whatever the source.
import type { VendorSpec } from './http';

/** One value movement on an account chain. Addresses canonical; `raw` an integer in base units. */
export interface Move {
    tx_hash: string;
    time?: string;
    /** Block, slot, ledger, logical time or timestamp: whatever orders this chain's rows. */
    order: number;
    from: string;
    to: string;
    /** XRPL destination tag the payment carried: the receiving side is (to, memo). */
    to_memo?: string;
    /** 'native', or the token's contract / mint / issuer id. */
    asset: string;
    symbol?: string;
    /** null when the source does not give the token's decimals: the amount stays in base units. */
    decimals: number | null;
    raw: string;
}

/** What one list (native transfers, token transfers, internal transfers…) reached. */
export interface Feed {
    name: string;
    rows: Move[];
    /** Every page was read: there is nothing older. */
    complete: boolean;
    /** The lowest `order` the list reached, value or not. */
    oldest: number | null;
    /** Rows read, value or not. */
    examined: number;
    newest?: string;
    oldestTime?: string;
    /** A vendor bound on how far back the list can go (Binplorer's free key: 30 days). */
    floorTime?: string;
}

/** Facts about an address that come with its history. */
export interface Facts {
    balance?: string;
    tx_count?: number;
    first_seen?: string;
    last_seen?: string;
    address_kind?: string;
    activated_at?: string;
    public_label?: string;
    label_source?: string;
}

export interface AccountHistory {
    kind: 'account';
    /** Slug for the link's `summary_<source>` key. */
    source: string;
    vendor: string;
    feeds: Feed[];
    facts: Facts;
    /** Fields for counterparty nodes that came with the rows (labels, kinds), by address. */
    parties?: Map<string, Record<string, unknown>>;
}

/** One input or output of a Bitcoin-family transaction. `raw` in base units (satoshi). */
export interface Part {
    index: number;
    address?: string;
    raw: string;
    prev_txid?: string;
    prev_vout?: number;
}

export interface UtxoTx {
    txid: string;
    block_height?: number;
    block_time?: string;
    confirmed: boolean;
    /** Decimal string in coins. */
    fee?: string;
    coinbase: boolean;
    inputs: Part[];
    outputs: Part[];
    /** True when the vendor cut the input or output list short (BlockCypher lists 20 of each). */
    truncated?: boolean;
}

export interface UtxoHistory {
    kind: 'utxo';
    source: string;
    vendor: string;
    txs: UtxoTx[];
    complete: boolean;
    facts: Facts;
}

/** A transaction on an account chain, as the Transaction member writes it. */
export interface AccountTx {
    tx_hash: string;
    block_height?: number;
    block_time?: string;
    status?: 'success' | 'failed' | 'pending';
    fee?: string;
    tx_kind?: 'transfer' | 'contract_call' | 'contract_creation' | 'coinbase' | 'other';
    /** The account that signed (and paid for) it. */
    signer?: string;
    moves: Move[];
    created_contract?: string;
    /** Chain-specific keys written beside the type pack's fields (a Solana slot, a TON logical time). */
    extra?: Record<string, unknown>;
}

/** Network-level constants. */
export interface Chain {
    network: string;
    name: string;
    native: string;
    decimals: number;
    family: 'utxo' | 'evm' | 'tron' | 'solana' | 'xrpl' | 'ton';
    chainId?: number;
}

export type { VendorSpec };
