/**
 * builderSteps.mts: the KB query log as a builder step, shared by both runtimes.
 *
 * App Studio (`kb_log_query` / `kb_log_review`, appStudio/actionExecutor/kbLogSteps.mts) and
 * automations (`kb_query_log`, core/automationRunner/execKbQueryLog.mts) call the same two
 * functions, so the access rules cannot drift between them:
 *
 *   - the licence feature `kb_query_log` must be on for the knowledge base's organisation;
 *   - the OWNER of the app or automation must manage the knowledge base (canOwnerWriteToKb is the
 *     by-id twin of the KB routes' canManageKB: owner, or same org + manage_knowledge);
 *   - in Studio the VIEWER (the person pressing the button) must manage it too, so an app shared
 *     with readers never turns the owner's rights into theirs. Automations have no viewer.
 *
 * Every refusal is the same neutral sentence apart from the licence one, so the step cannot be
 * used to find out which knowledge bases exist.
 *
 * A dry run reads but never writes the review (`dryRun: true` on the review call).
 *
 * A list with `detail: 'full'` hands out question and answer text: like a page of the list route,
 * it is recorded in the access audit first (`kb.query_log.content_viewed`, the person pressing the
 * button, else the owner), and an audit that cannot be written is a refusal.
 */

import { createRequire } from 'node:module';
import { REVIEW_STATUSES, isChannel, isOutcome, isReviewStatus, type ReviewStatus } from './vocab.mts';
import type { EntryRow } from '../../../stores/kb/queryLog/index.mts';
import { summarise } from '../../../stores/kb/queryLog/redact.mts';
import { maskAsker, resolveAskerFilter } from './askers.mts';

export { redactLogStepOutput } from '../../../stores/kb/queryLog/redact.mts';

const nodeRequire = createRequire(import.meta.url);

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const MAX_NOTE_CHARS = 4000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LICENCE_FEATURE = 'kb_query_log';

export interface Filters { from?: unknown; to?: unknown; userId?: unknown; channel?: unknown; outcome?: unknown; status?: unknown }

/** The base as the steps need it; `query_log_show_names` decides whether askers are named or pseudonyms. */
export interface KbRef { id: string; organization_id?: string | null; query_log_show_names?: boolean | null }

export interface BuilderDeps {
    getKB: (kbId: string) => Promise<KbRef | null>;
    canManage: (kbId: string, userId: string) => Promise<{ ok: boolean }>;
    hasFeature: (scope: { organizationId?: string | null; userId?: string | null }, feature: string) => Promise<boolean>;
    store: {
        listEntries: (f: Record<string, unknown>) => Promise<{ rows: EntryRow[]; total: number }>;
        setReview: (kbId: string, id: string, p: { status: ReviewStatus; note?: string | null; reviewedBy: string }) => Promise<EntryRow | null>;
        askersOfKb: (kbId: string) => Promise<string[]>;
    };
    audit: (entry: { action: 'kb.query_log.content_viewed'; targetType: 'knowledge_base'; targetId: string; orgId: string | null; actorId: string; newValues: Record<string, unknown> }) => Promise<void>;
}

let overrides: Partial<BuilderDeps> | null = null;
/** Test seam: replace any dependency. `null` restores the real ones. */
export function _setBuilderDeps(o: Partial<BuilderDeps> | null): void { overrides = o; }

function deps(): BuilderDeps {
    const real: BuilderDeps = {
        getKB: (id) => nodeRequire('../../../stores/knowledgeBases').getKB(id),
        canManage: (kbId, userId) => nodeRequire('../kbWriteAccess.js').canOwnerWriteToKb(kbId, userId),
        hasFeature: (scope, feature) => nodeRequire('../../../license/index.js').hasFeature(scope, feature),
        store: nodeRequire('../../../stores/kb/queryLog/index.mts'),
        audit: (entry) => nodeRequire('../../../stores/kb/queryLog/audit.mts').recordKbQueryLogAudit(entry),
    };
    return { ...real, ...(overrides ?? {}) };
}

export type Refusal = { ok: false; error: string; code: string; status: number };
export type Granted = { ok: true; kb: KbRef };

const NOT_AVAILABLE = 'That knowledge base is not available here.';

function refuse(code: string, error: string, status = 403): Refusal { return { ok: false, error, code, status }; }

/** Owner and (when given) viewer must manage the KB, and its organisation must hold the licence. */
export async function checkBuilderAccess(kbId: unknown, ownerId: string | null | undefined, viewerId?: string | null): Promise<Granted | Refusal> {
    if (typeof kbId !== 'string' || !UUID_RE.test(kbId)) return refuse('kb_query_log_kb', 'Pick a knowledge base.', 400);
    if (!ownerId) return refuse('kb_query_log_denied', NOT_AVAILABLE);
    const d = deps();
    const kb = await d.getKB(kbId).catch(() => null);
    if (!kb) return refuse('kb_query_log_denied', NOT_AVAILABLE, 404);
    if (!(await d.canManage(kbId, ownerId)).ok) return refuse('kb_query_log_denied', NOT_AVAILABLE, 404);
    if (viewerId !== undefined) {
        if (!viewerId || !(await d.canManage(kbId, viewerId)).ok) return refuse('kb_query_log_denied', NOT_AVAILABLE, 404);
    }
    if (!(await d.hasFeature({ organizationId: kb.organization_id ?? null, userId: ownerId }, LICENCE_FEATURE))) {
        return refuse('kb_query_log_unlicensed', 'The KB query log is an Enterprise feature and is not enabled for this organisation.');
    }
    return { ok: true, kb };
}

export const clampLimit = (v: unknown): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
    return Math.min(Math.floor(n), MAX_LIMIT);
};

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const date = (v: unknown): string | null => {
    const t = text(v);
    return t && !Number.isNaN(new Date(t).getTime()) ? t : null;
};

/** Only the six documented filters pass; a value outside the vocabulary is an error, not an empty result. */
export function cleanFilters(raw: unknown): { filters: Record<string, string | null> } | { error: string } {
    const f = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Filters;
    const channel = text(f.channel), outcome = text(f.outcome), status = text(f.status);
    if (channel && !isChannel(channel)) return { error: `Unknown channel "${channel}".` };
    if (outcome && !isOutcome(outcome)) return { error: `Unknown outcome "${outcome}". Use answered, no_results or error.` };
    if (status && !isReviewStatus(status)) return { error: `Unknown status "${status}". Use ${REVIEW_STATUSES.join(', ')}.` };
    if (text(f.from) && !date(f.from)) return { error: 'filters.from is not a date.' };
    if (text(f.to) && !date(f.to)) return { error: 'filters.to is not a date.' };
    return { filters: { from: date(f.from), to: date(f.to), userId: text(f.userId), channel, outcome, status } };
}

export type ListInput = { kbId: unknown; filters?: unknown; limit?: unknown; detail?: unknown };
export type Scope = { ownerId: string | null | undefined; viewerId?: string | null };
export type StepOut = { ok: true; result: Record<string, unknown> } | Refusal;

export async function listQueryLog(input: ListInput, scope: Scope): Promise<StepOut> {
    const access = await checkBuilderAccess(input.kbId, scope.ownerId, scope.viewerId);
    if (!access.ok) return access;
    const cleaned = cleanFilters(input.filters);
    if ('error' in cleaned) return refuse('kb_query_log_filter', cleaned.error, 400);
    const limit = clampLimit(input.limit);
    const store = deps().store;
    // Without `show_names` the person filter takes a pseudonym id, and rows carry a pseudonym instead of the person.
    const userId = await resolveAskerFilter(cleaned.filters.userId, access.kb, (id) => store.askersOfKb(id));
    if (input.detail === 'full') {
        try {
            await deps().audit({
                action: 'kb.query_log.content_viewed', targetType: 'knowledge_base', targetId: access.kb.id, orgId: access.kb.organization_id ?? null,
                actorId: String(scope.viewerId || scope.ownerId), newValues: { filters: cleaned.filters, limit, detail: 'full', step: true },
            });
        } catch {
            return refuse('kb_query_log_audit_unavailable', 'This could not be recorded in the access audit, so the log was not read. Try again later.', 503);
        }
    }
    const { rows, total } = await store.listEntries({
        kbId: access.kb.id, orgId: access.kb.organization_id ?? null, ...cleaned.filters, userId, limit, offset: 0, includeContent: true,
    });
    const shown = rows.map((r) => maskAsker(r, access.kb));
    return { ok: true, result: { rows: input.detail === 'full' ? shown : shown.map((r) => summarise(r as EntryRow)), total, count: rows.length } };
}

export type ReviewInput = { kbId: unknown; entryId: unknown; status: unknown; note?: unknown };

/** `dryRun` checks everything and reports what would change; the row stays as it is. */
export async function reviewQueryLog(input: ReviewInput, scope: Scope & { reviewerId: string | null | undefined; dryRun?: boolean }): Promise<StepOut> {
    const access = await checkBuilderAccess(input.kbId, scope.ownerId, scope.viewerId);
    if (!access.ok) return access;
    if (typeof input.entryId !== 'string' || !UUID_RE.test(input.entryId)) return refuse('kb_query_log_entry', 'Pick a log entry.', 400);
    if (!isReviewStatus(input.status)) return refuse('kb_query_log_status', `status must be one of ${REVIEW_STATUSES.join(', ')}.`, 400);
    if (!scope.reviewerId) return refuse('kb_query_log_denied', NOT_AVAILABLE);
    const note = typeof input.note === 'string' ? input.note.slice(0, MAX_NOTE_CHARS) : null;
    if (scope.dryRun) {
        return { ok: true, result: { updated: false, wouldUpdate: { entryId: input.entryId, status: input.status, note } } };
    }
    const row = await deps().store.setReview(access.kb.id, input.entryId, { status: input.status, note, reviewedBy: scope.reviewerId });
    if (!row) return refuse('kb_query_log_entry', 'That log entry does not exist.', 404);
    return { ok: true, result: { updated: true, entryId: row.id, status: row.reviewStatus, note: row.reviewNote, reviewedAt: row.reviewedAt } };
}
