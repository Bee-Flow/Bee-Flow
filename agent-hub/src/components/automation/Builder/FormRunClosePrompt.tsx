import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';

/**
 * The question the overlay asks before it closes (RUN-11), laid over the
 * phase so the page underneath keeps what was typed:
 *
 *   'answers'  a click beside a page with answers on it: discard them, or
 *              keep editing (Esc and the close button need no question)
 *   'parked'   a test run waits on this page or on a decision: keep it
 *              waiting (it stays parked, answer it later from the canvas or
 *              Runs), or discard the test run (POST /runs/:id/cancel)
 */
interface FormRunClosePromptProps {
    prompt: 'answers' | 'parked';
    onClose: () => void;
    onDiscardRun: () => Promise<void>;
    onBack: () => void;
}

const BUTTON = 'px-2.5 py-1 rounded-md text-xs font-medium';

export default function FormRunClosePrompt({ prompt, onClose, onDiscardRun, onBack }: FormRunClosePromptProps) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const discard = async () => {
        setBusy(true);
        setError(null);
        try { await onDiscardRun(); } catch (e) { setError(messageOf(e, t('automation_testing.overlay.discard_failed', 'The test run could not be discarded.'))); } finally { setBusy(false); }
    };
    const parked = prompt === 'parked';
    return (
        <div role="alertdialog" aria-label={parked ? t('automation_testing.overlay.parked_title', 'This test run is waiting') : t('automation_testing.overlay.answers_title', 'Discard your answers?')} className="flex flex-col gap-2 px-4 py-3 border-b border-[var(--border-default)] bg-[var(--bg-tertiary)]">
            <p className="text-xs text-[var(--text-primary)]">
                {parked
                    ? t('automation_testing.overlay.parked_text', 'The test run waits here until somebody answers. Keep it waiting, or discard it?')
                    : t('automation_testing.overlay.answers_text', 'Close the test form and lose what you typed on this page?')}
            </p>
            <div className="flex flex-wrap gap-2">
                {parked ? (
                    <>
                        <button type="button" onClick={onClose} className={`${BUTTON} bg-[var(--accent)] text-white hover:opacity-90`}>
                            {t('automation_testing.overlay.keep_waiting', 'Keep it waiting')}
                        </button>
                        <button type="button" onClick={discard} disabled={busy} className={`${BUTTON} border border-red-500/40 text-red-700 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50`}>
                            {t('automation_testing.overlay.discard_run', 'Discard this test run')}
                        </button>
                    </>
                ) : (
                    <button type="button" onClick={onClose} className={`${BUTTON} border border-red-500/40 text-red-700 dark:text-red-400 hover:bg-red-500/10`}>
                        {t('automation_testing.overlay.discard_answers', 'Discard')}
                    </button>
                )}
                <button type="button" onClick={onBack} className={`${BUTTON} text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]`}>
                    {t('automation_testing.overlay.keep_editing', 'Go back')}
                </button>
            </div>
            {error && <p role="alert" className="text-xs text-[var(--error)]">{error}</p>}
        </div>
    );
}
