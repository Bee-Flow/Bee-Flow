/**
 * Contract readers for the hub's shared reads, with every field the hub's
 * screens use: the counts, the attention list and the deadlines here; the
 * checks, their trail and the frameworks in hubReadersChecks.ts. These
 * replace the hub part of readers.ts (removed once nothing reads it).
 *
 * Verified against server/routes/compliance/counts.js, compliance/attention.js
 * and compliance/deadlines.js. A missing value is null, never an invented 0.
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type { ComplianceCounts } from '../model/counts';
import { emptyCounts } from '../model/counts';
import { parseTarget, type Target } from '../model/navigation';

export {
    readAutoFixResult,
    readCheckHistoryRows,
    readCheckRows,
    readEvidenceRows,
    readFrameworkList,
    readRunResult,
    type AutoFixResult,
    type CheckHistoryRow,
    type CheckRow,
    type CustomFramework,
    type EvidenceRow,
    type Framework,
    type FrameworkList,
} from './hubReadersChecks';

const num = field.numOrNull;
const str = field.strOrNull;

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

/** The nested object when `first` is a number, else null (an omitted key stays omitted). */
function when<T>(raw: unknown, key: string, first: string, read: (o: unknown, n: number) => T): T | null {
    const o = obj(raw, key);
    const n = o ? num(pick(o, first)) : null;
    return o && n !== null ? read(o, n) : null;
}

export interface EvidenceChain {
    rows: number | null;
    chainOk: boolean;
    algorithm: string | null;
    checkedRows: number | null;
}

export interface HubCounts extends ComplianceCounts {
    lastRunIntervalHours: number | null;
    frameworksActive: number | null;
    frameworksLocked: number | null;
    dsrDueSoon: number | null;
    incidentsNextDeadlineAt: string | null;
    incidentsNextStage: string | null;
    soaTodo: number | null;
    /** Null when the server omitted the key (chain not provisioned): show no footer. */
    evidence: EvidenceChain | null;
    /** The next setup tile (1-based); null once onboarded. */
    setupStep: number | null;
}

function baseCounts(raw: unknown): ComplianceCounts {
    const summary = obj(raw, 'frameworks_summary');
    const onboarded = pick(raw, 'onboarded');
    return {
        attentionOpen: num(pick(raw, 'attention_open')),
        lastRunAt: str(pick(obj(raw, 'last_run'), 'at')),
        scores: scores(raw),
        candidates: num(pick(summary, 'candidates')),
        recentlyInForce: num(pick(summary, 'recently_in_force')),
        dsr: when(raw, 'dsr', 'open', (o, open) => ({ open, overdue: num(pick(o, 'overdue')) })),
        incidents: when(raw, 'incidents', 'open', (o, open) => ({ open, hoursLeft: num(pick(o, 'hours_left')), vulnerabilitiesOpen: num(pick(o, 'vulnerabilities_open')) })),
        ropaReviewedAt: str(pick(obj(raw, 'ropa'), 'last_reviewed_at')),
        dpiaTodo: num(pick(obj(raw, 'dpia'), 'todo')),
        risks: when(raw, 'risks', 'total', (o, total) => ({ total, high: num(pick(o, 'high')) })),
        soa: when(raw, 'soa', 'approved', (o, approved) => { const total = num(pick(o, 'total')); return total === null ? null : { approved, total }; }),
        policies: when(raw, 'policies', 'total', (o, total) => ({ total, reviewDue: num(pick(o, 'review_due')) })),
        auditsPlanned: num(pick(obj(raw, 'audits'), 'planned')),
        training: when(raw, 'training', 'done', (o, done) => { const total = num(pick(o, 'total')); return total === null ? null : { done, total }; }),
        connectors: when(raw, 'connectors', 'count', (o, count) => ({ count, nextSweepAt: str(pick(o, 'next_sweep_at')) })),
        onboarded: typeof onboarded === 'boolean' ? onboarded : emptyCounts().onboarded,
    };
}

function evidenceChain(raw: unknown): EvidenceChain | null {
    const o = obj(raw, 'evidence');
    if (!o) return null;
    return { rows: num(pick(o, 'rows')), chainOk: pick(o, 'chain_ok') === true, algorithm: str(pick(o, 'algorithm')), checkedRows: num(pick(o, 'checked_rows')) };
}

/** GET /api/compliance/counts — every key optional, never a 0 the server did not say. */
export function readHubCounts(raw: unknown): HubCounts {
    const isObj = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
    const src = isObj ? raw : {};
    const summary = obj(src, 'frameworks_summary');
    const incidents = obj(src, 'incidents');
    return {
        ...(isObj ? baseCounts(src) : emptyCounts()),
        lastRunIntervalHours: num(pick(obj(src, 'last_run'), 'interval_hours')),
        frameworksActive: num(pick(summary, 'active')),
        frameworksLocked: num(pick(summary, 'locked')),
        dsrDueSoon: num(pick(obj(src, 'dsr'), 'due_soon')),
        incidentsNextDeadlineAt: str(pick(incidents, 'next_deadline_at')),
        incidentsNextStage: str(pick(incidents, 'next_stage')),
        soaTodo: num(pick(obj(src, 'soa'), 'todo')),
        evidence: evidenceChain(src),
        setupStep: num(pick(src, 'setup_step')),
    };
}

const readFrameworkRefs = shapeListOf({ regulation: str, ref: str });

const readAttentionMeta = shapeOf({
    frameworks: (v: unknown) => readFrameworkRefs(v),
    verification: str,
    detail: str,
    subject_count: num,
    link: str,
    severity: str,
    scope_id: str,
});

const readAttentionAction = shapeOf({ type: str, target: str, label_key: str, count: num });

const readAttentionItem = shapeOf({
    id: field.str(''),
    source: field.str('check'),
    section: str,
    code: str,
    status: field.str('warn'),
    severity: str,
    title: field.str(''),
    meta: readAttentionMeta,
    action: readAttentionAction,
});
export type AttentionItem = ReturnType<typeof readAttentionItem>;

/** GET /api/compliance/attention?limit=50 — `{ items, total, complete }`. */
export const readAttentionList = shapeOf({
    items: field.list(readAttentionItem),
    total: num,
    complete: field.bool(true),
});
export type AttentionList = ReturnType<typeof readAttentionList>;

/** The raw path of a deadline target (deadlines.js mints strings), or null. */
function targetPath(v: unknown): string | null {
    return typeof v === 'string' && v ? v : null;
}

const readDeadlineBase = shapeOf({
    id: field.str(''),
    kind: str,
    ref: str,
    title: str,
    due_at: str,
    started_at: str,
    state: field.str('none'),
    pct: num,
    meta: (v: unknown) => ({ article: str(pick(v, 'article')) }),
});

/** One deadline; the server's target path parsed into a Target, the raw path kept. */
function readDeadlineItem(row: unknown): ReturnType<typeof readDeadlineBase> & { target: Target | null; target_path: string | null } {
    const target = pick(row, 'target');
    return { ...readDeadlineBase(row), target: parseTarget(target), target_path: targetPath(target) };
}
export type DeadlineItem = ReturnType<typeof readDeadlineItem>;

/** GET /api/compliance/deadlines — `{ items, empty_kinds, complete }`. */
export const readDeadlineList = shapeOf({
    items: (v: unknown) => (Array.isArray(v) ? v.filter((row) => row !== null && typeof row === 'object').map(readDeadlineItem) : []),
    empty_kinds: field.strArray,
    complete: field.bool(true),
});
export type DeadlineList = ReturnType<typeof readDeadlineList>;
