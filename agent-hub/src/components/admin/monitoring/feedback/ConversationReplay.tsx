import { Bot, MessageSquare, User } from 'lucide-react';
import type { SnapshotMessage } from './feedbackModel';
import { useTranslation } from '@/hooks/useTranslation';
import { fmtTime } from '../shared';
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
        <div className={`flex ${isUserMsg ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-xl border px-3 py-2 ${isUserMsg
                ? 'border-[var(--border-default)] bg-[var(--bg-tertiary)]'
                : 'border-[var(--border-default)] bg-[var(--bg-card)]'}`}
            >
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold text-[var(--text-tertiary)]">
                    {isUserMsg ? <User className="h-2.5 w-2.5" aria-hidden="true" /> : <Bot className="h-2.5 w-2.5" aria-hidden="true" />}
                    <span>{isUserMsg ? 'User' : 'AI'}</span>
                    {msg.timestamp && <span className="ml-auto pl-2 font-normal">{fmtTime(msg.timestamp)}</span>}
                </div>
                <div className="prose prose-sm max-w-none break-words text-[13px] leading-relaxed text-[var(--text-primary)] dark:prose-invert">
                    {isUserMsg
                        ? <span className="whitespace-pre-wrap">{truncated}</span>
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
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--text-tertiary)]">
                <MessageSquare className="h-3 w-3" aria-hidden="true" />
                {t('admin_monitoring.feedback_conversation', 'Conversation ({n} messages)', { n: snapshot.length })}
            </div>
            <div className="flex max-h-[400px] flex-col gap-1.5 overflow-y-auto p-0.5">
                {snapshot.map((msg, mi) => <SnapshotBubble key={mi} msg={msg} />)}
            </div>
        </div>
    );
}

/** No conversation was shared with this feedback. */
export function NoConversation() {
    const { t } = useTranslation();
    return (
        <div className="rounded-lg border border-dashed border-[var(--border-default)] bg-[var(--bg-card)] p-4 text-center">
            <MessageSquare className="mx-auto mb-1.5 h-5 w-5 text-[var(--text-tertiary)]" aria-hidden="true" />
            <div className="text-xs text-[var(--text-secondary)]">{t('admin_monitoring.feedback_no_convo', 'No conversation shared')}</div>
            <div className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">
                {t('admin_monitoring.feedback_no_convo_hint', 'User did not include conversation context with this feedback')}
            </div>
        </div>
    );
}
