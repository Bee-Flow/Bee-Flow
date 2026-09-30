/**
 * ISO 27001 clauses 6.2, 9 and 10 (web: pages/AuditsPage + audits/*, four
 * tabs): internal audits with findings, management reviews,
 * nonconformities and objectives.
 *
 * Server: routes/compliance/isoProcess.js — CreateAudit / AuditPatch /
 * FindingBody, ReviewBody, CreateNc / NcPatch, CreateObjective /
 * ObjectivePatch (all `.strict()`). The NC store COALESCEs, so an emptied
 * field is left as it was rather than cleared. A management review snapshots the auto-built agenda
 * (`mr_inputs` from GET /iso/audit) as its `inputs`, as the web does.
 */

import { AUDIT_STATUSES, FINDING_SEVERITIES, NC_SEVERITIES, NC_SOURCES, NC_STATUSES, OBJECTIVE_STATUSES } from './choices';
import { createBody } from './fields';
import { COMPLIANCE, seg, str } from './paths';
import type { ActionSpec, FieldSpec, Rec, RecordType, WriteRequest } from './types';
import { readAuditBundle } from '../api/readersRegisters';

const AUDIT_PATH = `${COMPLIANCE}/iso/audit`;
const put = (base: string, rec: Rec, body: Record<string, unknown>): WriteRequest => ({ method: 'PUT', path: `${COMPLIANCE}/iso/${base}/${seg(rec.id)}`, body });
export const owner = (i18nKey: string): FieldSpec => ({ key: 'owner_user_id', label: { i18nKey, en: 'Owner' }, kind: 'user' });

/** A button that moves a row to `status` while it is in `from`. */
function step(base: string, label: ActionSpec['label'], move: readonly [from: string, to: string], extra: Record<string, unknown> = {}): ActionSpec {
    const [from, status] = move;
    return { id: `${from}-${status}`, label, icon: 'ArrowRight', when: (r) => r.status === from, request: (r) => put(base, r, { status, ...extra }) };
}

// ── Internal audits ─────────────────────────────────────────────────────

const AUDIT_FIELDS: readonly FieldSpec[] = [
    { key: 'title', label: { i18nKey: 'compliance.audit_f_title', en: 'Audit title' }, kind: 'text', required: true },
    { key: 'scope_note', label: { i18nKey: 'compliance.audit_f_scope', en: 'Scope' }, kind: 'multiline', placeholder: { i18nKey: 'compliance.audit_f_scope_ph', en: 'Which controls, processes or teams does this audit cover?' } },
    { key: 'auditor_user_id', label: { i18nKey: 'compliance.audit_f_auditor', en: 'Auditor' }, kind: 'user' },
    { key: 'planned_at', label: { i18nKey: 'compliance.audit_f_planned', en: 'Planned date' }, kind: 'date' },
];

const FINDING_FIELDS: readonly FieldSpec[] = [
    { key: 'description', label: { i18nKey: 'compliance.audit_f_finding', en: 'What was observed' }, kind: 'multiline', required: true },
    { key: 'severity', label: { i18nKey: 'compliance.audit_f_severity', en: 'Severity' }, kind: 'choice', options: FINDING_SEVERITIES, initial: 'observation' },
    { key: 'control_ref', label: { i18nKey: 'compliance.audit_f_control', en: 'Control ref' }, kind: 'text' },
    { key: 'clause', label: { i18nKey: 'compliance.audit_f_clause', en: 'Clause' }, kind: 'text' },
    { key: 'evidence_ref', label: { i18nKey: 'compliance.audit_f_evidence', en: 'Evidence ref (optional)' }, kind: 'text' },
];

const AUDIT_STATUS: FieldSpec = { key: 'status', label: { i18nKey: 'compliance.risk_col_status', en: 'Status' }, kind: 'choice', options: AUDIT_STATUSES };

export const AUDITS: RecordType = {
    id: 'audits',
    section: 'audits',
    noun: { i18nKey: 'compliance.audit_tab', en: 'Internal audits' },
    plural: { i18nKey: 'compliance.audit_tab', en: 'Internal audits' },
    icon: 'FileSearch',
    intro: { i18nKey: 'compliance.audit_subtitle', en: 'Plan and run internal audits (clause 9.2). Record what was examined and what was found.' },
    list: {
        paths: [AUDIT_PATH],
        select: ([raw]) => {
            const b = readAuditBundle(raw);
            return { rows: b.audits.map((a) => ({ ...a, findings: b.findings.filter((f) => f.audit_id === a.id) })), context: null };
        },
    },
    idOf: (r) => str(r.id),
    titleOf: (r) => str(r.title),
    meta: ['planned_at', 'auditor_user_id'],
    status: { key: 'status', options: AUDIT_STATUSES },
    facts: [
        ...AUDIT_FIELDS.slice(1),
        { key: 'started_at', label: { i18nKey: 'compliance.audit_started_on', en: 'Started' }, kind: 'date' },
        { key: 'closed_at', label: { i18nKey: 'compliance.audit_closed_on', en: 'Closed' }, kind: 'date' },
    ],
    search: ['scope_note'],
    empty: { title: { i18nKey: 'compliance.audit_empty_title', en: 'No internal audits yet' } },
    create: {
        label: { i18nKey: 'compliance.audit_plan', en: 'Plan audit' },
        fields: AUDIT_FIELDS,
        request: (v) => ({ method: 'POST', path: `${COMPLIANCE}/iso/audits`, body: createBody(AUDIT_FIELDS, v) }),
    },
    edit: { fields: [...AUDIT_FIELDS, AUDIT_STATUS], request: (r, body) => put('audits', r, body) },
    actions: [
        step('audits', { i18nKey: 'compliance.audit_start', en: 'Start audit' }, ['planned', 'in_progress']),
        step('audits', { i18nKey: 'compliance.audit_close', en: 'Close audit' }, ['in_progress', 'closed']),
        {
            id: 'finding',
            label: { i18nKey: 'compliance.audit_add_finding', en: 'Add finding' },
            icon: 'Plus',
            fields: FINDING_FIELDS,
            request: (r, v) => ({ method: 'POST', path: `${COMPLIANCE}/iso/audits/${seg(r.id)}/findings`, body: createBody(FINDING_FIELDS, v) }),
        },
    ],
    related: {
        key: 'findings',
        title: { i18nKey: 'compliance.audit_findings', en: 'Findings' },
        empty: { i18nKey: 'compliance.audit_no_findings', en: 'No findings recorded for this audit.' },
        titleOf: (item) => str(item.description),
        fields: FINDING_FIELDS.slice(1, 4),
    },
};

// ── Management reviews ──────────────────────────────────────────────────

const REVIEW_FIELDS: readonly FieldSpec[] = [
    { key: 'held_at', label: { i18nKey: 'compliance.mr_f_held', en: 'Held on' }, kind: 'date', required: true },
    { key: 'decisions', label: { i18nKey: 'compliance.mr_f_decisions', en: 'Decisions & actions (minutes)' }, kind: 'multiline', placeholder: { i18nKey: 'compliance.mr_f_decisions_ph', en: 'What did management decide? Resource changes, risk acceptances, improvement actions…' } },
    { key: 'minutes_evidence_ref', label: { i18nKey: 'compliance.audit_f_evidence', en: 'Evidence ref (optional)' }, kind: 'text' },
];

export const REVIEWS: RecordType = {
    id: 'reviews',
    section: 'audits',
    noun: { i18nKey: 'compliance.mr_tab', en: 'Management reviews' },
    plural: { i18nKey: 'compliance.mr_tab', en: 'Management reviews' },
    icon: 'Users',
    intro: { i18nKey: 'compliance.mr_minutes_note', en: 'Minutes are written by a person, never generated — the review is only worth what leadership actually decided.' },
    list: {
        paths: [AUDIT_PATH],
        select: ([raw]) => {
            const b = readAuditBundle(raw);
            return { rows: b.reviews, context: { mr_inputs: b.mr_inputs } };
        },
    },
    idOf: (r) => str(r.id),
    titleOf: (r, fmt) => fmt.date(r.held_at) ?? `#${str(r.id)}`,
    meta: ['decisions'],
    facts: REVIEW_FIELDS,
    search: ['decisions'],
    empty: { title: { i18nKey: 'compliance.mr_empty_title', en: 'No management reviews yet' } },
    create: {
        label: { i18nKey: 'compliance.mr_record', en: 'Record review' },
        fields: REVIEW_FIELDS,
        request: (v, ctx) => ({
            method: 'POST',
            path: `${COMPLIANCE}/iso/reviews`,
            body: { ...createBody(REVIEW_FIELDS, v), inputs: (ctx.context?.mr_inputs as Rec | null) ?? {} },
        }),
    },
};

// ── Nonconformities ─────────────────────────────────────────────────────

const NC_TITLE: FieldSpec = { key: 'title', label: { i18nKey: 'compliance.nc_f_title', en: 'Title' }, kind: 'text', required: true };
const NC_DESC: FieldSpec = { key: 'description', label: { i18nKey: 'compliance.nc_f_desc', en: 'Description' }, kind: 'multiline', placeholder: { i18nKey: 'compliance.nc_f_desc_ph', en: 'What is nonconforming, how was it detected, what is the impact?' } };
const NC_SEVERITY: FieldSpec = { key: 'severity', label: { i18nKey: 'compliance.nc_f_severity', en: 'Severity' }, kind: 'choice', options: NC_SEVERITIES, initial: 'minor' };
const NC_CA: FieldSpec = { key: 'corrective_action', label: { i18nKey: 'compliance.nc_f_corrective', en: 'Corrective action' }, kind: 'multiline', placeholder: { i18nKey: 'compliance.nc_f_corrective_ph', en: 'What is being done to remove the cause, not just the symptom?' } };
const NC_DUE: FieldSpec = { key: 'due_at', label: { i18nKey: 'compliance.nc_f_due', en: 'Corrective action due' }, kind: 'date' };
const NC_OWNER = owner('compliance.nc_f_owner');
const NC_SOURCE: FieldSpec = { key: 'source', label: { i18nKey: 'compliance.nc_col_source', en: 'Source' }, kind: 'choice', options: NC_SOURCES, initial: 'manual' };
const NC_CREATE_FIELDS: readonly FieldSpec[] = [NC_TITLE, NC_DESC, NC_SOURCE, NC_SEVERITY, NC_CA, NC_DUE, NC_OWNER];

export const NCS: RecordType = {
    id: 'ncs',
    section: 'audits',
    noun: { i18nKey: 'compliance.nc_tab', en: 'Nonconformities' },
    plural: { i18nKey: 'compliance.nc_tab', en: 'Nonconformities' },
    icon: 'TriangleAlert',
    intro: { i18nKey: 'compliance.nc_subtitle', en: 'Nonconformity register (clause 10): every deviation gets a corrective action, a due date and an effectiveness review.' },
    list: { paths: [AUDIT_PATH], select: ([raw]) => ({ rows: readAuditBundle(raw).ncs, context: null }) },
    idOf: (r) => str(r.id),
    titleOf: (r) => str(r.title),
    meta: ['severity', 'due_at'],
    status: { key: 'status', options: NC_STATUSES },
    facts: [
        NC_SEVERITY,
        NC_SOURCE,
        NC_OWNER,
        NC_DUE,
        { key: 'effectiveness_review_due_at', label: { i18nKey: 'compliance.nc_f_eff_due', en: 'Effectiveness review due' }, kind: 'date' },
        { key: 'closed_at', label: { i18nKey: 'compliance.nc_closed_on', en: 'Closed' }, kind: 'date' },
        NC_DESC,
        NC_CA,
    ],
    search: ['description', 'corrective_action'],
    empty: { title: { i18nKey: 'compliance.nc_empty_title', en: 'No nonconformities recorded' } },
    create: {
        label: { i18nKey: 'compliance.nc_record', en: 'Record nonconformity' },
        fields: NC_CREATE_FIELDS,
        request: (v) => ({ method: 'POST', path: `${COMPLIANCE}/iso/ncs`, body: createBody(NC_CREATE_FIELDS, v) }),
    },
    edit: {
        fields: [NC_TITLE, NC_DESC, NC_SEVERITY, NC_CA, NC_DUE, { key: 'effectiveness_review_due_at', label: { i18nKey: 'compliance.nc_f_eff_due', en: 'Effectiveness review due' }, kind: 'date' }, NC_OWNER],
        request: (r, body) => put('ncs', r, body),
    },
    actions: [
        step('ncs', { i18nKey: 'compliance.nc_start_ca', en: 'Start corrective action' }, ['open', 'corrective_action']),
        step('ncs', { i18nKey: 'compliance.nc_to_er', en: 'Move to effectiveness review' }, ['corrective_action', 'effectiveness_review']),
        {
            ...step('ncs', { i18nKey: 'compliance.nc_confirm_close', en: 'Confirm effectiveness & close' }, ['effectiveness_review', 'closed'], { confirm_effectiveness: true }),
            icon: 'CircleCheck',
            confirm: { i18nKey: 'compliance.nc_confirm_hint', en: 'Closing records you, by name, as the person who confirmed the corrective action actually worked.' },
        },
    ],
};

// ── Objectives ──────────────────────────────────────────────────────────

const OBJECTIVE_FIELDS: readonly FieldSpec[] = [
    { key: 'title', label: { i18nKey: 'compliance.obj_f_title', en: 'Objective' }, kind: 'text', required: true },
    { key: 'measure', label: { i18nKey: 'compliance.obj_f_measure', en: 'How it is measured' }, kind: 'text', placeholder: { i18nKey: 'compliance.obj_f_measure_ph', en: 'e.g. phishing-test click rate' } },
    { key: 'target', label: { i18nKey: 'compliance.obj_f_target', en: 'Target' }, kind: 'text', placeholder: { i18nKey: 'compliance.obj_f_target_ph', en: 'e.g. below 5%' } },
    { key: 'review_due_at', label: { i18nKey: 'compliance.obj_f_review', en: 'Next review' }, kind: 'date' },
    owner('compliance.obj_f_owner'),
];

export const OBJECTIVES: RecordType = {
    id: 'objectives',
    section: 'audits',
    noun: { i18nKey: 'compliance.obj_col_objective', en: 'Objective' },
    plural: { i18nKey: 'compliance.obj_tab', en: 'Objectives' },
    icon: 'Target',
    intro: { i18nKey: 'compliance.obj_subtitle', en: 'Security objectives (clause 6.2): measurable, owned and reviewed on a date — not aspirations.' },
    list: { paths: [AUDIT_PATH], select: ([raw]) => ({ rows: readAuditBundle(raw).objectives, context: null }) },
    idOf: (r) => str(r.id),
    titleOf: (r) => str(r.title),
    meta: ['target', 'review_due_at'],
    status: { key: 'status', options: OBJECTIVE_STATUSES },
    facts: OBJECTIVE_FIELDS.slice(1),
    search: ['measure', 'target'],
    empty: { title: { i18nKey: 'compliance.obj_empty_title', en: 'No security objectives yet' } },
    create: {
        label: { i18nKey: 'compliance.obj_add', en: 'Add objective' },
        fields: OBJECTIVE_FIELDS,
        request: (v) => ({ method: 'POST', path: `${COMPLIANCE}/iso/objectives`, body: createBody(OBJECTIVE_FIELDS, v) }),
    },
    edit: { fields: OBJECTIVE_FIELDS, request: (r, body) => put('objectives', r, body) },
    actions: [
        step('objectives', { i18nKey: 'compliance.obj_mark_achieved', en: 'Mark achieved' }, ['active', 'achieved']),
        step('objectives', { i18nKey: 'compliance.obj_mark_dropped', en: 'Drop' }, ['active', 'dropped']),
        step('objectives', { i18nKey: 'compliance.obj_reactivate', en: 'Reactivate' }, ['achieved', 'active']),
        step('objectives', { i18nKey: 'compliance.obj_reactivate', en: 'Reactivate' }, ['dropped', 'active']),
    ],
};
