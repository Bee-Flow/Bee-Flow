import { Bot, Clock, Cpu, MessageSquare, Repeat, User } from 'lucide-react';
import MarkdownRenderer from '@/components/renderers/MarkdownRenderer';
import { useTranslation } from '@/hooks/useTranslation';
import { fmtDuration, shortModel } from '../format';
import type { SnapshotMessage } from './qualityModel';

const CHIP = 'inline-flex items-center gap-[3px] rounded px-1.5 py-px text-[10px] font-semibold';
const MAX_CHARS = 800;

interface MessageProps {
    msg: SnapshotMessage;
    /** The model of the previous assistant turn, to flag a switch. */
    prevModel: string | null;
}

function ModelChip({ model, prevModel }: { model: string; prevModel: string | null }) {
    const { t } = useTranslation();
    const switched = !!prevModel && model !== prevModel;
    return (
        <span
            className={`${CHIP} ${switched ? 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}
            title={switched ? `${t('org.feedback_model_switched', 'Model switched from previous turn')}: ${prevModel} → ${model}` : model}
        >
            {switched ? <Repeat className="h-[9px] w-[9px]" aria-hidden="true" /> : <Cpu className="h-[9px] w-[9px]" aria-hidden="true" />}
            {shortModel(model)}
        </span>
    );
}

function Message({ msg, prevModel }: MessageProps) {
    const { t } = useTranslation();
    const isUser = msg.role === 'user';
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    if (!content || content.trim().length === 0) return null;
    const text = content.length > MAX_CHARS ? `${content.slice(0, MAX_CHARS)}…` : content;
    const duration = isUser ? null : fmtDuration(msg.duration_ms, { invalid: null });
    const model = isUser ? null : (msg.model || null);
    return (
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-xl border px-3 py-2 ${isUser ? 'border-[var(--border-subtle)] bg-[var(--bg-secondary)]' : 'border-[var(--border-default)] bg-[var(--bg-primary)]'}`}>
                <div className="mb-1 flex flex-wrap items-center gap-[5px] text-[10px] font-semibold text-[var(--text-muted)]">
                    {isUser ? <User className="h-2.5 w-2.5" aria-hidden="true" /> : <Bot className="h-2.5 w-2.5" aria-hidden="true" />}
                    <span>{isUser ? t('org.feedback_role_user', 'User') : t('org.feedback_role_ai', 'AI')}</span>
                    {model && <ModelChip model={model} prevModel={prevModel} />}
                    {duration && (
                        <span className={`${CHIP} bg-[var(--bg-tertiary)] text-[var(--text-secondary)]`} title={t('org.feedback_response_time', 'Response time')}>
                            <Clock className="h-[9px] w-[9px]" aria-hidden="true" />{duration}
                        </span>
                    )}
                </div>
                <div className="prose prose-sm dark:prose-invert max-w-none break-words text-[13px] leading-[1.6] text-[var(--text-primary)]">
                    {isUser ? <span className="whitespace-pre-wrap">{text}</span> : <MarkdownRenderer content={text} />}
                </div>
            </div>
        </div>
    );
}

/** For each message, the model of the assistant turn before it (null before the first). */
function previousModels(snapshot: SnapshotMessage[]): (string | null)[] {
    const out: (string | null)[] = [];
    let prev: string | null = null;
    for (const msg of snapshot) {
        out.push(prev);
        if (msg.role !== 'user' && msg.model) prev = msg.model;
    }
    return out;
}

export interface ConversationViewerProps {
    snapshot: SnapshotMessage[];
}

/** The messages of a conversation the person chose to share with the feedback. */
export function ConversationViewer({ snapshot }: ConversationViewerProps) {
    const { t } = useTranslation();
    const prev = previousModels(snapshot);
    const messages = snapshot.map((msg, i) => <Message key={i} msg={msg} prevModel={prev[i]} />);
    return (
        <div>
            <div className="mb-2 flex items-center gap-[5px] text-[11px] font-bold uppercase tracking-[.04em] text-[var(--text-secondary)]">
                <MessageSquare className="h-[11px] w-[11px]" aria-hidden="true" />{t('org.feedback_conversation', 'Conversation')} ({snapshot.length})
            </div>
            <div className="flex max-h-[360px] flex-col gap-1.5 overflow-y-auto">{messages}</div>
        </div>
    );
}
