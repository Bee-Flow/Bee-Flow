import { Bot, ChevronRight, Cpu, ExternalLink, MessageSquare } from 'lucide-react';
import { ConversationReplay, NoConversation } from './ConversationReplay';
import { chipStyle, parseSnapshot } from './feedbackModel';
import type { FeedbackItem, SnapshotMessage } from './feedbackModel';
import { useTranslation } from '../../../../hooks/useTranslation';
import { COLORS, fmtTime, shortModel } from '../shared';

const MUTED_CHIP_BG = 'var(--bg-tertiary, rgba(255,255,255,0.04))';

/** Source, agent, model, tier and "n msgs" next to the user's name. */
function FeedbackChips({ item, snapshot }: { item: FeedbackItem; snapshot: SnapshotMessage[] | null }) {
    const { t } = useTranslation();
    const agentId = item.agent_id || '';
    return (
        <>
            {item.source && (
                <span style={chipStyle(MUTED_CHIP_BG, 'var(--text-muted, #888)')}>{item.source}</span>
            )}
            {(item.agent_name || item.agent_id) && (
                <span style={chipStyle(COLORS.blue + '15', COLORS.blue, true)} title={agentId}>
                    <Bot style={{ width: 9, height: 9 }} />
                    {item.agent_name || (agentId.length > 20 ? agentId.slice(0, 20) + '…' : agentId)}
                </span>
            )}
            {item.model && (
                <span style={chipStyle(MUTED_CHIP_BG, 'var(--text-secondary, #aaa)', true)} title={item.model}>
                    <Cpu style={{ width: 9, height: 9 }} />
                    {shortModel(item.model)}
                </span>
            )}
            {item.model_tier && (
                <span
                    style={chipStyle(COLORS.amber + '15', COLORS.amber)}
                    title={item.model_tier === 'auto' && item.model ? `auto → ${item.model}` : `tier: ${item.model_tier}`}
                >
                    tier: {item.model_tier}{item.model_tier === 'auto' && item.model ? ` → ${shortModel(item.model)}` : ''}
                </span>
            )}
            {!!snapshot && snapshot.length > 0 && (
                <span style={chipStyle(COLORS.blue + '15', COLORS.blue, true)}>
                    <MessageSquare style={{ width: 9, height: 9 }} />
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
        <div style={{
            padding: '10px 12px 16px 40px',
            background: 'var(--bg-tertiary, rgba(255,255,255,0.02))',
            borderRadius: '0 0 8px 8px',
            animation: 'fadeIn 0.2s ease',
        }}>
            {/* Meta row */}
            <div style={{
                display: 'flex', gap: '12px', marginBottom: '12px', flexWrap: 'wrap',
                fontSize: '11px', color: 'var(--text-muted, #888)'
            }}>
                {item.conversation_id && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <ExternalLink style={{ width: 10, height: 10 }} />
                        Conv: {item.conversation_id.slice(0, 16)}…
                    </span>
                )}
                {item.message_id && (
                    <span>Msg: {item.message_id.slice(0, 16)}…</span>
                )}
                {item.organization_id && (
                    <span>Org: {item.organization_id.slice(0, 16)}…</span>
                )}
            </div>

            {/* Comment */}
            {item.comment && (
                <div style={{
                    marginBottom: '12px', padding: '10px 14px', borderRadius: '10px',
                    background: isUp ? COLORS.green + '10' : COLORS.rose + '10',
                    border: `1px solid ${isUp ? COLORS.green : COLORS.rose}25`,
                }}>
                    <div style={{
                        fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '0.04em', marginBottom: '4px',
                        color: isUp ? COLORS.green : COLORS.rose,
                    }}>{t('admin_monitoring.feedback_user_feedback', 'User Feedback')}</div>
                    <div style={{
                        fontSize: '13px', color: 'var(--text-primary, #fff)',
                        whiteSpace: 'pre-wrap', lineHeight: 1.5,
                    }}>{item.comment}</div>
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
    return (
        <div style={{ borderBottom: '1px solid var(--border-default, rgba(255,255,255,0.05))' }}>
            <div
                onClick={onToggle}
                style={{
                    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 2px',
                    cursor: 'pointer', transition: 'background 0.12s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary, rgba(255,255,255,0.03))'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
                {/* Rating icon */}
                <span style={{
                    fontSize: '18px', width: '28px', textAlign: 'center', flexShrink: 0,
                }}>{isUp ? '👍' : '👎'}</span>

                {/* Main info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
                            {item.user_id || 'Anonymous'}
                        </span>
                        <FeedbackChips item={item} snapshot={snapshot} />
                    </div>
                    {item.comment && (
                        <div style={{
                            fontSize: '12px', color: 'var(--text-secondary, #aaa)', marginTop: '3px',
                            overflow: 'hidden', textOverflow: 'ellipsis',
                            whiteSpace: expanded ? 'pre-wrap' : 'nowrap',
                            maxWidth: expanded ? 'none' : '500px',
                        }}>
                            "{item.comment}"
                        </div>
                    )}
                </div>

                <span style={{ fontSize: '11px', color: 'var(--text-muted, #888)', flexShrink: 0 }}>
                    {fmtTime(item.created_at)}
                </span>
                <ChevronRight style={{
                    width: 14, height: 14, color: 'var(--text-muted, #888)',
                    transform: expanded ? 'rotate(90deg)' : 'none',
                    transition: 'transform 0.2s', flexShrink: 0,
                }} />
            </div>

            {expanded && <FeedbackDetail item={item} snapshot={snapshot} />}
        </div>
    );
}
