import { Info } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import { useKbQueryLogNotice } from '@/api/queries/kbQueryLog';

/**
 * One muted line under an input: the questions to these knowledge bases are
 * logged for quality control by the base's managers.
 *
 * It renders only when the server says a base in `kbIds` that the caller can
 * read really logs (switched on AND licensed), and names only those bases.
 * While the answer is on its way, or when it cannot be read, nothing is
 * drawn: the line is a courtesy, the logging follows the server's own rules.
 */
export interface KbQueryLogNoticeProps {
    kbIds: readonly string[] | null | undefined;
    className?: string;
}

export default function KbQueryLogNotice({ kbIds, className = '' }: KbQueryLogNoticeProps) {
    const { t } = useTranslation();
    const { data } = useKbQueryLogNotice(kbIds);
    if (!data?.active) return null;
    const names = data.kbs.map((k) => k.name).join(', ');
    return (
        <p
            data-testid="kb-query-log-notice"
            className={`m-0 flex items-center justify-center gap-1 text-[10px] leading-snug text-[var(--text-tertiary)] ${className}`}
        >
            <Info className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span>
                {t('knowledge.query_log.notice', 'Questions to {names} are logged for quality control by the knowledge base’s managers.', { names })}
            </span>
        </p>
    );
}
