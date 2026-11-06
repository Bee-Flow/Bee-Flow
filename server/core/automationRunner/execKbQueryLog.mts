/**
 * `kb_query_log`: read or review the query log of a knowledge base (Enterprise, licence feature
 * `kb_query_log`). `op: 'list'` returns { rows, total, count }; `op: 'review'` sets the review
 * status and note of one entry.
 *
 * The rules (licence, the automation OWNER must manage the knowledge base) live in
 * core/kb/queryLog/builderSteps.mts and are checked on every run, not trusted from the definition:
 * the owner's rights can be taken away after the automation was saved. A refusal is a SKIP with the
 * reason on the row (amber), the output keeps its bindable keys so a branch on `rows` still works.
 *
 * A dry run reads (that is the preview), but never writes the review.
 */

import { createRequire } from 'node:module';
import { listQueryLog, reviewQueryLog } from '../kb/queryLog/builderSteps.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, any>;

export const KB_QUERY_LOG_OPS = ['list', 'review'] as const;

function skipped(op: string, reason: string, message: string, extra: Obj = {}) {
    const base = op === 'review' ? { updated: false, entryId: null, status: null } : { rows: [], total: 0, count: 0 };
    return { output: { ...base, ...extra, skipped: message }, skippedReason: reason };
}

export async function execKbQueryLog(step: Obj, ctx: Obj, runState: Obj, mode: string) {
    const { resolveValue, interpolateTemplate } = nodeRequire('../automationModel/bind');
    // No secret reaches a log query or a note: the same emptied state knowledge_write reads.
    const safeState = { ...runState, secrets: {} };
    const resolve = (v: unknown): unknown => {
        if (v === undefined || v === null) return null;
        if (typeof v === 'string') return interpolateTemplate(v, safeState);
        return resolveValue(v, safeState, { allowSecrets: false });
    };
    const op = step.op === 'review' ? 'review' : 'list';
    const kbId = resolve(step.knowledgeBaseId);
    if (!kbId) return skipped(op, 'kb_query_log_no_kb', 'This step has no knowledge base to read.');
    const scope = { ownerId: ctx.userId as string | null };

    let out;
    if (op === 'list') {
        const filters: Obj = {};
        for (const [k, v] of Object.entries((step.filters && typeof step.filters === 'object' ? step.filters : {}) as Obj)) filters[k] = resolve(v);
        out = await listQueryLog({ kbId, filters, limit: step.limit, detail: step.resultDetail }, scope);
    } else {
        out = await reviewQueryLog(
            { kbId, entryId: resolve(step.entryId), status: resolve(step.status), note: resolve(step.note) },
            { ...scope, reviewerId: ctx.userId as string | null, dryRun: mode === 'dry_run' },
        );
    }
    if (!out.ok) return skipped(op, out.code, out.error, { knowledgeBaseId: kbId });
    const result = { ...out.result, knowledgeBaseId: kbId };
    return mode === 'dry_run' && op === 'review' ? { output: { ...result, wouldUpdate: (out.result as Obj).wouldUpdate }, dryRunSynthesised: true } : { output: result };
}
