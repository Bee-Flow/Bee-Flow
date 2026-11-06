import { Info } from 'lucide-react';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import { useAcknowledgeKbQueryLog, useKbQueryLogNotice, type QueryLogNoticeKb } from '@/api/queries/kbQueryLog';

/**
 * What the person typing is told about the knowledge-base query log.
 *
 * A base that logs and that the person has not yet acknowledged gets a
 * compact banner: what is logged, who sees it, for how long, whether their
 * name or a pseudonym is kept, and an "Understood" button. Until they press
 * it their questions are NOT logged. After that, one muted line.
 *
 * It renders only when the server says a base in `kbIds` that the caller can
 * read really logs (switched on AND licensed), and names only those bases.
 * While the answer is on its way, or when it cannot be read, nothing is
 * drawn: the text is a courtesy, the logging follows the server's own rules.
 */
export interface KbQueryLogNoticeProps {
    kbIds: readonly string[] | null | undefined;
    className?: string;
}

const names = (kbs: QueryLogNoticeKb[]) => kbs.map((k) => k.name).join(', ');

function AcknowledgeBanner({ t, kbs, className }: { t: TranslateFn; kbs: QueryLogNoticeKb[]; className: string }) {
    const ack = useAcknowledgeKbQueryLog();
    const days = Math.max(...kbs.map((k) => k.retentionDays ?? 0));
    const withNames = kbs.some((k) => k.showNames);
    return (
        <div data-testid="kb-query-log-ack" role="region" aria-label={t('knowledge.query_log.ack_title', 'Questions can be logged')} className={`mx-auto flex max-w-xl flex-col gap-1.5 rounded-lg border px-3 py-2 text-left text-[11px] leading-snug [border-color:var(--border-default)] [background:var(--bg-secondary)] text-[var(--text-secondary)] ${className}`}>
            <p className="m-0 font-medium text-[var(--text-primary)]">{t('knowledge.query_log.ack_title', 'Questions can be logged')}</p>
            <p className="m-0">{t('knowledge.query_log.ack_what', 'Your questions to {names}, the passages found and the answers can be logged, so the managers of the knowledge base can check the answers and see what is missing.', { names: names(kbs) })}</p>
            <p className="m-0">
                {withNames
                    ? t('knowledge.query_log.ack_who_names', 'The managers see your name.')
                    : t('knowledge.query_log.ack_who_pseudonym', 'The managers see a pseudonym, not your name.')}
                {days > 0 && ` ${t('knowledge.query_log.ack_term', 'Entries are kept for up to {n} days.', { n: days })}`}
            </p>
            <p className="m-0" data-testid="kb-query-log-not-yet">{t('knowledge.query_log.ack_not_yet', 'Until you confirm, your questions are not logged.')}</p>
            {ack.isError && <p className="m-0 text-[var(--error)]" role="alert">{t('knowledge.query_log.ack_failed', 'Could not save this. Try again.')}</p>}
            <button
                type="button"
                data-testid="kb-query-log-ack-button"
                disabled={ack.isPending}
                onClick={() => ack.mutate(kbs.map((k) => k.id))}
                className="self-start rounded-md border px-3 py-1 text-xs font-medium [border-color:var(--border-default)] text-[var(--text-primary)] disabled:opacity-50"
            >
                {t('knowledge.query_log.ack_button', 'Understood')}
            </button>
        </div>
    );
}

export default function KbQueryLogNotice({ kbIds, className = '' }: KbQueryLogNoticeProps) {
    const { t } = useTranslation();
    const { data } = useKbQueryLogNotice(kbIds);
    if (!data?.active) return null;
    const open = data.kbs.filter((k) => !k.acknowledged);
    const done = data.kbs.filter((k) => k.acknowledged);
    return (
        <>
            {open.length > 0 && <AcknowledgeBanner t={t} kbs={open} className={className} />}
            {done.length > 0 && (
                <p
                    data-testid="kb-query-log-notice"
                    className={`m-0 flex items-center justify-center gap-1 text-[10px] leading-snug text-[var(--text-tertiary)] ${className}`}
                >
                    <Info className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span>
                        {t('knowledge.query_log.notice', 'Questions to {names} are logged for quality control by the knowledge base’s managers.', { names: names(done) })}
                    </span>
                </p>
            )}
        </>
    );
}
