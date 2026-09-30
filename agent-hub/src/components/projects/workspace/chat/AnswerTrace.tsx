// "How I got this answer": what the Privacy Shield replaced before the
// message went to the model, and what came back, as a normal chat shows it.
// Read only when opened; the server keeps it sealed with the project key and
// gives it to whoever may read the chat.

import { Brain, ChevronDown, Copy, Lock } from 'lucide-react';
import React, { useState } from 'react';
import { useTeamChatTrace, type TeamChatAiMeta, type TeamChatTrace } from '../../../../api/queries/projectChats';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import { tierLabel } from '../../../licensing/tierMeta';

function Block({ label, note, text }: { label: string; note?: string; text: string }) {
    const { t } = useTranslation();
    const copy = () => {
        Promise.resolve(navigator.clipboard?.writeText(text))
            .then(() => toast.success(t('project_chat.trace_copied', 'Copied')))
            .catch(() => toast.error(t('project_chat.trace_copy_failed', 'Could not copy')));
    };
    return (
        <div className="space-y-1">
            <div className="flex items-center gap-2">
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{label}</span>
                {note && <span className="text-[10.5px] text-[var(--text-secondary)]">· {note}</span>}
                <button type="button" onClick={copy} aria-label={t('project_chat.trace_copy', 'Copy {label}', { label })}
                    className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                    <Copy className="w-3 h-3" aria-hidden="true" />{t('project_chat.trace_copy_short', 'Copy')}
                </button>
            </div>
            <pre className="m-0 px-2.5 py-2 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] text-[12px] leading-snug whitespace-pre-wrap break-words font-mono text-[var(--text-primary)]">{text}</pre>
        </div>
    );
}

function Body({ trace, redacted }: { trace: TeamChatTrace; redacted: number }) {
    const { t } = useTranslation();
    const mapping = Object.entries(trace.tokenMap).map(([token, value]) => `${token} → ${value}`).join('\n');
    return (
        <div className="space-y-3 pt-2" data-testid="team-chat-answer-trace-body">
            <p className="m-0 text-[12px] text-[var(--text-secondary)]">
                {t('project_chat.trace_summary', 'Privacy protection replaced {count} values with placeholders before this reached {model}. The real values were put back in the answer you read.', {
                    count: redacted, model: trace.model || t('project_chat.trace_the_model', 'the model'),
                })}
            </p>
            {trace.categories.length > 0 && (
                <p className="m-0 text-[12px] text-[var(--text-secondary)]">{t('project_chat.trace_detected', 'Detected: {kinds}', { kinds: trace.categories.join(', ') })}</p>
            )}
            <Block label={t('project_chat.trace_original', 'Original message')} note={t('project_chat.trace_original_note', 'as written in this chat')} text={trace.original} />
            <Block label={t('project_chat.trace_sent', 'Sent to the AI')} note={trace.model || undefined} text={trace.sent} />
            <Block label={t('project_chat.trace_mapping', 'Placeholders')} note={t('project_chat.trace_mapping_note', '{count} items', { count: Object.keys(trace.tokenMap).length })} text={mapping} />
            <Block label={t('project_chat.trace_returned', 'What the AI returned')} note={t('project_chat.trace_returned_note', 'placeholders intact')} text={trace.returned} />
        </div>
    );
}

/** The one-line note under an answer, and — when values were replaced — the panel that says how. */
export default function AnswerTrace({ meta, projectId, chatId, messageId }: { meta: TeamChatAiMeta; projectId: string | null; chatId: string | null; messageId: string }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const canOpen = !!meta.trace && !!projectId && !!chatId;
    const query = useTeamChatTrace(projectId || '', chatId || '', messageId, canOpen && open);
    const depth = meta.tier ? tierLabel(meta.tier, {}) : '';
    if (!depth && !meta.redacted) return null;
    const summary = (
        <>
            <Brain className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            <span className="font-medium">{t('project_chat.trace_title', 'How I got this answer')}</span>
            {depth && (
                <span className="px-1.5 py-px rounded-full bg-[var(--bg-tertiary)] text-[var(--text-primary)]">
                    {meta.requestedTier === 'auto' ? t('project_chat.answer_auto_tier', 'Auto → {tier}', { tier: depth }) : depth}
                </span>
            )}
            {meta.redacted > 0 && (
                <span className="inline-flex items-center gap-1 px-1.5 py-px rounded-full bg-[var(--bg-tertiary)] text-[var(--text-primary)]" title={meta.categories.join(', ') || undefined}>
                    <Lock className="w-3 h-3" aria-hidden="true" />
                    {meta.redacted === 1
                        ? t('project_chat.shield_one', '1 value replaced by Privacy protection')
                        : t('project_chat.shield_many', '{count} values replaced by Privacy protection', { count: meta.redacted })}
                </span>
            )}
        </>
    );
    if (!canOpen) {
        return <p className="m-0 mt-1 flex items-center flex-wrap gap-2 text-[11.5px] text-[var(--text-secondary)]" data-testid="team-chat-answer-meta">{summary}</p>;
    }
    return (
        <div className="mt-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]/60 px-2.5 py-1.5" data-testid="team-chat-answer-meta">
            <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
                className="w-full flex items-center flex-wrap gap-2 text-[11.5px] text-[var(--text-secondary)] text-left bg-transparent p-0 border-0 cursor-pointer">
                {summary}
                <ChevronDown className={`ml-auto w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {open && query.isPending && <p className="m-0 pt-2 text-[12px] text-[var(--text-secondary)]" role="status">{t('project_chat.trace_loading', 'Loading…')}</p>}
            {open && query.isError && <p className="m-0 pt-2 text-[12px] text-[var(--error-ink)]" role="alert">{t('project_chat.trace_failed', 'This is no longer available.')}</p>}
            {open && query.data && <Body trace={query.data} redacted={meta.redacted} />}
        </div>
    );
}
