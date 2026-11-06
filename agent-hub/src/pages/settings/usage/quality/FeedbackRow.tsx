import { Fragment } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { shortModel, fmtTime } from '../format';
import { getSourceDetails } from '../widgets';
import { Swatch } from '../shell';
import { ConversationViewer } from './ConversationViewer';
import { parseSnapshot } from './qualityModel';
import type { FeedbackItem } from './qualityData';

const PILL = 'inline-flex items-center rounded-md px-[7px] py-[3px] text-xs font-semibold';
const CELL = 'border-t border-[var(--border-subtle)] px-3 py-3 align-top text-[13px] text-[var(--text-primary)]';

export interface FeedbackRowProps {
    item: FeedbackItem;
    open: boolean;
    onToggle: () => void;
}

export function FeedbackRow({ item, open, onToggle }: FeedbackRowProps) {
    const { t } = useTranslation();
    const snapshot = parseSnapshot(item.conversation_snapshot);
    const isUp = item.rating === 'up';
    const where = getSourceDetails(item.source || '', t);
    return (
        <Fragment>
            <tr>
                <td className={CELL}>
                    <span className={`${PILL} ${isUp
                        ? 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)]'
                        : 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error)]'}`}
                    >
                        {isUp ? t('org.feedback_positive', 'Positive') : t('org.feedback_negative', 'Negative')}
                    </span>
                </td>
                <td className={CELL}>
                    {item.comment
                        ? <p className="m-0 max-w-[60ch] whitespace-normal text-[13px] text-[var(--text-secondary)]">&ldquo;{item.comment}&rdquo;</p>
                        : <p className="m-0 text-[13px] italic text-[var(--text-muted)]">{t('org.feedback_no_comment', 'no comment')}</p>}
                </td>
                <td className={`${CELL} whitespace-nowrap`}>
                    {item.source || item.agent_name ? (
                        <span className="inline-flex items-center gap-2">
                            <Swatch color={where.color} className="h-2.5 w-2.5 rounded-[3px]" />
                            {where.label}
                            {item.agent_name && <span className="text-[var(--text-muted)]">· {item.agent_name}</span>}
                        </span>
                    ) : <span className="text-[var(--text-muted)]">—</span>}
                </td>
                <td className={`${CELL} whitespace-nowrap`} title={item.model}>{item.model ? shortModel(item.model) : '—'}</td>
                <td className={`${CELL} whitespace-nowrap`}>{item.user_id || t('org.feedback_anonymous', 'Anonymous')}</td>
                <td className={`${CELL} whitespace-nowrap text-right text-xs text-[var(--text-muted)]`}>{fmtTime(item.created_at)}</td>
                <td className={`${CELL} whitespace-nowrap text-right`}>
                    {snapshot ? (
                        <button
                            type="button"
                            aria-expanded={open}
                            onClick={onToggle}
                            className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-[var(--accent-primary)] hover:underline"
                        >
                            {open ? t('org.feedback_hide_conversation', 'Hide conversation') : t('org.feedback_open_conversation', 'Open conversation')} <span aria-hidden="true">→</span>
                        </button>
                    ) : <span className="text-xs italic text-[var(--text-muted)]">{t('org.feedback_not_shared', 'not shared')}</span>}
                </td>
            </tr>
            {open && snapshot && (
                <tr>
                    <td colSpan={7} className="bg-[var(--bg-tertiary)] px-4 py-3">
                        <ConversationViewer snapshot={snapshot} />
                    </td>
                </tr>
            )}
        </Fragment>
    );
}
