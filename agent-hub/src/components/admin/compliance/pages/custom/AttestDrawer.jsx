import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FileCheck2, History, Paperclip, PenLine, Trash2 } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SideDrawer, { DrawerSection, DrawerId } from '../../../../shared/SideDrawer';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { TONES } from '../../../../shared/statusTone';
import { API, fetchJson } from '../../data/api';

/**
 * AttestDrawer — "I declare this item, and here is the evidence".
 *
 * One drawer for the two places the platform records a human verdict against a
 * check it cannot measure: a custom-framework item
 * (`POST /custom/checks/:id/attest`, outcomes compliant | partial |
 * non_compliant | not_applicable) and a Machinery Art. 18 subject
 * (`POST /machinery/subjects/:id/attest`, classifications safety_component |
 * monitoring_only | not_safety_component). The vocabulary is the CALLER's —
 * this file never assumes which of the two it is serving.
 *
 * Evidence: uploaded through the existing `POST /api/compliance/iso/evidence/upload`
 * (multipart, field `file`), which answers `{ uploaded, sha256, filename }`. The
 * attestation then carries an ALLOW-LISTED ref `{ sha256, filename }` — never the
 * File object, never a user record (BFSF-441).
 */

/** The evidence-ref shape the attest routes accept. Explicit allow-list, never a spread. */
export function evidenceRef(uploaded) {
    if (!uploaded || typeof uploaded !== 'object') return null;
    const sha256 = typeof uploaded.sha256 === 'string' ? uploaded.sha256 : null;
    if (!sha256) return null;
    return {
        evidence_id: uploaded.evidence_id ?? null,
        sha256,
        filename: typeof uploaded.filename === 'string' ? uploaded.filename : null,
    };
}

/** Upload one file and return its allow-listed evidence ref. */
export async function uploadEvidence(file, { checkId = null, subjectId = null, subjectType = 'attachment', note = null } = {}) {
    const form = new FormData();
    form.append('file', file);
    form.append('subject_type', subjectType);
    if (subjectId) form.append('subject_id', subjectId);
    if (checkId) form.append('check_id', checkId);
    if (note) form.append('note', note);
    // No Content-Type header: the browser sets the multipart boundary.
    const body = await fetchJson(`${API}/iso/evidence/upload`, { method: 'POST', body: form });
    return evidenceRef(body);
}

const SECONDARY_BUTTON = 'inline-flex items-center gap-1 px-[9px] py-1 rounded-lg border border-[var(--border-default)] text-[12px] font-medium text-[var(--text-primary)] bg-[var(--bg-card)] disabled:opacity-60';

/** Error codes the two attest routes answer with → the sentence the drawer shows. */
export const ATTEST_ERRORS = Object.freeze({
    evidence_required: { key: 'compliance.custom_err_evidence_required', fallback: 'This item needs at least one piece of evidence.' },
    invalid_outcome: { key: 'compliance.custom_err_invalid_outcome', fallback: 'That is not a valid outcome.' },
    invalid_subject: { key: 'compliance.mach_err_invalid_subject', fallback: 'This subject cannot be attested.' },
    not_provisioned: { key: 'compliance.mach_err_not_provisioned', fallback: 'The detector is not installed on this deployment.' },
    feature_locked: { key: 'compliance.custom_err_locked', fallback: 'Own frameworks are not included in your plan.' },
});

/** Pure: which sentence belongs to a thrown error / an error body. */
export function attestErrorText(err, t) {
    const raw = typeof err === 'string' ? err : (err?.code || err?.error || err?.message || '');
    for (const [code, copy] of Object.entries(ATTEST_ERRORS)) {
        if (String(raw).includes(code)) return t(copy.key, copy.fallback);
    }
    return t('compliance.custom_err_attest_failed', 'The attestation could not be recorded.');
}

function formatStamp(value) {
    const ms = value ? new Date(value).getTime() : NaN;
    if (Number.isNaN(ms)) return '—';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function AttestDrawer({
    open = false,
    onClose,
    title,
    subtitle = null,
    reference = null,
    options = [],
    initialOutcome = null,
    evidenceRequired = false,
    checkId = null,
    subjectId = null,
    uploadSubjectType = 'attachment',
    history = null,
    historyFailed = false,
    outcomeLabel = null,
    busy = false,
    // The demo transport (and any deployment without file storage) cannot take
    // a multipart upload. Then the affordance is shown DISABLED with a reason,
    // not hidden: a required-evidence attestation that silently loses its
    // attach button looks like a bug, not like a limit.
    uploadsEnabled = true,
    onSubmit,
    mode = 'overlay',
    width = 420,
    testId = 'attest-drawer',
}) {
    const { t } = useTranslation();
    const [outcome, setOutcome] = useState(initialOutcome);
    const [statement, setStatement] = useState('');
    const [refs, setRefs] = useState([]);
    const [error, setError] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setOutcome(initialOutcome);
        setStatement('');
        setRefs([]);
        setError(null);
    }, [open, initialOutcome, subjectId, checkId]);

    const onFile = useCallback(async (e) => {
        const file = e.target?.files?.[0];
        // The input keeps its value otherwise, so the same file cannot be picked twice.
        if (e.target) e.target.value = '';
        if (!file) return;
        setUploading(true);
        setError(null);
        try {
            const ref = await uploadEvidence(file, { checkId, subjectId, subjectType: uploadSubjectType });
            if (ref) setRefs(prev => [...prev, ref]);
            else setError(t('compliance.custom_err_upload', 'The file could not be stored as evidence.'));
        } catch (err) {
            setError(attestErrorText(err, t));
        } finally {
            setUploading(false);
        }
    }, [checkId, subjectId, uploadSubjectType, t]);

    const removeRef = (sha) => setRefs(prev => prev.filter(r => r.sha256 !== sha));

    const blocked = !outcome || (evidenceRequired && refs.length === 0);
    const working = saving || busy || uploading;

    const submit = async () => {
        if (blocked || working) return;
        setSaving(true);
        setError(null);
        try {
            await onSubmit?.({ outcome, statement: statement.trim() || null, evidence_refs: refs });
            onClose?.();
        } catch (err) {
            setError(attestErrorText(err, t));
        } finally {
            setSaving(false);
        }
    };

    const historyRows = useMemo(() => (Array.isArray(history) ? history : null), [history]);

    return (
        <SideDrawer
            open={open}
            onClose={onClose}
            mode={mode}
            width={width}
            testId={testId}
            ariaLabel={t('compliance.custom_attest_title', 'Record an attestation')}
            header={(
                <div className="flex flex-col gap-0.5 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                        <PenLine size={13} className="text-[var(--text-secondary)] shrink-0" aria-hidden="true" />
                        <span className="font-semibold text-[13px] truncate" data-testid={`${testId}-title`}>{title}</span>
                    </div>
                    {subtitle && <span className="text-[11px] text-[var(--text-secondary)] leading-4">{subtitle}</span>}
                    {reference && <DrawerId testId={`${testId}-ref`}>{reference}</DrawerId>}
                </div>
            )}
            footer={(
                <div className="flex items-center gap-2">
                    {error && (
                        <span className="text-[11px] font-medium" style={{ color: TONES.error.ink }} data-testid={`${testId}-error`}>{error}</span>
                    )}
                    <button type="button" className={`ml-auto ${SECONDARY_BUTTON}`} onClick={onClose} disabled={saving}>
                        {t('common.cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        className="inline-flex items-center gap-1 px-[9px] py-1 rounded-lg text-[12px] font-semibold disabled:opacity-60"
                        style={PRIMARY_ACTION_STYLE}
                        disabled={blocked || working}
                        onClick={submit}
                        data-testid={`${testId}-submit`}
                    >
                        <FileCheck2 size={12} aria-hidden="true" />
                        {t('compliance.custom_attest_save', 'Record attestation')}
                    </button>
                </div>
            )}
        >
            <DrawerSection label={outcomeLabel || t('compliance.custom_attest_outcome', 'Outcome')}>
                <div role="radiogroup" aria-label={outcomeLabel || t('compliance.custom_attest_outcome', 'Outcome')} className="flex flex-col gap-1">
                    {options.map(opt => {
                        const active = outcome === opt.value;
                        const tone = opt.tone && TONES[opt.tone] ? TONES[opt.tone] : null;
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                onClick={() => setOutcome(opt.value)}
                                className="text-left px-2.5 py-1.5 rounded-lg border text-[12px] flex flex-col gap-0.5"
                                style={{
                                    borderColor: active && tone ? tone.raw : 'var(--border-default)',
                                    background: active
                                        ? (tone ? `color-mix(in srgb, ${tone.raw} 14%, transparent)` : 'var(--bg-secondary)')
                                        : 'transparent',
                                    color: active && tone ? tone.ink : 'var(--text-primary)',
                                }}
                                data-testid={`${testId}-option`}
                                data-value={opt.value}
                                data-active={active ? 'true' : 'false'}
                            >
                                <span className="font-medium">{t(opt.labelKey, opt.fallback)}</span>
                                {opt.hintKey && <span className="text-[11px] text-[var(--text-secondary)] leading-4">{t(opt.hintKey, opt.hintFallback || '')}</span>}
                            </button>
                        );
                    })}
                </div>
            </DrawerSection>

            <DrawerSection label={t('compliance.custom_attest_statement', 'Statement')} hint={t('compliance.custom_attest_statement_hint', 'what you checked, and how')}>
                <textarea
                    value={statement}
                    onChange={(e) => setStatement(e.target.value)}
                    rows={4}
                    className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[12px] leading-4 text-[var(--text-primary)]"
                    placeholder={t('compliance.custom_attest_statement_ph', 'For example: reviewed the supplier contract on 3 September; clause 8 covers the notification term.')}
                    data-testid={`${testId}-statement`}
                />
            </DrawerSection>

            <DrawerSection
                label={t('compliance.custom_attest_evidence', 'Evidence')}
                hint={evidenceRequired ? t('compliance.custom_attest_evidence_required', 'required for this item') : t('compliance.custom_attest_evidence_optional', 'optional')}
            >
                <div className="flex flex-col gap-1.5">
                    {refs.map(r => (
                        <div key={r.sha256} className="flex items-center gap-2 text-[11px] rounded-lg border border-[var(--border-default)] px-2 py-1" data-testid={`${testId}-ref-row`}>
                            <Paperclip size={12} className="text-[var(--text-secondary)] shrink-0" aria-hidden="true" />
                            <span className="truncate">{r.filename || t('compliance.custom_attest_evidence_file', 'file')}</span>
                            <span className="font-mono text-[10px] text-[var(--text-tertiary)] truncate">{r.sha256.slice(0, 12)}</span>
                            <button
                                type="button"
                                className="ml-auto text-[var(--text-tertiary)]"
                                aria-label={t('common.remove', 'Remove')}
                                onClick={() => removeRef(r.sha256)}
                                data-testid={`${testId}-ref-remove`}
                            >
                                <Trash2 size={12} aria-hidden="true" />
                            </button>
                        </div>
                    ))}
                    <label
                        className={`${SECONDARY_BUTTON} w-fit ${uploadsEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                        title={uploadsEnabled ? undefined : t('compliance.custom_attest_upload_unavailable', 'Attaching a file is not available here.')}
                        data-testid={`${testId}-upload-label`}
                    >
                        <Paperclip size={12} aria-hidden="true" />
                        {uploading ? t('compliance.custom_attest_uploading', 'Uploading…') : t('compliance.custom_attest_upload', 'Attach evidence')}
                        <input
                            type="file"
                            className="hidden"
                            onChange={onFile}
                            disabled={uploading || !uploadsEnabled}
                            data-testid={`${testId}-upload`}
                        />
                    </label>
                    {!uploadsEnabled && (
                        <span className="text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-upload-unavailable`}>
                            {t('compliance.custom_attest_upload_unavailable', 'Attaching a file is not available here.')}
                        </span>
                    )}
                    {evidenceRequired && refs.length === 0 && (
                        <span className="text-[11px]" style={{ color: TONES.warning.ink }} data-testid={`${testId}-evidence-warning`}>
                            {t('compliance.custom_err_evidence_required', 'This item needs at least one piece of evidence.')}
                        </span>
                    )}
                </div>
            </DrawerSection>

            <DrawerSection label={t('compliance.custom_attest_history', 'Earlier attestations')}>
                {historyFailed ? (
                    <span className="text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-history-failed`}>
                        {t('compliance.custom_history_failed', 'The history could not be read.')}
                    </span>
                ) : historyRows === null ? (
                    <span className="text-[11px] text-[var(--text-tertiary)] animate-pulse">{t('common.loading', 'Loading...')}</span>
                ) : historyRows.length === 0 ? (
                    <span className="text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-history-empty`}>
                        {t('compliance.custom_history_empty', 'Nothing recorded yet.')}
                    </span>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {historyRows.map(h => {
                            const value = h.classification || h.outcome || null;
                            const opt = options.find(o => o.value === value) || null;
                            return (
                                <li key={h.id} className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-history-row`}>
                                    <History size={11} className="text-[var(--text-tertiary)] shrink-0" aria-hidden="true" />
                                    <span className="font-medium" data-value={value || undefined}>{opt ? t(opt.labelKey, opt.fallback) : (value || '—')}</span>
                                    <span className="ml-auto tabular-nums text-[var(--text-tertiary)]">{formatStamp(h.attested_at)}</span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </DrawerSection>
        </SideDrawer>
    );
}
