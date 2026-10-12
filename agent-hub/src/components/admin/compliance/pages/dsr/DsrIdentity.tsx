import { BadgeCheck } from 'lucide-react';
import React, { useEffect, useId, useRef, useState } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { identityOf } from './dsrArticles';

/**
 * DsrIdentity: the data subject's identity in the DSR drawer, and the one
 * place a handler confirms it.
 *
 * Confirmed (by the e-mail link or by a handler) reads in success ink; an
 * employee reads as such. An open request whose identity is not confirmed
 * yet offers "Confirm identity…": it opens a note field ("How was the
 * identity checked?"), and Confirm posts `{ method: 'manual', note }` to
 * verify-identity (data/registers.js useDsr.verifyIdentity). The note is the
 * accountability record of HOW it was checked, so Confirm needs one. A
 * closed request only reads.
 */
export interface VerifyIdentityBody {
    method: 'manual';
    note: string;
}

export interface DsrIdentityProps {
    request: Record<string, unknown>;
    /** False for a closed request: the identity is then only read. */
    canConfirm?: boolean;
    busy?: boolean;
    onVerifyIdentity?: (body: VerifyIdentityBody) => unknown;
    testId: string;
}

const INPUT = 'w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-2 text-[12px] text-[var(--text-primary)] leading-4 outline-none focus:border-[var(--kind-compliance)]';
const SMALL_BUTTON = 'inline-flex items-center justify-center gap-1 h-[26px] px-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50 disabled:cursor-not-allowed';

/** The pending case of an open request: "Confirm identity…", then the note and Confirm. */
function ConfirmIdentity({ identity, busy, onVerifyIdentity, testId }: { identity: string; busy: boolean; onVerifyIdentity: (body: VerifyIdentityBody) => unknown; testId: string }) {
    const { t } = useTranslation();
    const [confirming, setConfirming] = useState(false);
    const [note, setNote] = useState('');
    const noteId = useId();
    const formId = useId();
    // The note is the next thing to do once the form opens: focus moves there.
    const noteRef = useRef<HTMLInputElement>(null);
    useEffect(() => { if (confirming) noteRef.current?.focus(); }, [confirming]);
    const pendingLabel = t('compliance.dsr_identity_pending', 'identity not yet confirmed');
    const reset = () => { setConfirming(false); setNote(''); };
    const submit = async () => {
        const text = note.trim();
        if (!text) return;
        await onVerifyIdentity({ method: 'manual', note: text });
        reset();
    };

    return (
        <>
            <span className="contents" data-testid={`${testId}-identity`} data-identity={identity}>
                <button
                    type="button"
                    className={SMALL_BUTTON}
                    title={pendingLabel}
                    aria-expanded={confirming}
                    aria-controls={confirming ? formId : undefined}
                    disabled={busy}
                    onClick={() => setConfirming((v) => !v)}
                    data-testid={`${testId}-identity-confirm`}
                >
                    <span className="sr-only">{pendingLabel} · </span>
                    {t('compliance.dsr_identity_confirm', 'Confirm identity…')}
                </button>
            </span>
            {confirming && (
                <div id={formId} className="basis-full flex flex-col gap-1.5" data-testid={`${testId}-identity-form`}>
                    <label htmlFor={noteId} className="text-[11px] text-[var(--text-secondary)]">
                        {t('compliance.dsr_identity_how', 'How was the identity checked?')}
                    </label>
                    <input
                        ref={noteRef}
                        id={noteId}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
                        className={INPUT}
                        data-testid={`${testId}-identity-note`}
                    />
                    <div className="flex gap-1.5">
                        <button type="button" className={SMALL_BUTTON} disabled={busy || !note.trim()} onClick={() => { void submit(); }} data-testid={`${testId}-identity-save`}>
                            {t('compliance.dsr_identity_confirm_cta', 'Confirm')}
                        </button>
                        <button type="button" className={SMALL_BUTTON} onClick={reset}>{t('common.cancel', 'Cancel')}</button>
                    </div>
                </div>
            )}
        </>
    );
}

export default function DsrIdentity({ request, canConfirm = true, busy = false, onVerifyIdentity, testId }: DsrIdentityProps) {
    const { t } = useTranslation();
    const identity = identityOf(request);

    if (identity === 'verified_link' || identity === 'verified_manual') {
        return (
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--success-ink)]" data-testid={`${testId}-identity`} data-identity={identity}>
                <BadgeCheck size={11} aria-hidden="true" />
                {identity === 'verified_manual'
                    ? t('compliance.dsr_identity_verified_manual', 'identity confirmed by the handler')
                    : t('compliance.dsr_identity_verified_link', 'identity confirmed via e-mail link')}
            </span>
        );
    }
    if (identity === 'employee') {
        return (
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-identity`} data-identity="employee">
                <BadgeCheck size={11} aria-hidden="true" />{t('compliance.dsr_identity_employee', 'employee')}
            </span>
        );
    }
    if (canConfirm && onVerifyIdentity) {
        return <ConfirmIdentity identity={identity} busy={busy} onVerifyIdentity={onVerifyIdentity} testId={testId} />;
    }
    return (
        <span className="text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-identity`} data-identity={identity}>
            {t('compliance.dsr_identity_pending', 'identity not yet confirmed')}
        </span>
    );
}
