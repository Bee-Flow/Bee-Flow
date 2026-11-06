import useTranslation from '@/hooks/useTranslation';
import type { QueryLogEntry } from '@/api/queries/kbQueryLog';
import { channelLabel, excerpt, outcomeLabel, statusLabel } from './queryLogLabels';

export interface QueryLogTableProps {
    rows: QueryLogEntry[];
    selectedId: string | null;
    onOpen: (id: string) => void;
}

const TH = 'px-3 py-2 text-left text-[11px] font-medium text-[var(--text-tertiary)]';

export default function QueryLogTable({ rows, selectedId, onOpen }: QueryLogTableProps) {
    const { t, resolvedLocale } = useTranslation();
    return (
        <div className="overflow-x-auto rounded-lg border [border-color:var(--border-subtle)]">
            <table className="w-full text-xs" data-testid="kb-query-log-table">
                <thead>
                    <tr className="border-b [border-color:var(--border-subtle)]">
                        <th className={TH}>{t('knowledge.query_log.col_time', 'Time')}</th>
                        <th className={TH}>{t('knowledge.query_log.col_person', 'Person')}</th>
                        <th className={TH}>{t('knowledge.query_log.col_channel', 'Channel')}</th>
                        <th className={TH}>{t('knowledge.query_log.col_question', 'Question')}</th>
                        <th className={TH}>{t('knowledge.query_log.col_outcome', 'Outcome')}</th>
                        <th className={TH}>{t('knowledge.query_log.col_status', 'Status')}</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r) => (
                        <tr
                            key={r.id}
                            data-testid={`kb-ql-row-${r.id}`}
                            aria-selected={selectedId === r.id}
                            className="cursor-pointer border-b last:border-b-0 hover:bg-[var(--bg-secondary)] [border-color:var(--border-subtle)]"
                            onClick={() => onOpen(r.id)}
                        >
                            <td className="px-3 py-2 whitespace-nowrap text-[var(--text-secondary)]">
                                {new Date(r.createdAt).toLocaleString(resolvedLocale)}
                            </td>
                            <td className="px-3 py-2 text-[var(--text-secondary)]">{r.userName || r.userId || '–'}</td>
                            <td className="px-3 py-2 text-[var(--text-secondary)]">{channelLabel(t, r.channel)}</td>
                            <td className="px-3 py-2 text-[var(--text-primary)]">
                                <button type="button" className="text-left underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(r.id); }}>
                                    {r.decryptFailed
                                        ? t('knowledge.query_log.unreadable', 'Cannot be decrypted')
                                        : excerpt(r.query) || '–'}
                                </button>
                            </td>
                            <td className="px-3 py-2 text-[var(--text-secondary)]">{outcomeLabel(t, r.outcome)}</td>
                            <td className="px-3 py-2 text-[var(--text-secondary)]">{statusLabel(t, r.reviewStatus)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
