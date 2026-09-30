/**
 * Evidence connectors (web: pages/ConnectorsPage + connectors/ConnectorDrawer)
 * and DPIAs (web: pages/DpiaPage).
 *
 * Connectors — server: routes/compliance/isoConnectors.js (ConnectorConfig:
 * enabled, connection_id, settings; `.strict()`). The phone edits the switch
 * and the vault connection; the free-form JSON `settings` stays a web task and
 * is never sent, so the stored object is kept.
 *
 * DPIAs — server: routes/compliance/dpia.js (DpiaBody `.strict()`). A row is a
 * per-agent result of the GDPR-Art35 check joined with the latest assessment
 * on record, exactly as the web's `dpiaRows` builds it.
 */

import { pick } from '@/core/api/contract';

import { CHECK_STATUSES, DPIA_RISKS } from './choices';
import { createBody } from './fields';
import { COMPLIANCE, seg, str } from './paths';
import type { Choice, FieldSpec, FormValues, Rec, RecordType } from './types';
import { readChecks } from '../api/readers';
import { readConnectors, readDpiaList } from '../api/readersRegisters';

// ── Connectors ──────────────────────────────────────────────────────────

const CONNECTOR_STATES: readonly Choice[] = [
    { value: 'ok', label: { i18nKey: 'compliance.conn_status_ok', en: 'Collecting' }, tone: 'success' },
    { value: 'error', label: { i18nKey: 'compliance.conn_status_error', en: 'Last sweep failed' }, tone: 'error' },
    { value: 'off', label: { i18nKey: 'compliance.conn_status_off', en: 'Off' }, tone: 'neutral' },
];

const CONNECTOR_FIELDS: readonly FieldSpec[] = [
    { key: 'enabled', label: { i18nKey: 'compliance.conn_enabled', en: 'Enabled — swept every 6 hours and on demand' }, kind: 'bool' },
    {
        key: 'connection_id',
        label: { i18nKey: 'compliance.conn_connection', en: 'Vault connection' },
        kind: 'choice',
        remote: (r) => `${COMPLIANCE}/iso/connectors/${seg(r?.id)}/connections`,
    },
];

export const CONNECTORS: RecordType = {
    id: 'connectors',
    section: 'connectors',
    noun: { i18nKey: 'compliance.conn_col_connector', en: 'Connector' },
    plural: { i18nKey: 'compliance.rail_connectors', en: 'Evidence connectors' },
    icon: 'Plug',
    intro: { i18nKey: 'compliance.conn_intro', en: 'Couple the systems that already hold your evidence. Credentials stay in the integrations vault.' },
    list: {
        paths: [`${COMPLIANCE}/iso/connectors`],
        select: ([raw]) => ({
            rows: readConnectors(raw).map((c) => ({ ...c, state: !c.enabled ? 'off' : c.last_status === 'error' ? 'error' : 'ok' })),
            context: null,
        }),
    },
    idOf: (r) => str(r.id),
    titleOf: (r, fmt) => (r.titleKey ? fmt.t(str(r.titleKey), str(r.id)) : str(r.id)),
    meta: ['last_sweep_at'],
    status: { key: 'state', options: CONNECTOR_STATES },
    facts: [
        ...CONNECTOR_FIELDS,
        { key: 'last_sweep_at', label: { i18nKey: 'compliance.conn_col_last', en: 'Last sweep' }, kind: 'date' },
        { key: 'last_error', label: { i18nKey: 'compliance.conn_status_error', en: 'Last sweep failed' }, kind: 'text' },
        { key: 'snapshots', label: { i18nKey: 'mobile.compliance.snapshots', en: 'Evidence snapshots' }, kind: 'number' },
    ],
    empty: { title: { i18nKey: 'compliance.conn_empty', en: 'No evidence connectors available' } },
    edit: {
        fields: CONNECTOR_FIELDS,
        request: (r, body) => ({ method: 'PUT', path: `${COMPLIANCE}/iso/connectors/${seg(r.id)}`, body }),
        success: { i18nKey: 'compliance.conn_toast_saved', en: 'Connector saved' },
    },
    actions: [
        {
            id: 'sweep',
            label: { i18nKey: 'compliance.conn_sweep_now', en: 'Sweep now' },
            icon: 'RefreshCw',
            when: (r) => r.enabled === true,
            request: (r) => ({ method: 'POST', path: `${COMPLIANCE}/iso/connectors/${seg(r.id)}/sweep`, body: {} }),
            success: { i18nKey: 'mobile.compliance.swept', en: 'Sweep done' },
        },
    ],
};

// ── DPIAs ───────────────────────────────────────────────────────────────

export const DPIA_CHECK_ID = 'GDPR-Art35-dpia-high-risk';

/** attested now + 12 months — the validity the web gives both paths. */
export function defaultExpiry(now: number): string {
    const d = new Date(now);
    d.setMonth(d.getMonth() + 12);
    return d.toISOString();
}

/** The per-agent Art-35 check rows joined with the DPIA on record (web: DpiaPage.dpiaRows). */
export function dpiaRows(checksRaw: unknown, dpiaRaw: unknown): Rec[] {
    const onRecord = readDpiaList(dpiaRaw);
    return readChecks(checksRaw)
        .filter((c) => c.check_id === DPIA_CHECK_ID && c.scope_id)
        .map((c) => {
            const dpia = onRecord.find((d) => d.agent_id === c.scope_id) ?? null;
            const name = pick(c.evidence, 'agent_name');
            const reason = pick(c.evidence, 'risk_reason');
            return {
                agent_id: c.scope_id,
                agent_name: typeof name === 'string' ? name : c.scope_id,
                risk_reason: typeof reason === 'string' ? reason : null,
                status: c.status,
                on_record: dpia !== null,
                mode: dpia?.mode ?? null,
                risk_level: dpia?.risk_level ?? null,
                approved_at: dpia?.approved_at ?? null,
                expires_at: dpia?.expires_at ?? null,
            };
        });
}

const QUESTIONNAIRE: readonly FieldSpec[] = [
    { key: 'purpose', label: { i18nKey: 'compliance.dpia_q_purpose', en: 'Purpose of processing' }, kind: 'text' },
    { key: 'data_categories', label: { i18nKey: 'compliance.dpia_q_data', en: 'Personal data involved' }, kind: 'text', placeholder: { i18nKey: 'compliance.dpia_q_data_ph', en: 'e.g. names, emails, HR records' } },
    { key: 'automated_decisions', label: { i18nKey: 'compliance.dpia_q_automated', en: 'Makes or supports automated decisions about people' }, kind: 'bool' },
    { key: 'human_oversight', label: { i18nKey: 'compliance.dpia_q_oversight', en: 'Human oversight' }, kind: 'text' },
    { key: 'mitigations', label: { i18nKey: 'compliance.dpia_q_mitigations', en: 'Mitigations (one per line)' }, kind: 'lines' },
    { key: 'risk_level', label: { i18nKey: 'compliance.dpia_q_risk', en: 'Residual risk' }, kind: 'choice', options: DPIA_RISKS, initial: 'medium', required: true },
];

/** The questionnaire body: answers as the web stores them, measures one per line. */
export function questionnaireBody(values: FormValues, now: number): Record<string, unknown> {
    const text = (k: string) => str(values[k]).trim();
    return {
        mode: 'questionnaire',
        risk_level: text('risk_level') || 'medium',
        expires_at: defaultExpiry(now),
        answers: {
            purpose: text('purpose'),
            data_categories: text('data_categories'),
            automated_decisions: values.automated_decisions === true,
            human_oversight: text('human_oversight'),
        },
        mitigations: (createBody([QUESTIONNAIRE[4] as FieldSpec], values).mitigations as string[] | undefined) ?? [],
    };
}

const dpiaPath = (r: Rec) => `${COMPLIANCE}/dpia/${seg(r.agent_id)}`;

export const DPIA: RecordType = {
    id: 'dpia',
    section: 'dpia',
    noun: { i18nKey: 'compliance.dpia_col_agent', en: 'Agent' },
    plural: { i18nKey: 'compliance.rail_dpia', en: 'DPIAs' },
    icon: 'ClipboardCheck',
    intro: { i18nKey: 'compliance.dpia_subtitle', en: 'Agents flagged as high-risk (Art. 35) need a Data Protection Impact Assessment before they process personal data.' },
    list: { paths: [`${COMPLIANCE}/checks`, `${COMPLIANCE}/dpia`], select: ([checks, dpia]) => ({ rows: dpiaRows(checks, dpia), context: null }) },
    idOf: (r) => str(r.agent_id),
    titleOf: (r) => str(r.agent_name),
    meta: ['risk_reason', 'approved_at'],
    status: { key: 'status', options: CHECK_STATUSES },
    facts: [
        { key: 'risk_reason', label: { i18nKey: 'compliance.dpia_col_reason', en: 'Why it is high-risk' }, kind: 'text' },
        { key: 'on_record', label: { i18nKey: 'compliance.dpia_on_record_short', en: 'DPIA on record' }, kind: 'bool' },
        { key: 'risk_level', label: { i18nKey: 'compliance.dpia_q_risk', en: 'Residual risk' }, kind: 'choice', options: DPIA_RISKS },
        { key: 'approved_at', label: { i18nKey: 'mobile.compliance.approved_at', en: 'Approved on' }, kind: 'date' },
        { key: 'expires_at', label: { i18nKey: 'mobile.compliance.expires_at', en: 'Valid until' }, kind: 'date' },
    ],
    empty: { title: { i18nKey: 'compliance.dpia_empty_title', en: 'No agent needs a DPIA' }, message: { i18nKey: 'compliance.dpia_empty', en: 'No high-risk agents detected — no DPIA required right now.' } },
    actions: [
        {
            id: 'attest',
            label: { i18nKey: 'compliance.dpia_attest', en: 'Attest existing DPIA' },
            icon: 'BadgeCheck',
            confirm: { i18nKey: 'compliance.dpia_attest_hint', en: 'You assessed this agent outside Bee Flow — record that attestation (valid 12 months).' },
            request: (r, _v, ctx) => ({ method: 'POST', path: dpiaPath(r), body: { mode: 'attestation', risk_level: 'medium', expires_at: defaultExpiry(ctx.now) } }),
            success: { i18nKey: 'compliance.dpia_toast_saved', en: 'DPIA recorded' },
        },
        {
            id: 'questionnaire',
            label: { i18nKey: 'compliance.dpia_questionnaire', en: 'Or complete the assessment here' },
            icon: 'ClipboardList',
            fields: QUESTIONNAIRE,
            request: (r, v, ctx) => ({ method: 'POST', path: dpiaPath(r), body: questionnaireBody(v, ctx.now) }),
            success: { i18nKey: 'compliance.dpia_toast_saved', en: 'DPIA recorded' },
        },
        {
            id: 'pdf',
            label: { i18nKey: 'compliance.dpia_download_pdf', en: 'Download DPIA (PDF)' },
            icon: 'FileDown',
            when: (r) => r.on_record === true,
            download: (r) => ({ path: `${dpiaPath(r)}/pdf`, fileName: `dpia-${str(r.agent_id)}.pdf`, mimeType: 'application/pdf' }),
        },
    ],
};
