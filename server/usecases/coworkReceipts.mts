/**
 * An item's run receipts, for its owner (routes/coworkReceiptRoutes.js): the chain with its verdict
 * (core/cowork/receipts/verifyReceipts.mts), one run's receipt, and the installation's public key so a receipt can be
 * checked outside Bee Flow. A closed run that still has no receipt after the sweep had its chance shows as missing:
 * the chain alone cannot show a receipt that was never issued.
 */

import { createRequire } from 'node:module';
import { verifyReceipts, type ChainVerdict } from '../core/cowork/receipts/verifyReceipts.mts';
import { receiptKey, verifyHash, type ReceiptKey } from '../core/cowork/receipts/receiptKey.mts';
import type { StoredReceipt } from '../stores/coworkReceipts.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item { id: string; userId: string }

export interface ReceiptsDeps {
    listReceipts: (scheduleId: string) => Promise<StoredReceipt[]>;
    receiptOfRun: (scheduleId: string, runId: string) => Promise<StoredReceipt | null>;
    countMissing: (scheduleId: string, before: Date) => Promise<number>;
    signingKey: () => Promise<ReceiptKey | null>;
}

const defaults = (): ReceiptsDeps => {
    const store = () => (nodeRequire('../stores/coworkReceipts.mts') as typeof import('../stores/coworkReceipts.mts')).coworkReceipts();
    return {
        listReceipts: (id) => store().listReceipts(id),
        receiptOfRun: (id, runId) => store().receiptOfRun(id, runId),
        countMissing: (id, before) => store().countMissing(id, before),
        signingKey: () => receiptKey(),
    };
};

/** How long after it closed a run may still be waiting for its receipt (the sweep runs every five minutes). */
export const GRACE_MS = 15 * 60_000;

export interface ReceiptLine { seq: number; runId: string; at: string | null; status: unknown; kind: unknown; signed: boolean; payload: Record<string, unknown> }
export interface ReceiptsView { verdict: ChainVerdict; missingRuns: number; keyId: string | null; receipts: ReceiptLine[] }

const publicOf = (key: ReceiptKey | null) => (key ? { keyId: key.keyId, publicKeyPem: key.publicKeyPem } : null);

function lineOf(r: StoredReceipt, key: ReceiptKey | null): ReceiptLine {
    const signed = !!(r.signature && key && r.keyId === key.keyId && verifyHash(r.hash, r.signature, key.publicKeyPem));
    return { seq: r.seq, runId: r.runId, at: r.createdAt, status: r.payload.status, kind: r.payload.kind, signed, payload: r.payload };
}

/** The item's chain, newest first, with the verdict over all of it. */
export async function receiptsOf(item: Item, now: Date = new Date(), deps: ReceiptsDeps = defaults()): Promise<ReceiptsView> {
    const [receipts, key, missingRuns] = await Promise.all([deps.listReceipts(item.id), deps.signingKey(), deps.countMissing(item.id, new Date(now.getTime() - GRACE_MS))]);
    const verdict = verifyReceipts(receipts, publicOf(key));
    return { verdict, missingRuns, keyId: key?.keyId ?? null, receipts: receipts.map((r) => lineOf(r, key)).reverse() };
}

/** One run's receipt, or 404 when it has none (yet). */
export async function receiptOfRun(item: Item, runId: string, deps: ReceiptsDeps = defaults()): Promise<ReceiptLine> {
    const [receipt, key] = await Promise.all([deps.receiptOfRun(item.id, runId), deps.signingKey()]);
    if (!receipt) throw new HttpError(404, 'cowork_receipt_missing', 'This run has no receipt yet.');
    return lineOf(receipt, key);
}

/** The installation's public key, for checking a receipt elsewhere; null when receipts are not signed. */
export async function publicReceiptKey(deps: Pick<ReceiptsDeps, 'signingKey'> = defaults()): Promise<{ keyId: string; publicKeyPem: string; algorithm: 'Ed25519' } | null> {
    const key = publicOf(await deps.signingKey());
    return key ? { ...key, algorithm: 'Ed25519' } : null;
}
