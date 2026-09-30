/**
 * The ISO 27001 registers a CISO keeps: risks (clause 6.1.2/6.1.3), the
 * Statement of Applicability (93 Annex A controls) and the ISMS policy set.
 * Web: pages/RisksPage + risks/*, pages/SoaPage + soa/*, pages/PoliciesPage +
 * policies/PolicyDrawer.
 *
 * Server: routes/compliance/isoProcess.js (CreateRisk / RiskPatch /
 * TreatmentBody), isoSoa.js (SoaPatch — the allow-list, `.strict()`),
 * isoDocs.js (DocPatch: title, body, owner_user_id, review_due_at) and the
 * PDFs in isoAuditPack.js / isoStatements.js.
 */

import { POLICY_STATUSES, RISK_CATEGORIES, RISK_STATUSES, SCALE, SOA_DECISIONS, SOA_THEMES, TREATMENT_OPTIONS } from './choices';
import { choiceOf, createBody, labelText } from './fields';
import { COMPLIANCE, seg, str } from './paths';
import type { FieldSpec, RecordType } from './types';
import { readPolicyBundle, readPolicyDoc, readRiskBundle, readSoaControls } from '../api/readersRegisters';

const OWNER: FieldSpec = { key: 'owner_user_id', label: { i18nKey: 'compliance.risk_f_owner', en: 'Owner' }, kind: 'user' };
const SEEDED = { i18nKey: 'mobile.compliance.seeded', en: 'Suggested items added — review each one before you rely on it' };
const pdf = (path: string, fileName: string) => ({ path: `${COMPLIANCE}${path}`, fileName, mimeType: 'application/pdf' });

// ── Risks ───────────────────────────────────────────────────────────────

const RISK_TITLE: FieldSpec = { key: 'title', label: { i18nKey: 'compliance.risk_f_title', en: 'Title' }, kind: 'text', required: true };
const RISK_DESC: FieldSpec = {
    key: 'description',
    label: { i18nKey: 'compliance.risk_f_desc', en: 'Description' },
    kind: 'multiline',
    placeholder: { i18nKey: 'compliance.risk_f_desc_ph', en: 'What could go wrong, and what would the consequence be?' },
};
const RISK_CATEGORY: FieldSpec = { key: 'category', label: { i18nKey: 'compliance.risk_f_category', en: 'Category' }, kind: 'choice', options: RISK_CATEGORIES };
const LIKELIHOOD: FieldSpec = { key: 'likelihood', label: { i18nKey: 'compliance.risk_f_likelihood', en: 'Likelihood (1–5)' }, kind: 'choice', options: SCALE, numeric: true, initial: '3' };
const IMPACT: FieldSpec = { key: 'impact', label: { i18nKey: 'compliance.risk_f_impact', en: 'Impact (1–5)' }, kind: 'choice', options: SCALE, numeric: true, initial: '3' };
const RISK_REVIEW: FieldSpec = { key: 'review_due_at', label: { i18nKey: 'compliance.risk_f_review_due', en: 'Next review' }, kind: 'date' };
const RISK_STATUS: FieldSpec = { key: 'status', label: { i18nKey: 'compliance.risk_col_status', en: 'Status' }, kind: 'choice', options: RISK_STATUSES };
const RISK_FIELDS = [RISK_TITLE, RISK_DESC, RISK_CATEGORY, LIKELIHOOD, IMPACT, OWNER, RISK_REVIEW];

const TREATMENT_FIELDS: readonly FieldSpec[] = [
    { key: 'option', label: { i18nKey: 'compliance.risk_t_option', en: 'Treatment' }, kind: 'choice', options: TREATMENT_OPTIONS, initial: 'mitigate', required: true },
    { key: 'description', label: { i18nKey: 'compliance.risk_t_desc', en: 'What will be done' }, kind: 'multiline' },
    { key: 'due_at', label: { i18nKey: 'compliance.risk_t_due', en: 'Due' }, kind: 'date' },
    OWNER,
];

export const RISKS: RecordType = {
    id: 'risks',
    section: 'risks',
    noun: { i18nKey: 'compliance.risk_drawer_aria', en: 'Risk' },
    plural: { i18nKey: 'compliance.rail_risks', en: 'Risk register' },
    icon: 'TriangleAlert',
    intro: { i18nKey: 'compliance.risk_create_hint', en: 'Score likelihood × impact on 1–5; the treatment decision comes after, in the drawer.' },
    list: {
        paths: [`${COMPLIANCE}/iso/risks`],
        select: ([raw]) => {
            const bundle = readRiskBundle(raw);
            return { rows: bundle.risks.map((r) => ({ ...r, treatments: bundle.treatments.filter((t) => t.risk_id === r.id) })), context: null };
        },
    },
    idOf: (r) => str(r.id),
    titleOf: (r) => str(r.title),
    meta: ['score', 'category', 'review_due_at'],
    status: { key: 'status', options: RISK_STATUSES },
    facts: [
        { key: 'score', label: { i18nKey: 'compliance.risk_col_score', en: 'Score' }, kind: 'number' },
        RISK_CATEGORY,
        LIKELIHOOD,
        IMPACT,
        OWNER,
        RISK_REVIEW,
        { key: 'accepted_at', label: { i18nKey: 'compliance.risk_acceptance', en: 'Acceptance' }, kind: 'date' },
        RISK_DESC,
    ],
    search: ['description', 'category'],
    empty: {
        title: { i18nKey: 'compliance.risk_empty_title', en: 'No risks in the register yet' },
        message: { i18nKey: 'compliance.risk_seed_hint', en: 'Adds common AI-workspace risk scenarios that are not in your register yet — never duplicates and never overwrites entries you edited.' },
    },
    create: {
        label: { i18nKey: 'compliance.risk_add', en: 'Add risk' },
        fields: RISK_FIELDS,
        request: (values) => ({ method: 'POST', path: `${COMPLIANCE}/iso/risks`, body: createBody(RISK_FIELDS, values) }),
    },
    edit: {
        fields: [...RISK_FIELDS, RISK_STATUS],
        request: (r, body) => ({ method: 'PUT', path: `${COMPLIANCE}/iso/risks/${seg(r.id)}`, body }),
    },
    actions: [
        {
            id: 'accept',
            label: { i18nKey: 'compliance.risk_accept_button', en: 'Accept risk' },
            icon: 'Check',
            when: (r) => r.status !== 'accepted' && r.status !== 'closed',
            confirm: { i18nKey: 'compliance.risk_accept_note', en: 'Accepting is a management decision: it records who accepted this risk and when. Nothing is ever accepted automatically.' },
            request: (r) => ({ method: 'PUT', path: `${COMPLIANCE}/iso/risks/${seg(r.id)}`, body: { status: 'accepted' } }),
        },
        {
            id: 'treatment',
            label: { i18nKey: 'compliance.risk_t_add', en: 'Add treatment' },
            icon: 'Plus',
            fields: TREATMENT_FIELDS,
            request: (r, v) => ({ method: 'POST', path: `${COMPLIANCE}/iso/risks/${seg(r.id)}/treatments`, body: createBody(TREATMENT_FIELDS, v) }),
        },
    ],
    listActions: [
        { id: 'seed', label: { i18nKey: 'compliance.risk_seed_button', en: 'Seed suggested risks' }, icon: 'Sparkles', request: () => ({ method: 'POST', path: `${COMPLIANCE}/iso/risks/seed`, body: {} }), success: SEEDED },
        { id: 'pdf', label: { i18nKey: 'compliance.ovw_dl_risks', en: 'Risk register (PDF)' }, icon: 'FileDown', download: pdf('/iso/risks.pdf', 'risks.pdf') },
    ],
    related: {
        key: 'treatments',
        title: { i18nKey: 'compliance.risk_treatments', en: 'Treatment plan' },
        empty: { i18nKey: 'compliance.risk_no_treatments', en: 'No treatments recorded yet.' },
        titleOf: (item, fmt) => {
            const option = choiceOf(TREATMENT_OPTIONS, item.option);
            return option ? labelText(option.label, fmt.t) : str(item.option);
        },
        fields: [TREATMENT_FIELDS[1] as FieldSpec, TREATMENT_FIELDS[2] as FieldSpec, { key: 'done_at', label: { i18nKey: 'mobile.compliance.done_at', en: 'Done on' }, kind: 'date' }],
    },
};

// ── Statement of Applicability ──────────────────────────────────────────

const SOA_FIELDS: readonly FieldSpec[] = [
    { key: 'applicable', label: { i18nKey: 'compliance.soa_applicable', en: 'This control applies to us' }, kind: 'bool', initial: true },
    {
        key: 'justification',
        label: { i18nKey: 'compliance.soa_justification', en: 'Justification' },
        kind: 'multiline',
        placeholder: { i18nKey: 'compliance.soa_justification_ph2', en: 'Why this control does or does not apply to you…' },
    },
    {
        key: 'how_met',
        label: { i18nKey: 'compliance.soa_how_met', en: 'How met' },
        kind: 'multiline',
        placeholder: { i18nKey: 'compliance.soa_how_met_ph', en: 'How this control is satisfied — the sentence an auditor reads…' },
    },
    { key: 'status', label: { i18nKey: 'compliance.soa_col_status', en: 'Decision' }, kind: 'choice', options: SOA_DECISIONS },
    { ...OWNER, label: { i18nKey: 'compliance.soa_col_owner', en: 'Owner' } },
    { key: 'evidence_ref', label: { i18nKey: 'compliance.audit_f_evidence', en: 'Evidence ref (optional)' }, kind: 'text' },
];

export const SOA: RecordType = {
    id: 'soa',
    section: 'soa',
    noun: { i18nKey: 'compliance.soa_drawer_aria', en: 'SoA control' },
    plural: { i18nKey: 'compliance.rail_soa', en: 'SoA (Annex A)' },
    icon: 'ListChecks',
    intro: { i18nKey: 'compliance.soa_stamp_hint', en: 'Every change is stamped with who and when and travels into the SoA PDF.' },
    list: { paths: [`${COMPLIANCE}/iso/soa`], select: ([raw]) => ({ rows: readSoaControls(raw), context: null }) },
    idOf: (r) => str(r.ref),
    titleOf: (r, fmt) => `${str(r.ref)} · ${r.titleKey ? fmt.t(str(r.titleKey), str(r.ref)) : ''}`,
    meta: ['theme', 'owner_user_id'],
    status: { key: 'status', options: SOA_DECISIONS },
    facts: [{ key: 'theme', label: { i18nKey: 'compliance.soa_theme_label', en: 'Theme' }, kind: 'choice', options: SOA_THEMES }, ...SOA_FIELDS, { key: 'updated_at', label: { i18nKey: 'compliance.soa_hist_col_when', en: 'When' }, kind: 'date' }],
    search: ['ref', 'justification', 'how_met'],
    empty: { title: { i18nKey: 'compliance.soa_empty_title', en: 'No controls match' } },
    edit: {
        fields: SOA_FIELDS,
        request: (r, body) => ({ method: 'PUT', path: `${COMPLIANCE}/iso/soa/${seg(r.ref)}`, body }),
    },
    actions: [
        {
            id: 'approve',
            label: { i18nKey: 'compliance.soa_decision_approved', en: 'Approved' },
            icon: 'CircleCheck',
            when: (r) => r.status !== 'approved',
            request: (r) => ({ method: 'PUT', path: `${COMPLIANCE}/iso/soa/${seg(r.ref)}`, body: { status: 'approved' } }),
        },
    ],
    listActions: [
        {
            id: 'seed',
            label: { i18nKey: 'mobile.compliance.soa_seed', en: 'Fill missing rows' },
            icon: 'Sparkles',
            when: (set) => set.rows.some((r) => r.seeded === false),
            request: () => ({ method: 'POST', path: `${COMPLIANCE}/iso/soa/seed`, body: {} }),
            success: SEEDED,
        },
        { id: 'pdf', label: { i18nKey: 'compliance.soa_export_pdf', en: 'SoA (PDF)' }, icon: 'FileDown', download: pdf('/iso/soa.pdf', 'soa.pdf') },
    ],
};

// ── Policies ────────────────────────────────────────────────────────────

const POLICY_FIELDS: readonly FieldSpec[] = [
    { key: 'title', label: { i18nKey: 'compliance.policies_title_label', en: 'Title' }, kind: 'text', required: true },
    { key: 'draft_body', body: 'body', label: { i18nKey: 'compliance.policies_body_label', en: 'Document (markdown)' }, kind: 'multiline' },
    { ...OWNER, label: { i18nKey: 'compliance.policies_owner', en: 'Owner' } },
    { key: 'review_due_at', label: { i18nKey: 'compliance.policies_review_due', en: 'Review due' }, kind: 'date' },
];

export const POLICIES: RecordType = {
    id: 'policies',
    section: 'policies',
    noun: { i18nKey: 'compliance.policies_col_slug', en: 'Document' },
    plural: { i18nKey: 'compliance.rail_policies', en: 'Policies' },
    icon: 'ScrollText',
    intro: { i18nKey: 'compliance.policies_intro', en: 'Your ISMS policies. A published version is frozen and sha256-stamped; members acknowledge that exact version.' },
    list: {
        paths: [`${COMPLIANCE}/iso/docs`],
        select: ([raw]) => {
            const bundle = readPolicyBundle(raw);
            return { rows: bundle.documents, context: { missing: bundle.missing_seeds.length } };
        },
    },
    detail: { path: (slug) => `${COMPLIANCE}/iso/docs/${seg(slug)}`, select: readPolicyDoc },
    idOf: (r) => str(r.slug),
    titleOf: (r) => str(r.title) || str(r.slug),
    meta: ['current_version', 'review_due_at'],
    status: { key: 'status', options: POLICY_STATUSES },
    facts: [{ key: 'current_version', label: { i18nKey: 'mobile.compliance.policy_version', en: 'Published version' }, kind: 'number' }, ...POLICY_FIELDS.slice(2), POLICY_FIELDS[1] as FieldSpec],
    search: ['slug'],
    empty: { title: { i18nKey: 'compliance.policies_empty_title', en: 'No policy documents yet' }, message: { i18nKey: 'compliance.policies_empty', en: 'No policy documents yet — seed the templates to get started.' } },
    edit: {
        fields: POLICY_FIELDS,
        request: (r, body) => ({ method: 'PUT', path: `${COMPLIANCE}/iso/docs/${seg(r.slug)}`, body }),
    },
    actions: [
        {
            id: 'publish',
            label: { i18nKey: 'compliance.policies_publish', en: 'Publish' },
            icon: 'Send',
            confirm: { i18nKey: 'compliance.policies_publish_hint', en: 'Freezes the current draft as a new version that members acknowledge' },
            request: (r) => ({ method: 'POST', path: `${COMPLIANCE}/iso/docs/${seg(r.slug)}/publish`, body: {} }),
            success: { i18nKey: 'mobile.compliance.published', en: 'Published — members can now acknowledge it' },
        },
    ],
    listActions: [
        {
            id: 'seed',
            label: { i18nKey: 'compliance.policies_seed_button', en: 'Seed policy templates' },
            icon: 'Sparkles',
            when: (set) => Number(set.context?.missing ?? 0) > 0,
            request: () => ({ method: 'POST', path: `${COMPLIANCE}/iso/docs/seed`, body: {} }),
            success: SEEDED,
        },
        { id: 'pdf', label: { i18nKey: 'compliance.ovw_dl_policies', en: 'Policy pack (PDF)' }, icon: 'FileDown', download: pdf('/iso/policy-pack.pdf', 'policy-pack.pdf') },
    ],
};
