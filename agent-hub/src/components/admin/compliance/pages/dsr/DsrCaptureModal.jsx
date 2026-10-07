/**
 * "Record a request" — a DPO logs a request that arrived by e-mail, phone or
 * letter (artboard 1c header primary). POST /api/dsr/requests/manual with an
 * explicit allow-list of fields: type, e-mail, channel, received-at, notes.
 */
import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import Modal from '../../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { CAPTURE_CHANNELS, CHANNEL_WIRE, DSR_TYPES, articleOf } from './dsrArticles';
import { channelLabel, typeLabel } from './DsrTable';

const FIELD = 'w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--kind-compliance)]';
const LABEL = 'text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `datetime-local` value for a Date (local wall time, minute precision). */
export function toLocalInputValue(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Pure validation → { field: messageKey } (English fallback resolved by the caller). */
export function validateCapture({ request_type, subject_email, channel, received_at }, now = Date.now()) {
    const errors = {};
    if (!DSR_TYPES.includes(request_type)) errors.request_type = 'type';
    if (!EMAIL_RE.test(String(subject_email || '').trim())) errors.subject_email = 'email';
    if (!CAPTURE_CHANNELS.includes(channel)) errors.channel = 'channel';
    const ms = received_at ? new Date(received_at).getTime() : NaN;
    if (!Number.isFinite(ms)) errors.received_at = 'received';
    else if (ms > now + 60_000) errors.received_at = 'future';
    return errors;
}

/**
 * The allow-listed payload — nothing else from the form state reaches the
 * server. The channel goes out in the server's spelling (`email_dpo`, …).
 */
export function capturePayload({ request_type, subject_email, channel, received_at, notes }) {
    const body = {
        request_type,
        subject_email: String(subject_email || '').trim(),
        channel: CHANNEL_WIRE[channel] ?? channel,
        received_at: new Date(received_at).toISOString(),
    };
    const n = String(notes || '').trim();
    if (n) body.notes = n;
    return body;
}

const ERROR_TEXT = {
    type: ['compliance.dsr_capture_err_type', 'Choose the kind of request.'],
    email: ['compliance.dsr_capture_err_email', 'Enter the data subject’s e-mail address.'],
    channel: ['compliance.dsr_capture_err_channel', 'Choose how the request arrived.'],
    received: ['compliance.dsr_capture_err_received', 'Enter when the request was received.'],
    future: ['compliance.dsr_capture_err_future', 'The receipt date cannot be in the future.'],
};

export default function DsrCaptureModal({ open = false, onClose, onCapture, busy = false, testId = 'dsr-capture' }) {
    const { t } = useTranslation();
    const [form, setForm] = useState(() => ({ request_type: 'access', subject_email: '', channel: 'email', received_at: toLocalInputValue(new Date()), notes: '' }));
    const [errors, setErrors] = useState({});
    const [touched, setTouched] = useState(false);

    useEffect(() => {
        if (open) {
            setForm({ request_type: 'access', subject_email: '', channel: 'email', received_at: toLocalInputValue(new Date()), notes: '' });
            setErrors({}); setTouched(false);
        }
    }, [open]);

    const set = (k) => (e) => {
        const value = e?.target ? e.target.value : e;
        setForm(f => ({ ...f, [k]: value }));
        if (touched) setErrors(validateCapture({ ...form, [k]: value }));
    };

    const submit = (e) => {
        e?.preventDefault?.();
        const errs = validateCapture(form);
        setTouched(true);
        setErrors(errs);
        if (Object.keys(errs).length) return;
        onCapture?.(capturePayload(form));
    };

    const err = (k) => errors[k] ? t(...ERROR_TEXT[errors[k]]) : null;
    const Err = ({ k }) => err(k) ? <span className="text-[11px]" style={{ color: 'var(--error-ink)' }} role="alert" data-testid={`${testId}-err-${k}`}>{err(k)}</span> : null;

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="md"
            title={t('compliance.dsr_capture_title', 'Record a request')}
            description={t('compliance.dsr_capture_desc', 'For a request that arrived by e-mail, phone or letter. The one-month clock starts at receipt.')}
            footer={(
                <>
                    <button type="button" onClick={onClose} className="h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)]">
                        {t('common.cancel', 'Cancel')}
                    </button>
                    <button type="submit" form={`${testId}-form`} disabled={busy} data-testid={`${testId}-submit`}
                        className="h-8 px-3 rounded-[10px] text-[12px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50" style={PRIMARY_ACTION_STYLE}>
                        <Plus size={13} aria-hidden="true" />{t('compliance.dsr_capture_submit', 'Record')}
                    </button>
                </>
            )}
        >
            <form id={`${testId}-form`} onSubmit={submit} className="flex flex-col gap-3" data-testid={`${testId}-form`} noValidate>
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('compliance.dsr_capture_type', 'Kind of request')}</span>
                    <select value={form.request_type} onChange={set('request_type')} className={FIELD} data-testid={`${testId}-type`}>
                        {DSR_TYPES.map(k => <option key={k} value={k}>{typeLabel(t, k)} · {t('compliance.dsr_article', 'Art. {n}', { n: articleOf(k) })}</option>)}
                    </select>
                    <Err k="request_type" />
                </label>
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('compliance.dsr_capture_email', 'E-mail address of the data subject')}</span>
                    <input type="email" value={form.subject_email} onChange={set('subject_email')} className={FIELD} autoComplete="off"
                        placeholder="name@example.org" data-testid={`${testId}-email`} aria-invalid={errors.subject_email ? true : undefined} />
                    <Err k="subject_email" />
                </label>
                <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1">
                        <span className={LABEL}>{t('compliance.dsr_capture_channel', 'Arrived via')}</span>
                        <select value={form.channel} onChange={set('channel')} className={FIELD} data-testid={`${testId}-channel`}>
                            {CAPTURE_CHANNELS.map(c => <option key={c} value={c}>{channelLabel(t, c)}</option>)}
                        </select>
                        <Err k="channel" />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className={LABEL}>{t('compliance.dsr_capture_received', 'Received on')}</span>
                        <input type="datetime-local" value={form.received_at} onChange={set('received_at')} className={FIELD}
                            data-testid={`${testId}-received`} aria-invalid={errors.received_at ? true : undefined} />
                        <Err k="received_at" />
                    </label>
                </div>
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('compliance.dsr_capture_notes', 'Notes')}</span>
                    <textarea value={form.notes} onChange={set('notes')} rows={3} className={`${FIELD} resize-y`}
                        placeholder={t('compliance.dsr_capture_notes_ph', 'What the data subject asked for, in their words if possible.')} data-testid={`${testId}-notes`} />
                </label>
            </form>
        </Modal>
    );
}
