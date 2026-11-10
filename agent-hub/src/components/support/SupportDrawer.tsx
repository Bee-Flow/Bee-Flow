/**
 * Support drawer parts — reusable building blocks for the user-side support
 * surface. The floating Help-button drawer was retired in favour of an
 * AdvancedSettings → "Help & Support" section; HelpSupportSection imports
 * NewThreadForm + ThreadDetail from this module and composes them into the
 * settings page layout.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Send, ArrowLeft, Bot, User, AlertTriangle } from 'lucide-react';
import { API_BASE } from '../../utils/helpers';
import { useTranslation, type TranslateFn } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import { mutate, ApiError, request, RefusedError, errorBody } from '../../api/mutate';
import { FIELD_INPUT } from '@/components/shared/SettingsList';
import { PRIMARY_BTN, QUIET_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';

export const STATUS_LABELS: Record<string, string> = {
    open: 'Open',
    ai_responding: 'AI replying',
    awaiting_user: 'Reply from Bee Flow',
    awaiting_agent: 'Waiting on Bee Flow',
    resolved: 'Resolved',
    closed: 'Closed',
};

/** STATUS_LABELS through the dictionary, for this module's own screens. */
function statusLabel(status: string, t: TranslateFn): string {
    const labels: Record<string, string> = {
        open: t('support.drawer_status_open', 'Open'),
        ai_responding: t('support.drawer_status_ai_responding', 'AI replying'),
        awaiting_user: t('support.drawer_status_awaiting_user', 'Reply from Bee Flow'),
        awaiting_agent: t('support.drawer_status_awaiting_agent', 'Waiting on Bee Flow'),
        resolved: t('support.drawer_status_resolved', 'Resolved'),
        closed: t('support.drawer_status_closed', 'Closed'),
    };
    return labels[status] || status;
}

/** Who wrote a message: requester, AI, system or staff, each on its own surface. */
const AUTHOR_SURFACE: Record<string, string> = {
    requester: 'bg-[var(--bg-tertiary)]',
    ai: 'bg-[color-mix(in_srgb,var(--info)_8%,transparent)]',
    system: 'bg-[var(--bg-secondary)]',
};
const STAFF_SURFACE = 'bg-[color-mix(in_srgb,var(--success)_8%,transparent)]';

export function formatRelative(iso?: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    const m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return d.toLocaleDateString();
}

export function NewThreadForm({ onCreated, onCancel }: { onCreated?: (threadId: string) => void; onCancel?: React.MouseEventHandler<HTMLButtonElement> }) {
    const { t } = useTranslation();
    const [subject, setSubject] = useState<string>('');
    const [message, setMessage] = useState<string>('');
    const [submitting, setSubmitting] = useState<boolean>(false);
    const [err, setErr] = useState<string | null | undefined>(null);

    const submit = async () => {
        setErr(null);
        if (!subject.trim() || !message.trim()) {
            setErr(t('support.drawer_subject_and_message_required', 'Subject and message are required'));
            return;
        }
        setSubmitting(true);
        try {
            let data: { threadId: string };
            try {
                const res = await mutate(`${API_BASE}/api/support/threads`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ subject: subject.trim(), message: message.trim(), source: 'in_app' }),
                });
                data = await res.json();
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                setErr((errorBody(err) as { error?: string } | null)?.error || 'Could not submit. Please try again.');
                return;
            }
            onCreated && onCreated(data.threadId);
        } catch (e) {
            setErr(errorMessage(e));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="p-4 space-y-3">
            <input
                value={subject}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSubject(e.target.value)}
                placeholder={t('support.support_drawer_what_s_this_about', 'What\'s this about?')}
                maxLength={200}
                className={FIELD_INPUT}
            />
            <textarea
                rows={6}
                value={message}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setMessage(e.target.value)}
                // Auto-grow up to a cap so a long message isn't cramped in a
                // fixed box, plus a visible counter — the box reads as "not
                // resizable / limit unclear" otherwise (BFSF-198).
                onInput={(e: React.FormEvent<HTMLTextAreaElement>) => { (e.target as HTMLTextAreaElement).style.height = 'auto'; (e.target as HTMLTextAreaElement).style.height = Math.min((e.target as HTMLTextAreaElement).scrollHeight, 360) + 'px'; }}
                placeholder={t('support.support_drawer_describe_what_you_need_help_with_the', 'Describe what you need help with. The Bee Flow AI assistant will reply first and hand off to a human if needed.')}
                maxLength={10000}
                className={`${FIELD_INPUT} max-h-[360px] resize-y`}
            />
            <div className="text-right text-[11px] text-[var(--text-tertiary)]">{message.length} / 10000</div>
            {err && <div className="text-xs text-[var(--error-ink)]">{err}</div>}
            <div className="flex justify-end gap-2">
                <button type="button" onClick={onCancel} className={SECONDARY_BTN}>{t('support.support_drawer_cancel', 'Cancel')}</button>
                <button type="button" onClick={submit} disabled={submitting} className={PRIMARY_BTN}>
                    <Send className="h-3.5 w-3.5" aria-hidden="true" /> {submitting ? t('support.drawer_sending', 'Sending…') : t('support.drawer_send_to_bee_flow', 'Send to Bee Flow')}
                </button>
            </div>
        </div>
    );
}

interface SupportThread {
    subject?: string;
    status: string;
}

interface SupportMessage {
    id: string;
    author_kind: string;
    author_display?: string;
    created_at?: string;
    body?: string;
}

export function ThreadDetail({ threadId, onBack, onChanged }: { threadId: string; onBack?: React.MouseEventHandler<HTMLButtonElement>; onChanged?: () => void }) {
    const { t } = useTranslation();
    const [thread, setThread] = useState<SupportThread | null>(null);
    const [messages, setMessages] = useState<SupportMessage[]>([]);
    const [reply, setReply] = useState<string>('');
    const [sending, setSending] = useState<boolean>(false);

    const load = useCallback(async () => {
        const res = await request(`${API_BASE}/api/support/threads/${threadId}`).catch((err: unknown) => {
            if (err instanceof RefusedError) return null;
            throw err;
        });
        if (res) {
            const data = await res.json();
            setThread(data.thread);
            setMessages(data.messages || []);
        }
    }, [threadId]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        const id = setInterval(load, 10000);
        return () => clearInterval(id);
    }, [load]);

    const send = async () => {
        const body = reply.trim();
        if (!body) return;
        setSending(true);
        try {
            const res = await mutate(`${API_BASE}/api/support/threads/${threadId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body }),
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                setReply('');
                await load();
                onChanged && onChanged();
            }
        } finally {
            setSending(false);
        }
    };

    if (!thread) return <div className="p-4 text-sm text-[var(--text-tertiary)]">{t('support.support_drawer_loading', 'Loading…')}</div>;

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center gap-2 border-b border-[var(--border-default)] px-3 py-2">
                <button type="button" onClick={onBack} className={QUIET_BTN} aria-label={t('support.drawer_back', 'Back')}><ArrowLeft className="h-4 w-4" aria-hidden="true" /></button>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--text-primary)]">{thread.subject}</div>
                    <div className="text-xs text-[var(--text-tertiary)]">{statusLabel(thread.status, t)}</div>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {messages.map((m: SupportMessage) => {
                    const isMe = m.author_kind === 'requester';
                    const isAI = m.author_kind === 'ai';
                    const isSystem = m.author_kind === 'system';
                    return (
                        <div key={m.id} className={`rounded-lg border border-[var(--border-default)] p-2.5 text-sm text-[var(--text-primary)] ${AUTHOR_SURFACE[m.author_kind] || STAFF_SURFACE}`}>
                            <div className="mb-1 flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                                {isAI ? <Bot className="h-3 w-3" aria-hidden="true" /> : isSystem ? <AlertTriangle className="h-3 w-3" aria-hidden="true" /> : <User className="h-3 w-3" aria-hidden="true" />}
                                <span>{m.author_display || (isMe ? t('support.drawer_you', 'You') : m.author_kind)}</span>
                                <span className="ml-auto">{formatRelative(m.created_at)}</span>
                            </div>
                            <div className="whitespace-pre-wrap">{m.body}</div>
                        </div>
                    );
                })}
            </div>
            {thread.status !== 'resolved' && thread.status !== 'closed' && (
                <div className="border-t border-[var(--border-default)] p-2">
                    <textarea
                        rows={4}
                        value={reply}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReply(e.target.value)}
                        // Auto-grow + explicit cap so over-limit input is prevented
                        // client-side instead of silently failing the server cap (BFSF-198).
                        onInput={(e: React.FormEvent<HTMLTextAreaElement>) => { (e.target as HTMLTextAreaElement).style.height = 'auto'; (e.target as HTMLTextAreaElement).style.height = Math.min((e.target as HTMLTextAreaElement).scrollHeight, 240) + 'px'; }}
                        placeholder={t('support.support_drawer_reply', 'Reply…')}
                        maxLength={10000}
                        className={`${FIELD_INPUT} max-h-[240px] resize-y`}
                    />
                    {reply.length > 0 && <div className="mt-0.5 text-right text-[11px] text-[var(--text-tertiary)]">{reply.length} / 10000</div>}
                    <div className="mt-1.5 flex justify-end">
                        <button type="button" onClick={send} disabled={sending || !reply.trim()} className={PRIMARY_BTN}>
                            <Send className="h-3 w-3" aria-hidden="true" /> {sending ? t('support.drawer_sending', 'Sending…') : t('support.drawer_send', 'Send')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

// The floating-drawer default export was retired in iteration 2. The
// settings-side surface lives in HelpSupportSection.jsx and imports
// NewThreadForm + ThreadDetail directly from this module.
