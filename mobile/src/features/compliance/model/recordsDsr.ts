/**
 * Data-subject requests (web: pages/DsrPage + dsr/*). The register shows the
 * MASKED address only (routes/dsr.js listRow); the phone never opens the
 * single-request read that serves the full address and writes an access-audit
 * row for it. The dossier export carries no personal data (compliance/dsr/mask
 * DOSSIER_COLUMNS) and is handed to the share sheet.
 *
 * Server: routes/dsr.js — ManualIntakeBody, ExtendBody, VerifyIdentityBody,
 * FulfilBody (all `.strict()`). Fulfilling and rejecting e-mail the subject
 * (`notify_subject: true`, as the web sends it).
 */

import { DSR_CAPTURE_CHANNELS, DSR_CHANNELS, DSR_IDENTITY, DSR_STATES, DSR_TYPES } from './choices';
import { choiceOf, createBody, labelText } from './fields';
import { DSR, seg, str } from './paths';
import type { FieldSpec, FormValues, Rec, RecordType, WriteRequest } from './types';
import { readDsrRequests, readDsrTimeline } from '../api/readersRegisters';

const request = (rec: Rec, action: string, body: unknown = {}): WriteRequest => ({
    method: 'POST',
    path: `${DSR}/requests/${seg(rec.id)}/${action}`,
    body,
});
const isOpen = (rec: Rec) => rec.status === 'pending' || rec.status === 'in_progress';

const TYPE: FieldSpec = { key: 'request_type', label: { i18nKey: 'compliance.dsr_capture_type', en: 'Kind of request' }, kind: 'choice', options: DSR_TYPES, initial: 'access', required: true };
const EMAIL: FieldSpec = { key: 'subject_email', label: { i18nKey: 'compliance.dsr_capture_email', en: 'E-mail address of the data subject' }, kind: 'email', required: true };
const CHANNEL: FieldSpec = { key: 'channel', label: { i18nKey: 'compliance.dsr_capture_channel', en: 'Arrived via' }, kind: 'choice', options: DSR_CAPTURE_CHANNELS, initial: 'email_dpo', required: true };
const RECEIVED: FieldSpec = { key: 'received_at', label: { i18nKey: 'compliance.dsr_capture_received', en: 'Received on' }, kind: 'date', required: true };
const NOTES: FieldSpec = {
    key: 'notes',
    label: { i18nKey: 'compliance.dsr_capture_notes', en: 'Notes' },
    kind: 'multiline',
    placeholder: { i18nKey: 'compliance.dsr_capture_notes_ph', en: 'What the data subject asked for, in their words if possible.' },
};
const VERIFY_NOTE: FieldSpec = { key: 'note', label: { i18nKey: 'compliance.dsr_timeline_note', en: 'Note' }, kind: 'multiline' };
const SUMMARY: FieldSpec = {
    key: 'result_summary',
    label: { i18nKey: 'compliance.dsr_sec_summary', en: 'Summary of the handling' },
    kind: 'multiline',
    required: true,
    placeholder: { i18nKey: 'compliance.dsr_summary_placeholder', en: 'What was done to fulfil (or why rejected) — kept as the accountability record.' },
};

/** The capture body: an e-mail lower-cased, the receipt date as an ISO instant. */
export function captureBody(values: FormValues): Record<string, unknown> {
    const body = createBody([TYPE, EMAIL, CHANNEL, NOTES], values);
    body.subject_email = str(body.subject_email).toLowerCase();
    const received = str(values.received_at).trim();
    if (received) body.received_at = new Date(`${received}T12:00:00`).toISOString();
    return body;
}

export const DSR_REQUESTS: RecordType = {
    id: 'dsr',
    section: 'dsr',
    noun: { i18nKey: 'compliance.dsr_col_request', en: 'Request' },
    plural: { i18nKey: 'compliance.rail_dsr', en: 'Requests (DSR)' },
    icon: 'Inbox',
    intro: { i18nKey: 'compliance.dsr_subtitle', en: 'Every request starts a one-month clock (GDPR Art. 12(3)). Fulfil or reject each one and keep the summary — it is your accountability record.' },
    list: { paths: [`${DSR}/requests`], select: ([raw]) => ({ rows: readDsrRequests(raw), context: null }) },
    idOf: (r) => str(r.id),
    titleOf: (r, fmt) => {
        const type = choiceOf(DSR_TYPES, r.request_type);
        return `#${str(r.id)} · ${type ? labelText(type.label, fmt.t) : str(r.request_type)}`;
    },
    meta: ['subject_email_masked', 'due_at'],
    status: { key: 'status', options: DSR_STATES },
    facts: [
        { key: 'subject_email_masked', label: { i18nKey: 'compliance.dsr_sec_subject', en: 'Data subject' }, kind: 'text' },
        { key: 'channel', label: { i18nKey: 'compliance.dsr_col_via', en: 'Via' }, kind: 'choice', options: DSR_CHANNELS },
        { key: 'identity_status', label: { i18nKey: 'mobile.compliance.dsr_identity', en: 'Identity' }, kind: 'choice', options: DSR_IDENTITY },
        { key: 'created_at', label: { i18nKey: 'compliance.dsr_col_received', en: 'Received' }, kind: 'date' },
        { key: 'due_at', label: { i18nKey: 'compliance.dsr_col_deadline', en: 'Deadline' }, kind: 'date' },
        { key: 'extended_until', label: { i18nKey: 'mobile.compliance.dsr_extended_until', en: 'Extended to' }, kind: 'date' },
        { key: 'fulfilled_at', label: { i18nKey: 'compliance.dsr_state_fulfilled', en: 'Completed' }, kind: 'date' },
        { key: 'notes', label: { i18nKey: 'compliance.dsr_notes', en: 'Notes from the requester' }, kind: 'multiline' },
        { key: 'result_summary', label: { i18nKey: 'compliance.dsr_result_summary', en: 'Resolution summary' }, kind: 'multiline' },
    ],
    search: ['subject_email_masked'],
    empty: { title: { i18nKey: 'compliance.dsr_empty', en: 'No data-subject requests received.' } },
    create: {
        label: { i18nKey: 'compliance.dsr_capture_title', en: 'Record a request' },
        fields: [TYPE, EMAIL, CHANNEL, RECEIVED, NOTES],
        request: (values) => ({ method: 'POST', path: `${DSR}/requests/manual`, body: captureBody(values) }),
        success: { i18nKey: 'compliance.dsr_toast_captured', en: 'Request recorded — the one-month clock is running' },
    },
    actions: [
        {
            id: 'start',
            label: { i18nKey: 'compliance.dsr_start', en: 'Start working' },
            icon: 'Play',
            when: (r) => r.status === 'pending',
            request: (r) => request(r, 'start'),
            success: { i18nKey: 'compliance.dsr_toast_started', en: 'Request started' },
        },
        {
            id: 'verify',
            label: { i18nKey: 'mobile.compliance.dsr_verify', en: 'Confirm identity manually' },
            icon: 'UserCheck',
            when: (r) => isOpen(r) && r.identity_status === 'unverified',
            fields: [VERIFY_NOTE],
            request: (r, v) => request(r, 'verify-identity', { method: 'manual', ...createBody([VERIFY_NOTE], v) }),
        },
        {
            id: 'extend',
            label: { i18nKey: 'compliance.dsr_extend_60', en: 'Extend +2 months' },
            icon: 'Clock',
            when: (r) => isOpen(r) && !r.extended_at,
            fields: [{ key: 'reason', label: { i18nKey: 'compliance.dsr_extend_reason', en: 'Reason for the extension (Art. 12(3): complexity or number of requests)' }, kind: 'multiline', required: true }],
            request: (r, v) => request(r, 'extend', { reason: str(v.reason).trim() }),
            success: { i18nKey: 'compliance.dsr_toast_extended', en: 'Deadline extended by two months' },
        },
        {
            id: 'fulfil',
            label: { i18nKey: 'compliance.dsr_fulfil_and_mail', en: 'Fulfil and e-mail the data subject' },
            icon: 'Check',
            when: isOpen,
            fields: [SUMMARY],
            request: (r, v) => request(r, 'fulfil', { status: 'fulfilled', result_summary: str(v.result_summary).trim(), notify_subject: true }),
            success: { i18nKey: 'compliance.dsr_toast_fulfilled', en: 'Request fulfilled — the data subject has been e-mailed' },
        },
        {
            id: 'reject',
            label: { i18nKey: 'compliance.dsr_reject_confirm', en: 'Reject and e-mail the data subject' },
            icon: 'X',
            danger: true,
            when: isOpen,
            fields: [{ ...SUMMARY, label: { i18nKey: 'compliance.dsr_reject_reason', en: 'Reason for rejecting — goes into the reply to the data subject' } }],
            request: (r, v) => request(r, 'fulfil', { status: 'rejected', result_summary: str(v.result_summary).trim(), notify_subject: true }),
            success: { i18nKey: 'compliance.dsr_toast_rejected', en: 'Request rejected — the data subject has been e-mailed' },
        },
        {
            id: 'export',
            label: { i18nKey: 'compliance.dsr_export', en: 'Export' },
            icon: 'FileDown',
            download: (r) => ({ path: `${DSR}/requests/${seg(r.id)}/export`, fileName: `dsr-${str(r.id)}.json`, mimeType: 'application/json' }),
        },
    ],
    history: {
        title: { i18nKey: 'compliance.dsr_sec_timeline', en: 'Timeline' },
        path: (r) => `${DSR}/requests/${seg(r.id)}/timeline`,
        select: (raw, fmt) =>
            readDsrTimeline(raw).map((e, i) => ({
                id: `${i}`,
                title: fmt.t(`compliance.dsr_timeline_${e.kind}`, e.kind),
                meta: [fmt.date(e.at), e.text].filter(Boolean).join(' · ') || null,
            })),
    },
};
