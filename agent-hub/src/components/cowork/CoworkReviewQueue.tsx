/**
 * "To review": the runs of one Cowork item that asked their owner to decide (the agent's `cowork_request_review`),
 * above the figures, because they are what needs a person now.
 *
 * Per run: when it ran, the e-mail it was about (a mail run), the agent's reason, its question and what it already
 * did. The owner then either answers (the agent continues in the same conversation, as a follow-up run in Cowork with
 * the same tools as before, never more) or closes it: "I did it myself" or "Not needed". Both stay in the run history.
 *
 * Reads the same run query as the history (one request), or takes the runs its parent already read (the "Needs you"
 * strip, ./CoworkNeedsStrip.tsx, which mounts it only once something waits), and says nothing when nothing waits.
 */
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import { useState } from 'react';
import { useCoworkRunsQuery } from '../../api/queries/coworkReads';
import { resolveCoworkReview } from '../../api/coworkApi';
import { fullTimestamp } from './coworkFormat';
import { waitingRuns } from './coworkReview';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import type { CoworkReviewAction, CoworkRun } from '../../api/cowork.types';
import type { TranslateFn } from '../../hooks/useTranslation';

interface ReviewCardProps {
    coworkId: string;
    run: CoworkRun;
    t: TranslateFn;
    onReviewed?: () => void;
}

/** One labelled line of what the agent wrote; nothing when it wrote nothing there. */
function Field({ label, children }: { label: string; children: string | null | undefined }) {
    if (!children) return null;
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{label}</span>
            <p className="text-[12.5px] leading-[19px] whitespace-pre-wrap break-words text-[var(--text-secondary)]">{children}</p>
        </div>
    );
}

function ReviewCard({ coworkId, run, t, onReviewed }: ReviewCardProps) {
    const queryClient = useQueryClient();
    const [answer, setAnswer] = useState('');
    const [busy, setBusy] = useState<CoworkReviewAction | null>(null);
    const [error, setError] = useState<string | null>(null);
    const review = run.review;
    const fieldId = `cowork-review-answer-${run.id}`;

    const act = async (action: CoworkReviewAction) => {
        setBusy(action);
        setError(null);
        try {
            await resolveCoworkReview(coworkId, run.id, action === 'answer' ? { action, answer: answer.trim() } : { action });
            // The item's count, its history and its figures all changed: read Cowork again.
            await queryClient.invalidateQueries({ queryKey: ['cowork'] });
            onReviewed?.();
        } catch (err) {
            setError(errorMessage(err) || t('cowork_review.queue.failed', 'That did not work. Try again.'));
        } finally {
            setBusy(null);
        }
    };

    const secondary = 'px-2.5 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-50 border-[var(--border-subtle)] text-[var(--text-secondary)]';
    return (
        <article data-testid="cowork-review-item" className="flex flex-col gap-2.5 px-3.5 py-3 border-t first:border-t-0 border-[var(--border-subtle)]">
            <p className="text-[11px] text-[var(--text-tertiary)]">
                {fullTimestamp(run.startedAt, t)}
                {run.mailSubject ? ` · ${t('cowork_review.queue.mail_subject', 'E-mail: {subject}', { subject: run.mailSubject })}` : ''}
            </p>
            <Field label={t('cowork_review.queue.reason', 'Why it stopped')}>{review?.reason}</Field>
            <Field label={t('cowork_review.queue.question', 'The agent asks')}>{review?.question}</Field>
            <Field label={t('cowork_review.queue.summary', 'What it already did')}>{review?.summary}</Field>
            <label htmlFor={fieldId} className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                {t('cowork_review.queue.answer_label', 'Your answer or instruction')}
            </label>
            <textarea
                id={fieldId}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder={t('cowork_review.queue.answer_placeholder', 'For example: make the draft anyway, with the discount we agreed on the phone.')}
                className="w-full rounded-lg border px-2.5 py-2 text-[12.5px] resize-y bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
            />
            {error && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{error}</p>}
            <div className="flex items-center gap-1.5 flex-wrap">
                <button
                    type="button"
                    onClick={() => act('answer')}
                    disabled={busy !== null || !answer.trim()}
                    className="px-2.5 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-50 bg-[var(--button-primary-bg)] text-[var(--button-primary-fg)] hover:bg-[var(--button-primary-hover)]"
                >
                    {t('cowork_review.queue.send', 'Send and let the agent continue')}
                </button>
                <button type="button" onClick={() => act('done_myself')} disabled={busy !== null} className={secondary}>
                    {t('cowork_review.queue.done_myself', 'I did it myself')}
                </button>
                <button type="button" onClick={() => act('not_needed')} disabled={busy !== null} className={secondary}>
                    {t('cowork_review.queue.not_needed', 'Not needed')}
                </button>
            </div>
        </article>
    );
}

interface CoworkReviewQueueProps {
    coworkId: string;
    reloadKey: number | undefined;
    /** After a run was handled (the Cowork queries are read again first). */
    onReviewed?: () => void;
    /** The runs, when the parent already read them: then this reads nothing itself. */
    runs?: CoworkRun[];
}

export default function CoworkReviewQueue({ coworkId, reloadKey, onReviewed, runs }: CoworkReviewQueueProps) {
    const { t } = useTranslation();
    const runsQuery = useCoworkRunsQuery(runs ? null : coworkId, reloadKey);
    const waiting = waitingRuns(runs ?? runsQuery.data?.runs);
    if (waiting.length === 0) return null;

    return (
        <section
            data-testid="cowork-review-queue"
            aria-label={t('cowork_review.queue.heading', 'To review')}
            className="rounded-[10px] border overflow-hidden [background:var(--bg-card)] [border-color:color-mix(in_srgb,var(--warning)_40%,transparent)] [box-shadow:var(--shadow-sm)]"
        >
            <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-[var(--border-subtle)]">
                <ClipboardCheck aria-hidden="true" className="w-3.5 h-3.5 flex-shrink-0 text-[var(--warning-ink)]" />
                <h3 className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                    {t('cowork_review.queue.heading', 'To review')}
                </h3>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                    {t('cowork_review.queue.explainer', 'The agent stopped and asks you to decide.')}
                </span>
            </div>
            {waiting.map((run) => <ReviewCard key={run.id} coworkId={coworkId} run={run} t={t} onReviewed={onReviewed} />)}
        </section>
    );
}
