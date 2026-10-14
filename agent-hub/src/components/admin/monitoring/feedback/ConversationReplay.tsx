import { Bot, MessageSquare, User } from 'lucide-react';
import type { SnapshotMessage } from './feedbackModel';
import { useTranslation } from '../../../../hooks/useTranslation';
import { COLORS, fmtTime } from '../shared';
import { MarkdownRenderer } from '../sharedTyped';

/** One message of the shared conversation; empty system/tool messages render nothing. */
function SnapshotBubble({ msg }: { msg: SnapshotMessage }) {
    const isUserMsg = msg.role === 'user';
    const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
    // Skip empty system/tool messages
    if (!content || content.trim().length === 0) return null;
    // Truncate very long messages
    const truncated = content.length > 800
        ? content.slice(0, 800) + '…'
        : content;

    return (
        <div style={{
            display: 'flex',
            justifyContent: isUserMsg ? 'flex-end' : 'flex-start',
        }}>
            <div style={{
                maxWidth: '85%',
                padding: '8px 12px', borderRadius: '12px',
                background: isUserMsg
                    ? 'var(--bg-secondary, #1a1a2e)'
                    : 'var(--bg-primary, #0f0f1a)',
                border: `1px solid ${isUserMsg
                    ? 'var(--border-default, rgba(255,255,255,0.08))'
                    : COLORS.primary + '20'
                }`,
            }}>
                <div style={{
                    display: 'flex', alignItems: 'center', gap: '5px',
                    marginBottom: '4px',
                }}>
                    {isUserMsg
                        ? <User style={{ width: 10, height: 10, color: 'var(--text-muted, #888)' }} />
                        : <Bot style={{ width: 10, height: 10, color: COLORS.primary }} />
                    }
                    <span style={{
                        fontSize: '10px', fontWeight: 600,
                        color: isUserMsg ? 'var(--text-muted, #888)' : COLORS.primary,
                    }}>
                        {isUserMsg ? 'User' : 'AI'}
                    </span>
                    {msg.timestamp && (
                        <span style={{
                            fontSize: '9px', color: 'var(--text-muted, #666)',
                            marginLeft: 'auto',
                        }}>
                            {fmtTime(msg.timestamp)}
                        </span>
                    )}
                </div>
                <div style={{
                    fontSize: '13px',
                    color: 'var(--text-primary, #fff)',
                    wordBreak: 'break-word',
                    lineHeight: 1.6,
                }} className="prose prose-sm dark:prose-invert max-w-none">
                    {isUserMsg
                        ? <span style={{ whiteSpace: 'pre-wrap' }}>{truncated}</span>
                        : <MarkdownRenderer content={truncated} />
                    }
                </div>
            </div>
        </div>
    );
}

/** The conversation the user shared with their feedback. */
export function ConversationReplay({ snapshot }: { snapshot: SnapshotMessage[] }) {
    const { t } = useTranslation();
    return (
        <div>
            <div style={{
                fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.04em', marginBottom: '8px',
                color: COLORS.blue, display: 'flex', alignItems: 'center', gap: '5px',
            }}>
                <MessageSquare style={{ width: 11, height: 11 }} />
                {t('admin_monitoring.feedback_conversation', 'Conversation ({n} messages)', { n: snapshot.length })}
            </div>
            <div style={{
                maxHeight: '400px', overflowY: 'auto',
                display: 'flex', flexDirection: 'column', gap: '6px',
                padding: '2px',
            }}>
                {snapshot.map((msg, mi) => <SnapshotBubble key={mi} msg={msg} />)}
            </div>
        </div>
    );
}

/** No conversation was shared with this feedback. */
export function NoConversation() {
    const { t } = useTranslation();
    return (
        <div style={{
            padding: '16px', borderRadius: '10px', textAlign: 'center',
            background: 'var(--bg-primary, #0f0f1a)',
            border: '1px dashed var(--border-default, rgba(255,255,255,0.08))',
        }}>
            <MessageSquare style={{ width: 20, height: 20, color: 'var(--text-muted, #555)', margin: '0 auto 6px' }} />
            <div style={{ fontSize: '12px', color: 'var(--text-muted, #666)' }}>
                {t('admin_monitoring.feedback_no_convo', 'No conversation shared')}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted, #555)', marginTop: '2px' }}>
                {t('admin_monitoring.feedback_no_convo_hint', 'User did not include conversation context with this feedback')}
            </div>
        </div>
    );
}
