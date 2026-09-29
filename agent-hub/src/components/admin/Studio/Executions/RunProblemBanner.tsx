import { AlertCircle } from 'lucide-react';
import { useState } from 'react';
import { runLogSentence } from './runLogSentence';
import type { ErrorInfoLike, RunLogRow } from './runLogSentence';
import { useTranslation } from '../../../../hooks/useTranslation';

interface StepRecordLike { status?: string | null; errorInfo?: ErrorInfoLike | null }

const FAILED = new Set(['error', 'failed']);

const TONE = {
    error: { ink: 'text-[var(--error-ink)]', wash: 'bg-[color-mix(in_srgb,var(--error)_6%,transparent)]' },
    warn: { ink: 'text-[var(--warning-ink)]', wash: 'bg-[color-mix(in_srgb,var(--warning)_6%,transparent)]' },
    neutral: { ink: 'text-[var(--text-secondary)]', wash: 'bg-[var(--bg-secondary)]' },
} as const;

/** The failed step's classification, when the run's step records hold one. */
function failedStepInfo(steps: StepRecordLike[]): ErrorInfoLike | null {
    return steps.find(s => FAILED.has(String(s.status || '')) && s.errorInfo)?.errorInfo || null;
}

/**
 * Why an open run stopped, under its bar: the plain sentence the log shows
 * (the classifier's errorInfo title), with the raw server message one click
 * away behind "technical message", the way the step drawer's error card does
 * it. It used to print that raw message ("550 5.1.1 <...>") as the banner.
 */
export default function RunProblemBanner({ run, steps }: { run: RunLogRow | null; steps: StepRecordLike[] }) {
    const { t } = useTranslation();
    const [showTech, setShowTech] = useState(false);
    const failed = FAILED.has(String(run?.status || '').toLowerCase());
    if (!run || (!failed && !run.error)) return null;

    const sentence = runLogSentence(t, run, failedStepInfo(steps));
    // A rejection's "error" is the person's reason, already in the sentence.
    const technical = run.errorClass === 'ApprovalRejected' ? null : (sentence.technical || run.error || null);
    const { ink, wash } = TONE[sentence.tone];

    return (
        <div className={`flex-shrink-0 border-b border-[var(--border-default)] text-xs ${wash}`} data-testid="run-problem-banner">
            <div className="flex items-start gap-2 px-4 py-2">
                <AlertCircle size={14} aria-hidden className={`shrink-0 mt-px ${ink}`} />
                <span className={`min-w-0 flex-1 ${ink}`}>{sentence.text}</span>
                {technical && (
                    <button
                        type="button"
                        aria-expanded={showTech}
                        onClick={() => setShowTech(v => !v)}
                        className="shrink-0 text-[var(--text-tertiary)] underline hover:text-[var(--text-primary)]"
                    >
                        {t('routines.output.technical_message', 'technical message')}
                    </button>
                )}
            </div>
            {showTech && technical && (
                <pre className="mx-4 mb-2 p-2 rounded-md bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-40 overflow-auto custom-scrollbar">{technical}</pre>
            )}
        </div>
    );
}
