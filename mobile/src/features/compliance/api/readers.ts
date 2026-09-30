/**
 * Contract readers for the hub's aggregate reads: counts, attention,
 * deadlines, checks, frameworks, the member directory, a check's history and
 * evidence. The register rows are in readersRegisters.ts.
 *
 * Verified against server/routes/compliance/{counts,attention,deadlines,
 * checks,frameworks,orgUsers,evidence}.js and compliance/{attention,deadlines}.js.
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import { emptyCounts, type ComplianceCounts } from '../model/counts';

const num = field.numOrNull;

function obj(raw: unknown, key: string): unknown {
    const v = pick(raw, key);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function scores(raw: unknown): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    const fws = obj(raw, 'frameworks');
    if (!fws) return out;
    for (const [id, entry] of Object.entries(fws as Record<string, unknown>)) out[id] = num(pick(entry, 'score'));
    return out;
}

function pair<T>(raw: unknown, key: string, read: (o: unknown) => T | null): T | null {
    const o = obj(raw, key);
    return o ? read(o) : null;
}

/** GET /api/compliance/counts — every key optional, never a 0 the server did not say. */
export function readCounts(raw: unknown): ComplianceCounts {
    const base = emptyCounts();
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base;
    const summary = obj(raw, 'frameworks_summary');
    const onboarded = pick(raw, 'onboarded');
    return {
        attentionOpen: num(pick(raw, 'attention_open')),
        lastRunAt: field.strOrNull(pick(obj(raw, 'last_run'), 'at')),
        scores: scores(raw),
        candidates: num(pick(summary, 'candidates')),
        recentlyInForce: num(pick(summary, 'recently_in_force')),
        dsr: pair(raw, 'dsr', (o) => { const open = num(pick(o, 'open')); return open === null ? null : { open, overdue: num(pick(o, 'overdue')) }; }),
        incidents: pair(raw, 'incidents', (o) => {
            const open = num(pick(o, 'open'));
            return open === null ? null : { open, hoursLeft: num(pick(o, 'hours_left')), vulnerabilitiesOpen: num(pick(o, 'vulnerabilities_open')) };
        }),
        ropaReviewedAt: field.strOrNull(pick(obj(raw, 'ropa'), 'last_reviewed_at')),
        dpiaTodo: num(pick(obj(raw, 'dpia'), 'todo')),
        risks: pair(raw, 'risks', (o) => { const total = num(pick(o, 'total')); return total === null ? null : { total, high: num(pick(o, 'high')) }; }),
        soa: pair(raw, 'soa', (o) => { const a = num(pick(o, 'approved')); const t = num(pick(o, 'total')); return a === null || t === null ? null : { approved: a, total: t }; }),
        policies: pair(raw, 'policies', (o) => { const total = num(pick(o, 'total')); return total === null ? null : { total, reviewDue: num(pick(o, 'review_due')) }; }),
        auditsPlanned: num(pick(obj(raw, 'audits'), 'planned')),
        training: pair(raw, 'training', (o) => { const d = num(pick(o, 'done')); const t = num(pick(o, 'total')); return d === null || t === null ? null : { done: d, total: t }; }),
        connectors: pair(raw, 'connectors', (o) => { const count = num(pick(o, 'count')); return count === null ? null : { count, nextSweepAt: field.strOrNull(pick(o, 'next_sweep_at')) }; }),
        onboarded: typeof onboarded === 'boolean' ? onboarded : base.onboarded,
    };
}

const readFrameworkRef = shapeListOf({ regulation: field.strOrNull, ref: field.strOrNull });

const readAttentionItem = shapeOf({
    id: field.str(''),
    source: field.str('check'),
    code: field.strOrNull,
    status: field.str('warn'),
    severity: field.strOrNull,
    title: field.str(''),
    meta: (v: unknown) => ({ frameworks: readFrameworkRef(pick(v, 'frameworks')), verification: field.strOrNull(pick(v, 'verification')) }),
    action: (v: unknown) => ({ type: field.strOrNull(pick(v, 'type')), target: field.strOrNull(pick(v, 'target')) }),
});
export type AttentionItem = ReturnType<typeof readAttentionItem>;

/** GET /api/compliance/attention — `{ items, total, complete }`. */
export const readAttention = shapeOf({
    items: field.list(readAttentionItem),
    total: field.numOrNull,
    complete: field.bool(true),
});

const readDeadline = shapeOf({
    id: field.str(''),
    kind: field.strOrNull,
    ref: field.strOrNull,
    title: field.strOrNull,
    due_at: field.strOrNull,
    state: field.str('none'),
    meta: (v: unknown) => ({ article: field.strOrNull(pick(v, 'article')) }),
    target: (v: unknown) => ({ section: field.strOrNull(pick(v, 'section')), id: field.strOrNull(pick(v, 'id')) }),
});
export type DeadlineItem = ReturnType<typeof readDeadline>;

/** GET /api/compliance/deadlines — `{ items, empty_kinds, complete }`. */
export const readDeadlines = shapeOf({ items: field.list(readDeadline), complete: field.bool(true) });

/** GET /api/compliance/checks — one row per check (per scope for per-source checks). */
export const readChecks = shapeListOf({
    check_id: field.str(''),
    regulation: field.strOrNull,
    framework_id: field.strOrNull,
    article: field.strOrNull,
    severity: field.strOrNull,
    verification: field.strOrNull,
    scope_id: field.strOrNull,
    titleKey: field.strOrNull,
    descriptionKey: field.strOrNull,
    remediationKey: field.strOrNull,
    title: field.strOrNull,
    description: field.strOrNull,
    autoFixId: field.strOrNull,
    status: field.str('pending'),
    details: field.strOrNull,
    run_at: field.strOrNull,
    evidence: field.recordOrNull,
});
export type CheckRow = ReturnType<typeof readChecks>[number];

const readFramework = shapeOf({
    id: field.str(''),
    regulation: field.strOrNull,
    name_key: field.strOrNull,
    name: field.strOrNull,
    description_key: field.strOrNull,
    enabled: field.bool(false),
    core: field.bool(false),
    locked: field.strOrNull,
    relevance: field.strOrNull,
    score: field.numOrNull,
    recently_in_force: field.bool(false),
    in_force_since: field.strOrNull,
});
export type Framework = ReturnType<typeof readFramework>;

/** GET /api/compliance/frameworks — `{ frameworks, custom }`. */
export const readFrameworks = shapeOf({ frameworks: field.list(readFramework), custom: field.list(readFramework) });

/** GET /api/compliance/org-users — the directory behind the owner pickers. */
export const readOrgUsers = shapeListOf({ id: field.str(''), displayName: field.str(''), orgRole: field.strOrNull });
export type OrgUser = ReturnType<typeof readOrgUsers>[number];

/** GET /api/compliance/checks/:id/history — status rows, newest first. */
export const readCheckHistory = shapeListOf({
    status: field.str('pending'),
    details: field.strOrNull,
    run_at: field.strOrNull,
    run_type: field.strOrNull,
    scope_id: field.strOrNull,
});

/** GET /api/compliance/evidence/:checkId — the hashed evidence rows of one check. */
export const readEvidence = shapeListOf({
    id: (v: unknown) => (v === null || v === undefined ? '' : String(v)),
    hash: field.strOrNull,
    captured_at: field.strOrNull,
    subject_type: field.strOrNull,
    payload: field.recordOrNull,
});

/** POST /api/compliance/checks/run — the score it ended on. */
export const readRunResult = shapeOf({
    ran: field.numOrNull,
    score: (v: unknown) => field.numOrNull(pick(v, 'score')),
});

/** POST /api/compliance/iso/evidence/upload — `{ uploaded, sha256, filename }`. */
export const readUpload = shapeOf({ uploaded: field.bool(false), sha256: field.strOrNull, filename: field.strOrNull });
