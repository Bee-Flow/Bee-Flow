/**
 * The two framework sections that are registers, not checks tables:
 * own frameworks (web: pages/CustomFrameworksPage + custom/*) and the
 * Machinery Regulation's safety-component declarations (web:
 * pages/MachineryPage). Both attest with an outcome, a statement and
 * evidence files uploaded through POST /iso/evidence/upload.
 *
 * Server: routes/compliance/customFrameworks.js (FrameworkBody /
 * FrameworkPatch / ChecksBody / AttestBody, all `.strict()`; DELETE archives)
 * and routes/compliance/machinery.js (AttestBody: `outcome` is the
 * classification). Both sit behind their own capability
 * (compliance_hub_custom, compliance_hub_machinery) and answer 403 without it.
 */

import { CUSTOM_OUTCOMES, CUSTOM_STATUSES, INCIDENT_SEVERITIES, MACHINERY_CLASSES } from './choices';
import { choiceOf, createBody, labelText } from './fields';
import { COMPLIANCE, seg, str } from './paths';
import type { FieldSpec, FormValues, RecordType } from './types';
import { readAttestations, readCustomFramework, readCustomFrameworks, readMachinery } from '../api/readersRegisters';

// ── Own frameworks ──────────────────────────────────────────────────────

const NAME: FieldSpec = {
    key: 'name',
    label: { i18nKey: 'compliance.custom_field_name', en: 'Name' },
    kind: 'text',
    required: true,
    placeholder: { i18nKey: 'compliance.custom_field_name_ph', en: 'Customer NIS2 questionnaire 2026' },
};
const CODE: FieldSpec = { key: 'code', label: { i18nKey: 'compliance.custom_field_code', en: 'Code' }, kind: 'text', hint: { i18nKey: 'compliance.custom_field_code_hint', en: 'capitals, digits and _ — fixed once saved' } };
const REFERENCE: FieldSpec = { key: 'reference', label: { i18nKey: 'compliance.custom_field_reference', en: 'Reference' }, kind: 'text', hint: { i18nKey: 'compliance.custom_field_reference_hint', en: 'the standard or contract this comes from' } };
const DESCRIPTION: FieldSpec = { key: 'description', label: { i18nKey: 'compliance.custom_field_description', en: 'Description' }, kind: 'multiline' };
const MONTHS: FieldSpec = {
    key: 'attestation_valid_months',
    label: { i18nKey: 'compliance.custom_field_months', en: 'Attestation valid for' },
    kind: 'number',
    initial: '12',
    hint: { i18nKey: 'compliance.custom_field_months_hint', en: 'after this, an item asks to be attested again' },
};
const STATUS: FieldSpec = {
    key: 'status',
    label: { i18nKey: 'compliance.custom_field_status', en: 'Status' },
    kind: 'choice',
    options: CUSTOM_STATUSES,
    initial: 'draft',
    hint: { i18nKey: 'compliance.custom_field_status_hint', en: 'only an active framework is scored' },
};
const CREATE_FIELDS = [NAME, CODE, REFERENCE, DESCRIPTION, MONTHS, STATUS];

const CHECK_FIELDS: readonly FieldSpec[] = [
    { key: 'ref', label: { i18nKey: 'compliance.custom_col_ref', en: 'Ref' }, kind: 'text', required: true },
    { key: 'title', label: { i18nKey: 'compliance.custom_col_title', en: 'Item' }, kind: 'text', required: true },
    { key: 'description', label: { i18nKey: 'compliance.custom_field_description', en: 'Description' }, kind: 'multiline' },
    { key: 'severity', label: { i18nKey: 'compliance.custom_col_severity', en: 'Severity' }, kind: 'choice', options: INCIDENT_SEVERITIES, initial: 'medium' },
    { key: 'evidence_required', label: { i18nKey: 'compliance.custom_attest_evidence_required', en: 'required for this item' }, kind: 'bool' },
];

/** POST /custom/frameworks/:id/checks takes an ARRAY of rows (an upsert by ref). */
export function checkRows(values: FormValues): Record<string, unknown>[] {
    const row = createBody(CHECK_FIELDS, values);
    row.evidence_required = values.evidence_required === true;
    return [row];
}

export const CUSTOM: RecordType = {
    id: 'custom',
    section: 'custom',
    noun: { i18nKey: 'compliance.custom_edit_title', en: 'Edit framework' },
    plural: { i18nKey: 'compliance.rail_custom', en: 'Own frameworks' },
    icon: 'Kanban',
    intro: { i18nKey: 'compliance.custom_intro', en: 'A customer questionnaire, a sector code or an internal standard: attest the items yourself.' },
    list: { paths: [`${COMPLIANCE}/custom/frameworks`], select: ([raw]) => ({ rows: readCustomFrameworks(raw), context: null }) },
    detail: { path: (id) => `${COMPLIANCE}/custom/frameworks/${seg(id)}`, select: readCustomFramework },
    idOf: (r) => str(r.id),
    titleOf: (r) => str(r.name),
    meta: ['code', 'reference'],
    status: { key: 'status', options: CUSTOM_STATUSES },
    facts: [CODE, REFERENCE, MONTHS, DESCRIPTION],
    search: ['code', 'reference'],
    empty: { title: { i18nKey: 'compliance.custom_new_title', en: 'New framework' }, message: { i18nKey: 'compliance.custom_empty', en: 'No own frameworks yet. Start with the questionnaire a customer last sent you.' } },
    create: {
        label: { i18nKey: 'compliance.custom_new', en: 'New framework' },
        fields: CREATE_FIELDS,
        request: (v) => ({ method: 'POST', path: `${COMPLIANCE}/custom/frameworks`, body: createBody(CREATE_FIELDS, v) }),
    },
    edit: {
        fields: [NAME, REFERENCE, DESCRIPTION, MONTHS, STATUS],
        request: (r, body) => ({ method: 'PUT', path: `${COMPLIANCE}/custom/frameworks/${seg(r.id)}`, body }),
    },
    remove: {
        confirm: { i18nKey: 'compliance.custom_archive', en: 'Archive' },
        request: (r) => ({ method: 'DELETE', path: `${COMPLIANCE}/custom/frameworks/${seg(r.id)}` }),
    },
    actions: [
        {
            id: 'add_check',
            label: { i18nKey: 'mobile.compliance.custom_add_item', en: 'Add item' },
            icon: 'Plus',
            fields: CHECK_FIELDS,
            request: (r, v) => ({ method: 'POST', path: `${COMPLIANCE}/custom/frameworks/${seg(r.id)}/checks`, body: checkRows(v) }),
        },
        {
            id: 'export',
            label: { i18nKey: 'compliance.custom_export', en: 'Answer pack (JSON)' },
            icon: 'FileDown',
            download: (r) => ({ path: `${COMPLIANCE}/custom/frameworks/${seg(r.id)}/export.json`, fileName: `custom-framework-${str(r.code) || str(r.id)}.json`, mimeType: 'application/json' }),
        },
    ],
    related: {
        key: 'checks',
        title: { i18nKey: 'compliance.custom_checks_aria', en: 'Framework items' },
        empty: { i18nKey: 'compliance.custom_checks_empty_title', en: 'No items yet' },
        titleOf: (item) => `${str(item.ref)} · ${str(item.title)}`,
        fields: [CHECK_FIELDS[3] as FieldSpec, CHECK_FIELDS[4] as FieldSpec],
        actions: [
            {
                id: 'attest',
                label: { i18nKey: 'compliance.custom_attest', en: 'Attest' },
                icon: 'BadgeCheck',
                attest: {
                    outcomes: CUSTOM_OUTCOMES,
                    path: (item) => `${COMPLIANCE}/custom/checks/${seg(item.id)}/attest`,
                    subjectType: 'custom_check',
                    evidenceRequired: (item) => item.evidence_required === true,
                },
                success: { i18nKey: 'mobile.compliance.attested', en: 'Attestation recorded' },
            },
            {
                id: 'delete_check',
                label: { i18nKey: 'common.delete', en: 'Delete' },
                icon: 'Trash2',
                danger: true,
                confirm: { i18nKey: 'mobile.compliance.custom_delete_item', en: 'Delete this item? Its earlier attestations stay in the evidence chain.' },
                request: (item) => ({ method: 'DELETE', path: `${COMPLIANCE}/custom/checks/${seg(item.id)}` }),
            },
        ],
    },
};

// ── Machinery Regulation ────────────────────────────────────────────────

const SUBJECT = (id: unknown) => `${COMPLIANCE}/machinery/subjects/${seg(id)}`;

export const MACHINERY: RecordType = {
    id: 'machinery',
    section: 'machinery',
    noun: { i18nKey: 'compliance.mach_col_subject', en: 'Integration' },
    plural: { i18nKey: 'compliance.rail_machinery', en: 'Machinery Regulation' },
    icon: 'Wrench',
    intro: { i18nKey: 'compliance.mach_intro', en: 'Software that steers or monitors a safety function is a safety component from 20 January 2027.' },
    list: { paths: [`${COMPLIANCE}/machinery/detections`], select: ([raw]) => ({ rows: readMachinery(raw), context: null }) },
    idOf: (r) => str(r.subject_id),
    titleOf: (r) => str(r.label),
    meta: ['source', 'confidence'],
    status: { key: 'classification', options: MACHINERY_CLASSES },
    facts: [
        { key: 'source', label: { i18nKey: 'compliance.mach_col_signals', en: 'Signals' }, kind: 'text' },
        { key: 'confidence', label: { i18nKey: 'compliance.mach_col_confidence', en: 'Confidence' }, kind: 'text' },
        { key: 'classification', label: { i18nKey: 'compliance.mach_col_assessment', en: 'Declaration' }, kind: 'choice', options: MACHINERY_CLASSES },
        { key: 'attested_at', label: { i18nKey: 'compliance.mach_col_valid', en: 'Valid' }, kind: 'date' },
    ],
    empty: { title: { i18nKey: 'compliance.mach_empty_title', en: 'No machine integrations found' }, message: { i18nKey: 'compliance.mach_empty_desc', en: 'The scan found no OPC-UA, Modbus, MQTT, S7 or comparable signal in your integrations.' } },
    actions: [
        {
            id: 'declare',
            label: { i18nKey: 'compliance.mach_assess', en: 'Declare' },
            icon: 'BadgeCheck',
            attest: {
                outcomes: MACHINERY_CLASSES,
                path: (r) => `${SUBJECT(r.subject_id)}/attest`,
                subjectType: 'machinery_subject',
                subjectId: (r) => str(r.subject_id),
            },
            success: { i18nKey: 'mobile.compliance.attested', en: 'Attestation recorded' },
        },
    ],
    history: {
        title: { i18nKey: 'compliance.custom_attest_history', en: 'Earlier attestations' },
        path: (r) => `${SUBJECT(r.subject_id)}/attestations`,
        select: (raw, fmt) =>
            readAttestations(raw).map((a) => {
                const c = choiceOf(MACHINERY_CLASSES, a.classification);
                return { id: a.id, title: c ? labelText(c.label, fmt.t) : str(a.outcome), meta: [fmt.date(a.attested_at), a.statement].filter(Boolean).join(' · ') || null };
            }),
    },
};
