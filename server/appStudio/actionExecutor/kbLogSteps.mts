/**
 * kb_log_query / kb_log_review: the KB query log as App Studio steps (an app as the work queue
 * of a knowledge base's quality review).
 *
 * The rules live in core/kb/queryLog/builderSteps.mts (shared with the automation step):
 * licence, the app OWNER and the VIEWER must both manage the knowledge base. A public
 * (anonymous) run never reaches this module: routes/studioAppPublic.js refuses both kinds.
 * app_run_action's dry run runs the read and skips the review (mcpRunActionPolicy.mts); a
 * `ctx.dryRun` is honoured here too, as a second line.
 */

import { createRequire } from 'node:module';
import { listQueryLog, reviewQueryLog } from '../../core/kb/queryLog/builderSteps.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Helpers = { resolveBinding: (b: unknown, ctx: Obj, scope: unknown) => unknown; buildServerScope: (ctx: Obj) => unknown };
type Fail = { ok: false; error: string; code: string; retryable: boolean };

/** Resolve a binding, or a plain value a hand-written definition carries instead of one. */
function value(h: Helpers, b: unknown, ctx: Obj, scope: unknown): unknown {
    if (b && typeof b === 'object' && typeof (b as Obj).kind === 'string') return h.resolveBinding(b, ctx, scope);
    return b;
}

function helpers(): Helpers { return nodeRequire('./shared') as Helpers; }

const fail = (r: { error: string; code: string }): Fail => ({ ok: false, error: r.error, code: r.code, retryable: false });

export async function kbLogQueryStep(app: Obj, _model: unknown, step: Obj, ctx: Obj) {
    const h = helpers();
    const scope = h.buildServerScope(ctx);
    const filters: Obj = {};
    if (step.filters && typeof step.filters === 'object') {
        for (const [k, b] of Object.entries(step.filters as Obj)) filters[k] = value(h, b, ctx, scope);
    }
    const out = await listQueryLog(
        { kbId: value(h, step.kbId, ctx, scope), filters, limit: step.limit, detail: step.resultDetail },
        { ownerId: app.userId as string, viewerId: (ctx.viewerId as string | null | undefined) ?? null },
    );
    return out.ok ? { ok: true, result: out.result } : fail(out);
}

export async function kbLogReviewStep(app: Obj, _model: unknown, step: Obj, ctx: Obj) {
    const h = helpers();
    const scope = h.buildServerScope(ctx);
    const viewerId = (ctx.viewerId as string | null | undefined) ?? null;
    const out = await reviewQueryLog(
        {
            kbId: value(h, step.kbId, ctx, scope), entryId: value(h, step.entryId, ctx, scope),
            status: value(h, step.status, ctx, scope), note: value(h, step.note, ctx, scope),
        },
        { ownerId: app.userId as string, viewerId, reviewerId: viewerId, dryRun: ctx.dryRun === true },
    );
    return out.ok ? { ok: true, result: out.result } : fail(out);
}
