/**
 * Contract readers for the checks, their per-subject trail and the frameworks
 * list (re-exported by hubReaders.ts). Verified against
 * server/routes/compliance/checks.js (_rowFromDef, _customRows,
 * _annotateProjectNames, /checks/:id/auto-fix), routes/compliance/evidence.js
 * and routes/compliance/frameworks.js (serialize, _customList, GET /frameworks).
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

const num = field.numOrNull;
const str = field.strOrNull;

function isObj(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A record of string values (project id → name); null when absent. */
function stringRecord(v: unknown): Record<string, string> | null {
    if (!isObj(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
    return out;
}

/** A record of numbers (a framework's `affects` counts); non-numbers dropped. */
function numberRecord(v: unknown): Record<string, number> | null {
    if (!isObj(v)) return null;
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v)) {
        const n = num(val);
        if (n !== null) out[k] = n;
    }
    return out;
}

/** An id the server may send as a number (BIGSERIAL) or a string. */
const idStr = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

const readFindingState = shapeOf({ state: str, reason: str, until: str, active: field.bool(false) });

const readCheckFrameworks = shapeListOf({ regulation: str, ref: str, framework_id: str });

/** GET /api/compliance/checks — one row per check (per scope for per-source checks). */
export const readCheckRows = shapeListOf({
    check_id: field.str(''),
    regulation: str,
    framework_id: str,
    framework_code: str,
    frameworks: readCheckFrameworks,
    article: str,
    severity: str,
    weight: num,
    verification: str,
    scope_id: str,
    titleKey: str,
    descriptionKey: str,
    remediationKey: str,
    remediationLink: str,
    title: str,
    description: str,
    autoFixId: str,
    status: field.str('pending'),
    details: str,
    run_at: str,
    evidence: field.recordOrNull,
    finding_state: (v: unknown) => (isObj(v) ? readFindingState(v) : null),
    project_names: stringRecord,
});
export type CheckRow = ReturnType<typeof readCheckRows>[number];

/** GET /api/compliance/checks/:id/history[?scope_id=] — status rows, newest first. */
export const readCheckHistoryRows = shapeListOf({
    status: field.str('pending'),
    details: str,
    run_at: str,
    run_type: str,
    scope_id: str,
});
export type CheckHistoryRow = ReturnType<typeof readCheckHistoryRows>[number];

/** GET /api/compliance/evidence/:checkId — the hash-chained evidence rows of one check. */
export const readEvidenceRows = shapeListOf({
    id: idStr,
    check_id: str,
    hash: str,
    seq: num,
    subject_type: str,
    subject_id: str,
    payload_hash: str,
    captured_at: str,
    payload: field.recordOrNull,
});
export type EvidenceRow = ReturnType<typeof readEvidenceRows>[number];

/** POST /api/compliance/checks/:id/auto-fix — `{ ok, result: { summary } }`. */
export function readAutoFixResult(raw: unknown): { ok: boolean; summary: string | null } {
    return { ok: pick(raw, 'ok') === true, summary: str(pick(pick(raw, 'result'), 'summary')) };
}
export type AutoFixResult = ReturnType<typeof readAutoFixResult>;

/** POST /api/compliance/checks/run — the score it ended on. */
export const readRunResult = shapeOf({
    ran: num,
    score: (v: unknown) => num(pick(v, 'score')),
});

const readPhases = shapeListOf({ date: str, label_key: str, label: str });

/** Only https links: a source is opened in the browser. */
const readSources = (v: unknown) =>
    shapeListOf({ label: str, url: str })(v).filter((s): s is { label: string | null; url: string } => typeof s.url === 'string' && s.url.startsWith('https://'));

const readLock = shapeOf({ feature: str, required: str, current: str, upgrade_url: str });

const readLegalReview = shapeOf({ verified_on: str, age_days: num, stale: field.bool(true), stale_after_days: num });

const readFramework = shapeOf({
    id: field.str(''),
    regulation: str,
    name_key: str,
    name: str,
    description_key: str,
    enabled: field.bool(false),
    core: field.bool(false),
    locked: str,
    lock: (v: unknown) => (isObj(v) ? readLock(v) : null),
    relevance: str,
    relevance_gate: field.bool(false),
    score: num,
    recently_in_force: field.bool(false),
    in_force_since: str,
    in_force_from: str,
    affects_key: str,
    affects: numberRecord,
    checks_count: num,
    registers: field.strArray,
    calendar_count: num,
    phases: readPhases,
    sources: readSources,
    legal_review: (v: unknown) => (isObj(v) ? readLegalReview(v) : null),
});
export type Framework = ReturnType<typeof readFramework>;

const readCustomFramework = shapeOf({
    id: field.str(''),
    code: str,
    name: str,
    status: str,
    score: num,
    checks_count: num,
    attested_count: num,
    enabled: field.bool(false),
    locked: str,
});
export type CustomFramework = ReturnType<typeof readCustomFramework>;

const readCatalogue = shapeOf({ verified_on: str, stale: field.bool(true) });

/** GET /api/compliance/frameworks — `{ frameworks, custom, catalogue }`. */
export const readFrameworkList = shapeOf({
    frameworks: field.list(readFramework),
    custom: field.list(readCustomFramework),
    catalogue: (v: unknown) => (isObj(v) ? readCatalogue(v) : null),
});
export type FrameworkList = ReturnType<typeof readFrameworkList>;
