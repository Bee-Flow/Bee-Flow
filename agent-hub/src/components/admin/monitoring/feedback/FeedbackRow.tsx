import { Bot, ChevronRight, Cpu, ExternalLink, MessageSquare, ThumbsDown, ThumbsUp } from 'lucide-react';
import { CHIP, CHIP_INFO, CHIP_WARNING } from '@/components/mcpLibrary/ui';
import { ConversationReplay, NoConversation } from './ConversationReplay';
import { parseSnapshot } from './feedbackModel';
import type { FeedbackItem, SnapshotMessage } from './feedbackModel';
import { useTranslation } from '@/hooks/useTranslation';
import { fmtTime, shortModel } from '../shared';

/** Source, agent, model, tier and "n msgs" next to the user's name. */
function FeedbackChips({ item, snapshot }: { item: FeedbackItem; snapshot: SnapshotMessage[] | null }) {
    const { t } = useTranslation();
    const agentId = item.agent_id || '';
    return (
        <>
            {item.source && <span className={CHIP}>{item.source}</span>}
            {(item.agent_name || item.agent_id) && (
                <span className={CHIP_INFO} title={agentId}>
                    <Bot className="h-2.5 w-2.5" aria-hidden="true" />
                    {item.agent_name || (agentId.length > 20 ? agentId.slice(0, 20) + '…' : agentId)}
                </span>
            )}
            {item.model && (
                <span className={CHIP} title={item.model}>
                    <Cpu className="h-2.5 w-2.5" aria-hidden="true" />
                    {shortModel(item.model)}
                </span>
            )}
            {item.model_tier && (
                <span className={CHIP_WARNING} title={item.model_tier === 'auto' && item.model ? `auto → ${item.model}` : `tier: ${item.model_tier}`}>
                    tier: {item.model_tier}{item.model_tier === 'auto' && item.model ? ` → ${shortModel(item.model)}` : ''}
                </span>
            )}
            {!!snapshot && snapshot.length > 0 && (
                <span className={CHIP_INFO}>
                    <MessageSquare className="h-2.5 w-2.5" aria-hidden="true" />
                    {t('admin_monitoring.feedback_msgs', '{n} msgs', { n: snapshot.length })}
                </span>
            )}
        </>
    );
}

/** Expanded: ids, the comment in full, and the conversation replay. */
function FeedbackDetail({ item, snapshot }: { item: FeedbackItem; snapshot: SnapshotMessage[] | null }) {
    const { t } = useTranslation();
    const isUp = item.rating === 'up';
    return (
        <div className="bg-[var(--bg-secondary)] py-3 pl-12 pr-4">
            <div className="mb-3 flex flex-wrap gap-3 font-mono text-[11px] text-[var(--text-tertiary)]">
                {item.conversation_id && (
                    <span className="inline-flex items-center gap-1">
                        <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                        Conv: {item.conversation_id.slice(0, 16)}…
                    </span>
                )}
                {item.message_id && <span>Msg: {item.message_id.slice(0, 16)}…</span>}
                {item.organization_id && <span>Org: {item.organization_id.slice(0, 16)}…</span>}
            </div>

            {item.comment && (
                <div className={`mb-3 rounded-lg border px-3.5 py-2.5 ${isUp
                    ? 'border-[color-mix(in_srgb,var(--success)_30%,transparent)] bg-[color-mix(in_srgb,var(--success)_8%,transparent)]'
                    : 'border-[color-mix(in_srgb,var(--error)_30%,transparent)] bg-[color-mix(in_srgb,var(--error)_8%,transparent)]'}`}
                >
                    <div className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.04em] ${isUp ? 'text-[var(--success-ink)]' : 'text-[var(--error-ink)]'}`}>
                        {t('admin_monitoring.feedback_user_feedback', 'User Feedback')}
                    </div>
                    <div className="whitespace-pre-wrap text-[13px] leading-normal text-[var(--text-primary)]">{item.comment}</div>
                </div>
            )}

            {snapshot && snapshot.length > 0 ? <ConversationReplay snapshot={snapshot} /> : <NoConversation />}
        </div>
    );
}

interface FeedbackRowProps {
    item: FeedbackItem;
    expanded: boolean;
    onToggle: () => void;
}

/** One feedback entry: the summary line, and its detail when expanded. */
export default function FeedbackRow({ item, expanded, onToggle }: FeedbackRowProps) {
    const snapshot = parseSnapshot(item.conversation_snapshot);
    const isUp = item.rating === 'up';
    const Rating = isUp ? ThumbsUp : ThumbsDown;
    return (
        <div className="border-b border-[var(--border-default)] last:border-b-0">
            <div
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onClick={onToggle}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
                className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-[var(--bg-secondary)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
            >
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${isUp
                    ? 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]'
                    : 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error-ink)]'}`}
                >
                    <Rating className="h-3.5 w-3.5" aria-hidden="true" />
                </span>

                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="mr-0.5 text-xs font-semibold text-[var(--text-primary)]">{item.person?.name || item.user_id || 'Anonymous'}</span>
                        <FeedbackChips item={item} snapshot={snapshot} />
                    </div>
                    {item.comment && (
                        <div className={`mt-1 overflow-hidden text-ellipsis text-xs text-[var(--text-secondary)] ${expanded ? 'whitespace-pre-wrap' : 'max-w-[500px] whitespace-nowrap'}`}>
                            "{item.comment}"
                        </div>
                    )}
                </div>

                <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">{fmtTime(item.created_at)}</span>
                <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)] transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" />
            </div>

            {expanded && <FeedbackDetail item={item} snapshot={snapshot} />}
        </div>
    );
}
