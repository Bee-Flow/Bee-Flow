/**
 * The incident register (web: pages/IncidentsPage + incidents/*): GDPR Art.
 * 33/34 breaches, and — with the CRA on — the vulnerability register. One
 * table, one `kind`; the buttons are the web drawer's, each shown only while
 * its stamp is still missing.
 *
 * Server: routes/compliance/incidents.js (CreateIncident / PatchIncident are
 * `.strict()`; `recipients_notified_at` is written only by notify-recipients).
 * The CRA report route takes `stage: early_warning | full`; the web drawer
 * posts `notification`/`final_report` there, which the schema refuses — the
 * phone sends `full`, the value the store stamps the final report with.
 */

import { INCIDENT_SEVERITIES, INCIDENT_STATUSES } from './choices';
import { createBody } from './fields';
import { COMPLIANCE, seg } from './paths';
import type { ActionSpec, FieldSpec, FormValues, Rec, RecordType, WriteRequest } from './types';
import { readIncidents } from '../api/readersRegisters';

const base = (rec: Rec) => `${COMPLIANCE}/incidents/${seg(rec.id)}`;
const open = (rec: Rec) => rec.status !== 'closed';
const patch = (rec: Rec, body: Record<string, unknown>): WriteRequest => ({ method: 'PATCH', path: base(rec), body });

const TITLE: FieldSpec = { key: 'title', label: { i18nKey: 'compliance.inc_f_title', en: 'What happened?' }, kind: 'text', required: true };
const DESCRIPTION: FieldSpec = {
    key: 'description',
    label: { i18nKey: 'compliance.inc_f_desc', en: 'Details' },
    kind: 'multiline',
    placeholder: { i18nKey: 'compliance.inc_f_desc_ph', en: 'What data, how many people, how discovered, first containment steps…' },
};
const SEVERITY: FieldSpec = { key: 'severity', label: { i18nKey: 'compliance.inc_f_severity', en: 'Severity' }, kind: 'choice', options: INCIDENT_SEVERITIES, initial: 'medium' };
const OCCURRED: FieldSpec = { key: 'occurred_at', label: { i18nKey: 'compliance.inc_f_occurred', en: 'Occurred at (if known)' }, kind: 'date' };
const HIGH_RISK: FieldSpec = { key: 'high_risk', label: { i18nKey: 'compliance.inc_f_high_risk', en: 'High risk for the people involved (triggers Art. 34)' }, kind: 'bool' };
const AUTHORITY_REF: FieldSpec = { key: 'authority_reference', label: { i18nKey: 'compliance.inc_authority_ref_ph', en: 'Authority case/reference number (optional)' }, kind: 'text' };
const CVE: FieldSpec = { key: 'cve_ids', label: { i18nKey: 'compliance.vuln_f_cve', en: 'CVE ids' }, kind: 'lines' };
const PRODUCTS: FieldSpec = { key: 'affected_products', label: { i18nKey: 'compliance.vuln_f_products', en: 'Affected products (one per line: name version-range)' }, kind: 'lines' };
const EXPLOITED: FieldSpec = { key: 'exploited_in_wild', label: { i18nKey: 'compliance.vuln_f_exploited', en: 'Actively exploited (CRA Art. 14(1) — report without delay)' }, kind: 'bool' };

const COMMON_FACTS: readonly FieldSpec[] = [
    SEVERITY,
    { key: 'detected_at', label: { i18nKey: 'compliance.inc_detected', en: 'Detected' }, kind: 'date' },
    { key: 'deadline_at', label: { i18nKey: 'compliance.inc_col_clock', en: 'Deadline' }, kind: 'date' },
    OCCURRED,
];

/** "CVE-2026-1, cve-2026-2" → deduped upper-case ids (web: incidentClocks.parseCveIds). */
export function parseCveIds(text: unknown): string[] {
    const out: string[] = [];
    for (const raw of String(text ?? '').split(/[\s,;]+/)) {
        const id = raw.trim().toUpperCase();
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

/** "name version-range" lines → `{ name, version_range }` rows. */
export function parseProducts(text: unknown): { name: string; version_range?: string }[] {
    return String(text ?? '')
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => {
            const [name = '', ...rest] = line.split(/\s+/);
            const range = rest.join(' ');
            return range ? { name, version_range: range } : { name };
        });
}

/** The create body: the web's createBodyOf allow-list. */
export function incidentCreateBody(values: FormValues, kind: 'breach' | 'vulnerability'): Record<string, unknown> {
    const body: Record<string, unknown> = { kind, ...createBody([TITLE, DESCRIPTION, SEVERITY, OCCURRED], values) };
    if (kind === 'vulnerability') {
        body.cve_ids = parseCveIds(values.cve_ids);
        body.exploited_in_wild = values.exploited_in_wild === true;
        const products = parseProducts(values.affected_products);
        if (products.length) body.affected_products = products;
    } else {
        body.high_risk = values.high_risk === true;
    }
    return body;
}

const SHARED_ACTIONS: readonly ActionSpec[] = [
    {
        id: 'assess',
        label: { i18nKey: 'compliance.inc_start_assess', en: 'Start assessment' },
        icon: 'Play',
        when: (r) => r.status === 'open',
        request: (r) => patch(r, { status: 'assessing' }),
    },
    {
        id: 'notify',
        label: { i18nKey: 'compliance.inc_notify_recipients', en: 'Notify breach recipients' },
        icon: 'Mail',
        when: (r) => open(r) && !r.recipients_notified_at,
        request: (r) => ({ method: 'POST', path: `${base(r)}/notify-recipients`, body: {} }),
        success: { i18nKey: 'mobile.compliance.recipients_notified', en: 'Breach recipients notified' },
    },
];

const CLOSE: ActionSpec = {
    id: 'close',
    label: { i18nKey: 'compliance.inc_close', en: 'Close incident' },
    icon: 'CircleCheck',
    when: open,
    request: (r, _v, ctx) => patch(r, { status: 'closed', note: ctx.t('compliance.inc_closed_note', 'Closed after assessment.') }),
};

const BREACH_ACTIONS: readonly ActionSpec[] = [
    ...SHARED_ACTIONS,
    {
        id: 'authority',
        label: { i18nKey: 'compliance.inc_record_authority', en: 'Record authority notification' },
        icon: 'Landmark',
        when: (r) => open(r) && !r.authority_notified_at,
        fields: [AUTHORITY_REF],
        request: (r, v) => patch(r, { status: 'authority_notified', ...createBody([AUTHORITY_REF], v) }),
    },
    {
        id: 'subjects',
        label: { i18nKey: 'compliance.inc_record_subjects', en: 'Record data-subject notification' },
        icon: 'Users',
        when: (r) => open(r) && r.high_risk === true && !r.subjects_notified_at,
        request: (r) => patch(r, { status: 'subjects_notified' }),
    },
    CLOSE,
];

const CRA_FIELDS: readonly FieldSpec[] = [
    { key: 'reported_via', label: { i18nKey: 'compliance.vuln_reported_via_ph', en: 'Reported via (ENISA platform, CSIRT…)' }, kind: 'text' },
    { key: 'reference', label: { i18nKey: 'compliance.vuln_reference_ph', en: 'Reference (optional)' }, kind: 'text' },
];

const craReport = (stage: 'early_warning' | 'full') => (r: Rec, v: FormValues): WriteRequest => ({
    method: 'POST',
    path: `${base(r)}/cra-report`,
    body: { stage, ...createBody(CRA_FIELDS, v) },
});

const VULN_ACTIONS: readonly ActionSpec[] = [
    ...SHARED_ACTIONS,
    {
        id: 'early_warning',
        label: { i18nKey: 'compliance.vuln_report_early', en: 'Report early warning' },
        icon: 'Siren',
        when: (r) => open(r) && !r.early_warning_sent_at,
        fields: CRA_FIELDS,
        request: craReport('early_warning'),
    },
    {
        id: 'full',
        label: { i18nKey: 'compliance.vuln_report_full', en: 'Report full' },
        icon: 'FileText',
        when: (r) => open(r) && Boolean(r.early_warning_sent_at) && !r.final_report_sent_at,
        fields: CRA_FIELDS,
        request: craReport('full'),
    },
    {
        id: 'customers',
        label: { i18nKey: 'compliance.vuln_customer_notified', en: 'Customer notified' },
        icon: 'Building2',
        when: (r) => open(r) && !r.customer_notified_at,
        request: (r) => ({ method: 'POST', path: `${base(r)}/customer-notified`, body: {} }),
    },
    CLOSE,
];

function incidentType(kind: 'breach' | 'vulnerability'): RecordType {
    const vuln = kind === 'vulnerability';
    const editFields = vuln ? [TITLE, DESCRIPTION, SEVERITY] : [TITLE, DESCRIPTION, SEVERITY, HIGH_RISK];
    return {
        id: vuln ? 'vulnerabilities' : 'incidents',
        section: vuln ? 'vulnerabilities' : 'incidents',
        noun: vuln ? { i18nKey: 'compliance.vuln_drawer_aria', en: 'Vulnerability' } : { i18nKey: 'compliance.inc_drawer_aria', en: 'Incident' },
        plural: vuln ? { i18nKey: 'compliance.rail_vulnerabilities', en: 'Vulnerability register' } : { i18nKey: 'compliance.rail_incidents', en: 'Incidents & breaches' },
        icon: vuln ? 'ShieldAlert' : 'Siren',
        intro: vuln
            ? { i18nKey: 'compliance.vuln_clock_hint', en: 'Recording starts the CRA Art. 14 clocks: early warning within 24 hours, notification within 72 hours, final report within 14 days.' }
            : { i18nKey: 'compliance.inc_subtitle', en: 'Record every (suspected) personal-data breach here. Detection starts the 72-hour Art. 33 clock for notifying the supervisory authority.' },
        list: {
            paths: [vuln ? `${COMPLIANCE}/incidents?kind=vulnerability` : `${COMPLIANCE}/incidents`],
            // The unfiltered list carries every kind; the breach register shows the rest.
            select: ([raw]) => ({ rows: readIncidents(raw).filter((r) => (r.kind === 'vulnerability') === vuln), context: null }),
        },
        idOf: (r) => String(r.id),
        titleOf: (r) => String(r.title || ''),
        meta: ['severity', 'detected_at'],
        status: { key: 'status', options: INCIDENT_STATUSES },
        facts: vuln
            ? [
                ...COMMON_FACTS,
                CVE,
                EXPLOITED,
                { key: 'early_warning_sent_at', label: { i18nKey: 'compliance.vuln_stamp_early_warning', en: 'Early warning' }, kind: 'date' },
                { key: 'final_report_sent_at', label: { i18nKey: 'compliance.vuln_stamp_full_report', en: 'Full report' }, kind: 'date' },
                { key: 'customer_notified_at', label: { i18nKey: 'compliance.vuln_stamp_customers', en: 'Customers notified' }, kind: 'date' },
                { key: 'reported_via', label: { i18nKey: 'compliance.vuln_reported_via_ph', en: 'Reported via (ENISA platform, CSIRT…)' }, kind: 'text' },
                DESCRIPTION,
            ]
            : [
                ...COMMON_FACTS,
                HIGH_RISK,
                { key: 'recipients_notified_at', label: { i18nKey: 'compliance.inc_stamp_recipients', en: 'Internal recipients' }, kind: 'date' },
                { key: 'authority_notified_at', label: { i18nKey: 'compliance.inc_stamp_authority', en: 'Supervisory authority (Art. 33)' }, kind: 'date' },
                AUTHORITY_REF,
                { key: 'subjects_notified_at', label: { i18nKey: 'compliance.inc_stamp_subjects', en: 'Data subjects (Art. 34)' }, kind: 'date' },
                DESCRIPTION,
            ],
        search: ['description'],
        empty: vuln
            ? { title: { i18nKey: 'compliance.vuln_empty_title', en: 'No vulnerabilities recorded' }, message: { i18nKey: 'compliance.vuln_empty', en: 'Record an actively exploited vulnerability here the moment you learn of it — the CRA early warning is due within 24 hours.' } }
            : { title: { i18nKey: 'compliance.inc_empty_title', en: 'No incidents recorded' } },
        create: {
            label: vuln ? { i18nKey: 'compliance.vuln_record', en: 'Record vulnerability' } : { i18nKey: 'compliance.inc_record', en: 'Record incident' },
            fields: vuln ? [TITLE, DESCRIPTION, SEVERITY, OCCURRED, CVE, PRODUCTS, EXPLOITED] : [TITLE, DESCRIPTION, SEVERITY, OCCURRED, HIGH_RISK],
            request: (values) => ({ method: 'POST', path: `${COMPLIANCE}/incidents`, body: incidentCreateBody(values, kind) }),
            success: { i18nKey: 'compliance.inc_toast_created', en: 'Incident recorded — the 72-hour clock is running' },
        },
        edit: {
            fields: editFields,
            request: (r, body) => patch(r, body),
            success: { i18nKey: 'compliance.inc_toast_updated', en: 'Incident updated' },
        },
        actions: vuln ? VULN_ACTIONS : BREACH_ACTIONS,
    };
}

export const INCIDENTS = incidentType('breach');
export const VULNERABILITIES = incidentType('vulnerability');
