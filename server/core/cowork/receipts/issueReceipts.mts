/**
 * Issuing Cowork run receipts (./receiptFacts.mts says what one holds, stores/coworkReceipts.mts keeps them): every
 * closed run of an item gets one, in the order the runs finished, each linked to the one before by hash and signed
 * with the installation's key (./receiptKey.mts).
 *
 * Issued apart from closing the run, so a receipt can never stop a run from closing: right after a run ends
 * (core/cowork/runEnded.mts), and by a sweep every few minutes that catches the runs no signal announced (one closed by
 * the reaper, a journey that ended after a decision, a replica that stopped in between). The item's chain lock makes
 * two replicas issue each receipt once.
 *
 * `start()` is called from boot (boot/startupJobs.js): requiring this module starts nothing.
 */

import { createRequire } from 'node:module';
import { hashPayload, linkHash } from './receiptHash.mts';
import { receiptFacts, type ReceiptPayload } from './receiptFacts.mts';
import { receiptKey, signHash, type ReceiptKey } from './receiptKey.mts';
import { onRunEnded } from '../runEnded.mts';
import type { ToolLookups } from '../plan/planTypes.mts';
import type { ChainTx, ReceiptPlan } from '../../../stores/coworkReceipts.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../../telemetry/log.js') as { warn: (m: string) => void };

const BATCH = 50;
const SWEEP_MS = 5 * 60_000;
const SWEEP_ITEMS = 200;

export interface IssueDeps {
    withChain: <T>(scheduleId: string, fn: (tx: ChainTx) => Promise<T>) => Promise<T>;
    planOf: (planId: string) => Promise<ReceiptPlan | null>;
    stepsOf: (automationRunId: string) => Promise<Array<{ stepId: string; stepType: string; succeeded: number }>>;
    itemsWithPending: (limit: number) => Promise<string[]>;
    signingKey: () => Promise<ReceiptKey | null>;
    lookups: ToolLookups;
}

const defaults = (): IssueDeps => {
    const store = (nodeRequire('../../../stores/coworkReceipts.mts') as typeof import('../../../stores/coworkReceipts.mts')).coworkReceipts();
    const { toolLookups } = nodeRequire('../plan/planLookups.mts') as typeof import('../plan/planLookups.mts');
    return {
        withChain: (id, fn) => store.withChain(id, fn),
        planOf: (id) => store.planOf(id),
        stepsOf: (id) => store.stepsOf(id),
        itemsWithPending: (limit) => store.itemsWithPending(limit),
        signingKey: () => receiptKey(),
        lookups: toolLookups(),
    };
};

/** The hashes and signature of the next receipt in a chain. */
export function sealReceipt(payload: ReceiptPayload, prevHash: string, key: ReceiptKey | null) {
    const payloadHash = hashPayload(payload);
    const hash = linkHash(prevHash, payloadHash);
    return { payloadHash, prevHash, hash, signature: key ? signHash(hash, key) : null, keyId: key?.keyId ?? null };
}

/** Issue the receipts an item's closed runs do not have yet. Answers how many were issued. */
export async function issueReceipts(scheduleId: string, deps: IssueDeps = defaults()): Promise<number> {
    const key = await deps.signingKey();
    return deps.withChain(scheduleId, async (tx) => {
        const runs = await tx.pending(BATCH);
        if (runs.length === 0) return 0;
        let head = await tx.head();
        for (const run of runs) {
            const plan = run.planId ? await deps.planOf(run.planId) : null;
            const steps = run.automationRunId ? await deps.stepsOf(run.automationRunId) : [];
            const payload = receiptFacts({ run, plan, steps, lookups: deps.lookups });
            const sealed = sealReceipt(payload, head?.hash ?? '', key);
            const seq = (head?.seq ?? 0) + 1;
            await tx.append(seq, { runId: run.id, payload: payload as unknown as Record<string, unknown>, ...sealed });
            head = { seq, hash: sealed.hash };
        }
        return runs.length;
    });
}

/** Issue, and log instead of throwing: a receipt that could not be issued now is issued by the next sweep. */
async function issueLater(scheduleId: string, deps?: IssueDeps): Promise<void> {
    try {
        await issueReceipts(scheduleId, deps);
    } catch (e) {
        log.warn(`[Cowork] receipts of ${scheduleId} were not issued now: ${(e as Error).message}`);
    }
}

/** One sweep over the items that have closed runs without a receipt. */
export async function sweepReceipts(deps: IssueDeps = defaults()): Promise<number> {
    let items: string[];
    try {
        items = await deps.itemsWithPending(SWEEP_ITEMS);
    } catch (e) {
        log.warn(`[Cowork] the receipt sweep could not list its items: ${(e as Error).message}`);
        return 0;
    }
    for (const id of items) await issueLater(id, deps);
    return items.length;
}

let stopListening: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Hear every run that ends, and sweep every few minutes. Answers false when already started. */
export function start(): boolean {
    if (stopListening) return false;
    stopListening = onRunEnded((item) => { setImmediate(() => { void issueLater(item.id); }); });
    timer = setInterval(() => { void sweepReceipts(); }, SWEEP_MS);
    timer.unref?.();
    return true;
}

/** Stop (shutdown, tests). */
export function stop(): void {
    stopListening?.();
    stopListening = null;
    if (timer) clearInterval(timer);
    timer = null;
}
