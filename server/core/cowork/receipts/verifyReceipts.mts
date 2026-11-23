/**
 * Checking an item's receipt chain (./issueReceipts.mts makes it): every receipt follows the one before it (no gap in
 * its number), names the hash of the one before it (no receipt taken out and the rest re-linked), still hashes to what
 * it says (nothing edited), and carries a valid signature of the installation's key. Pure: receipts and a public key
 * in, a verdict out. The first problem found is named; the rest of the chain is not trusted after it.
 */

import { hashPayload, linkHash } from './receiptHash.mts';
import { verifyHash } from './receiptKey.mts';
import type { StoredReceipt } from '../../../stores/coworkReceipts.mts';

export type ChainProblem = 'gap' | 'link' | 'content' | 'signature';

export interface ChainVerdict {
    ok: boolean;
    count: number;
    /** The first receipt that does not hold, and why; null when the whole chain holds. */
    problem: { seq: number; kind: ChainProblem } | null;
    /** Receipts issued without a key (no master key at the time); their chain still holds. */
    unsigned: number;
    head: { seq: number; hash: string } | null;
}

/** Check one receipt against the hash of the one before it. Null when it holds. */
function problemOf(r: StoredReceipt, expectedSeq: number, prevHash: string, key: { keyId: string; publicKeyPem: string } | null): ChainProblem | null {
    if (r.seq !== expectedSeq) return 'gap';
    if (r.prevHash !== prevHash) return 'link';
    if (hashPayload(r.payload) !== r.payloadHash || linkHash(r.prevHash, r.payloadHash) !== r.hash) return 'content';
    if (r.signature && key && r.keyId === key.keyId && !verifyHash(r.hash, r.signature, key.publicKeyPem)) return 'signature';
    if (r.signature && key && r.keyId !== key.keyId) return 'signature';
    return null;
}

/** The verdict on a chain, given oldest first. */
export function verifyReceipts(receipts: StoredReceipt[], key: { keyId: string; publicKeyPem: string } | null): ChainVerdict {
    let prevHash = '';
    let unsigned = 0;
    for (const [i, r] of receipts.entries()) {
        const kind = problemOf(r, i + 1, prevHash, key);
        if (kind) return { ok: false, count: receipts.length, problem: { seq: r.seq, kind }, unsigned, head: null };
        if (!r.signature) unsigned += 1;
        prevHash = r.hash;
    }
    const last = receipts.at(-1);
    return { ok: true, count: receipts.length, problem: null, unsigned, head: last ? { seq: last.seq, hash: last.hash } : null };
}
