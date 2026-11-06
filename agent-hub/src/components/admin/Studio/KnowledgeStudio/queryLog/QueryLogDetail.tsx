import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import Modal from '@/components/shared/Modal';
import { QUERY_LOG_REVIEW_STATUSES, useReviewKbQueryLogEntry, type QueryLogEntry } from '@/api/queries/kbQueryLog';
import { channelLabel, citationText, outcomeLabel, statusLabel } from './queryLogLabels';

export interface QueryLogDetailProps {
    kbId: string;
    entry: QueryLogEntry | null;
    onClose: () => void;
}

const H = 'text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';

/** Status and note of one entry. Keyed on the entry, so a new entry starts from its own values. */
function ReviewForm({ kbId, entry }: { kbId: string; entry: QueryLogEntry }) {
    const { t } = useTranslation();
    const review = useReviewKbQueryLogEntry(kbId);
    const [status, setStatus] = useState(entry.reviewStatus);
    const [note, setNote] = useState(entry.reviewNote ?? '');
    const [saved, setSaved] = useState(false);
    return (
        <form
            className="flex flex-col gap-2"
            data-testid="kb-ql-review"
            onSubmit={(e) => {
                e.preventDefault();
                setSaved(false);
                review.mutate({ entryId: entry.id, status, note: note.trim() || null }, { onSuccess: () => setSaved(true) });
            }}
        >
            <h4 className={H}>{t('knowledge.query_log.review', 'Review')}</h4>
            <select
                aria-label={t('knowledge.query_log.col_status', 'Status')}
                className="rounded-md border px-2 py-1 text-xs [background:var(--bg-secondary)] [border-color:var(--border-default)] text-[var(--text-primary)]"
                value={status}
                data-testid="kb-ql-review-status"
                onChange={(e) => setStatus(e.target.value)}
            >
                {QUERY_LOG_REVIEW_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(t, s)}</option>)}
            </select>
            <textarea
                aria-label={t('knowledge.query_log.note', 'Note')}
                className="min-h-[72px] rounded-md border px-2 py-1 text-xs [background:var(--bg-secondary)] [border-color:var(--border-default)] text-[var(--text-primary)]"
                value={note}
                maxLength={4000}
                placeholder={t('knowledge.query_log.note_placeholder', 'What should be added or changed?')}
                data-testid="kb-ql-review-note"
                onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex items-center gap-3">
                <button type="submit" disabled={review.isPending} className="rounded-md border px-3 py-1 text-xs [border-color:var(--border-default)] text-[var(--text-primary)] disabled:opacity-50" data-testid="kb-ql-review-save">
                    {t('knowledge.query_log.save', 'Save')}
                </button>
                {saved && <span className="text-[11px] text-[var(--text-tertiary)]" role="status">{t('knowledge.query_log.saved', 'Saved')}</span>}
                {review.isError && <span className="text-[11px] text-[var(--error)]" role="alert">{review.error.message}</span>}
            </div>
        </form>
    );
}

function Facts({ entry }: { entry: QueryLogEntry }) {
    const { t, resolvedLocale } = useTranslation();
    const rows: [string, string][] = [
        [t('knowledge.query_log.col_time', 'Time'), new Date(entry.createdAt).toLocaleString(resolvedLocale)],
        [t('knowledge.query_log.col_person', 'Person'), entry.askerPseudonym || entry.userName || entry.userId || '–'],
        [t('knowledge.query_log.col_channel', 'Channel'), channelLabel(t, entry.channel)],
        [t('knowledge.query_log.col_outcome', 'Outcome'), outcomeLabel(t, entry.outcome) + (entry.errorCode ? ` (${entry.errorCode})` : '')],
        [t('knowledge.query_log.model', 'Model'), entry.model || '–'],
        [t('knowledge.query_log.retrieval_ms', 'Search took'), entry.retrievalMs == null ? '–' : `${entry.retrievalMs} ms`],
        [t('knowledge.query_log.answer_ms', 'Answer took'), entry.answerMs == null ? '–' : `${entry.answerMs} ms`],
    ];
    return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {rows.map(([k, v]) => (
                <div key={k} className="contents"><dt className="text-[var(--text-tertiary)]">{k}</dt><dd className="m-0 text-[var(--text-primary)]">{v}</dd></div>
            ))}
        </dl>
    );
}

export default function QueryLogDetail({ kbId, entry, onClose }: QueryLogDetailProps) {
    const { t } = useTranslation();
    const citations = Array.isArray(entry?.citations) ? entry.citations : [];
    return (
        <Modal open={!!entry} onClose={onClose} title={t('knowledge.query_log.detail_title', 'Logged question')} placement="right" size="lg">
            {entry && (
                <div className="flex flex-col gap-4 text-xs" data-testid="kb-ql-detail">
                    {entry.decryptFailed && <p className="text-[var(--error)]" role="alert">{t('knowledge.query_log.unreadable_long', 'The content of this entry cannot be decrypted. Only its details are shown.')}</p>}
                    <Facts entry={entry} />
                    <section>
                        <h4 className={H}>{t('knowledge.query_log.question', 'Question')}</h4>
                        <p className="m-0 whitespace-pre-wrap text-[var(--text-primary)]">{entry.query || '–'}</p>
                    </section>
                    <section>
                        <h4 className={H}>{t('knowledge.query_log.answer', 'Answer')}</h4>
                        <p className="m-0 whitespace-pre-wrap text-[var(--text-primary)]">{entry.answer || t('knowledge.query_log.no_answer', 'No answer was given.')}</p>
                    </section>
                    <section>
                        <h4 className={H}>{t('knowledge.query_log.passages', 'Passages found ({n})', { n: entry.chunks.length })}</h4>
                        <ol className="m-0 flex list-none flex-col gap-2 p-0">
                            {entry.chunks.map((c, i) => (
                                <li key={`${c.chunkId ?? i}`} className="rounded-md border p-2 [border-color:var(--border-subtle)]" data-testid="kb-ql-passage">
                                    <div className="font-medium text-[var(--text-primary)]">{c.title || c.sourceUri || '–'}</div>
                                    <div className="text-[11px] text-[var(--text-tertiary)]">
                                        {[c.sourceUri, c.documentVersion ? t('knowledge.query_log.doc_version', 'version {v}', { v: c.documentVersion }) : null, c.page != null ? t('knowledge.query_log.page', 'page {n}', { n: c.page }) : null, c.score != null ? t('knowledge.query_log.score', 'score {n}', { n: c.score.toFixed(2) }) : null].filter(Boolean).join(' · ')}
                                    </div>
                                    {c.text && <p className="m-0 mt-1 whitespace-pre-wrap text-[var(--text-secondary)]">{c.text}</p>}
                                </li>
                            ))}
                        </ol>
                    </section>
                    {citations.length > 0 && (
                        <section>
                            <h4 className={H}>{t('knowledge.query_log.citations', 'Citations')}</h4>
                            <ul className="m-0 pl-4">{citations.map((c, i) => <li key={i}>{citationText(c)}</li>)}</ul>
                        </section>
                    )}
                    <ReviewForm key={entry.id} kbId={kbId} entry={entry} />
                </div>
            )}
        </Modal>
    );
}
