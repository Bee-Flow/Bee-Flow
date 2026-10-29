import { Sparkles, Send, CheckCircle2, Loader2, Flag, Tag as TagIcon, Users, MessageSquareText, EyeOff, RotateCcw, Clock, Star, AlertTriangle } from 'lucide-react';
import { useEffect, useState, useCallback, SetStateAction, Dispatch } from 'react';
import TicketTimeline from './TicketTimeline';
import useTranslation, { TranslateParams, type TranslateFn } from '@/hooks/useTranslation';
import { API_BASE } from '@/utils/helpers';
import { useSupportCanned, useSupportTags, useSupportTeammates } from '@/api/queries/studioSupport';
import { toast } from '@/components/shared/Toast';
import EmailHtmlBody from '@/components/support/EmailHtmlBody';
import type { SupportTeammate } from './supportStudio.types';
import type { ConvLabel } from '@/components/shell/sidebar/EditLabelInline';
import type { CannedResponse } from '@/components/support/SupportInboxPanel.types';
import type { SupportThread, SupportMessage, TicketContext, TicketDetailProps, MessageBubbleProps } from './index.types';
import { mutate, ApiError, errorBody, request, RefusedError } from '@/api/mutate';
import { NOT_SUPPORT_TAG, STATUS_IDS, PRIORITY_IDS, STATUS_COLORS, statusLabel, slaBreached } from './SupportStudio.helpers';

export function TicketDetail({ threadId, user, onChanged, autoRefreshMs = 0 }: TicketDetailProps) {
    const { t } = useTranslation();
    const [thread, setThread] = useState<SupportThread | null>(null);
    const [messages, setMessages] = useState<SupportMessage[]>([]);
    const [reply, setReply] = useState('');
    const [internal, setInternal] = useState(false);
    const [busy, setBusy] = useState(false);
    const [drafting, setDrafting] = useState(false);
    const teammates = useSupportTeammates<SupportTeammate>();
    const tagPalette = useSupportTags<ConvLabel>();
    const canned = useSupportCanned<CannedResponse>();
    const [showCanned, setShowCanned] = useState(false);
    const [showActivity, setShowActivity] = useState(false);
    const [context, setContext] = useState<TicketContext | null>(null);
    const [showContext, setShowContext] = useState(false);

    const load = useCallback(async () => {
        const res = await request(`${API_BASE}/api/support-inbox/threads/${threadId}`).catch((err: unknown) => {
            if (err instanceof RefusedError) return null;
            throw err;
        });
        if (res) { const d = await res.json(); setThread(d.thread); setMessages(d.messages || []); }
    }, [threadId]);
    useEffect(() => { load(); }, [load]);

    // Keep the open conversation fresh on the same interval as the ticket list,
    // so a new customer reply or status change shows up without re-opening it.
    useEffect(() => {
        if (!autoRefreshMs) return undefined;
        const id = setInterval(() => { load(); }, autoRefreshMs);
        return () => clearInterval(id);
    }, [autoRefreshMs, load]);

    const toggleActivity = () => setShowActivity(v => !v);

    const loadContext = useCallback(async () => {
        const res = await request(`${API_BASE}/api/support-inbox/threads/${threadId}/context`).catch((err: unknown) => {
            if (err instanceof RefusedError) return null;
            throw err;
        });
        if (res) setContext(await res.json());
    }, [threadId]);
    const toggleContext = () => setShowContext(v => { const nv = !v; if (nv && !context) loadContext(); return nv; });

    const draftWithAi = async () => {
        setDrafting(true);
        try {
            try {
                const res = await mutate(`${API_BASE}/api/support-inbox/threads/${threadId}/draft`, { method: 'POST' });
                const d = await res.json().catch(() => ({}));
                if (d.message?.body) { setReply(d.message.body); setInternal(false); }
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const d = errorBody(err) ?? {};
                toast.error(d.error || t('support.composer.draft_failed', 'Could not generate draft'));
            }
            await load();
        } finally { setDrafting(false); }
    };

    const send = async () => {
        if (!reply.trim()) return;
        setBusy(true);
        try {
            try {
                await mutate(`${API_BASE}/api/support-inbox/threads/${threadId}/reply`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ body: reply, internalNote: internal }),
                });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const d = errorBody(err) ?? {};
                toast.error(d.error || t('support.composer.send_failed', 'Could not send'));
                return;
            }
            setReply(''); setInternal(false); await load(); onChanged?.();
        } finally { setBusy(false); }
    };

    const patch = async (body: Record<string, unknown>) => {
        const res = await mutate(`${API_BASE}/api/support-inbox/threads/${threadId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).catch((err: unknown) => {
            if (err instanceof ApiError) return null;
            throw err;
        });
        if (res) { await load(); onChanged?.(); }
    };

    if (!thread) return <div className="p-8 text-sm text-[var(--text-tertiary)]">{t('support.common.loading', 'Loading…')}</div>;

    const tags = Array.isArray(thread.tags) ? thread.tags : [];
    const isNotSupport = tags.includes(NOT_SUPPORT_TAG);
    const editableTags = tags.filter((tg) => tg !== NOT_SUPPORT_TAG);
    const toggleTag = (name: string) => {
        const next = editableTags.includes(name) ? editableTags.filter((x) => x !== name) : [...editableTags, name];
        // Preserve the reserved tag if present.
        patch({ tags: isNotSupport ? [...next, NOT_SUPPORT_TAG] : next });
    };

    return (
        <div className="flex flex-col h-full">
            <TicketDetailHeader thread={thread} t={t} patch={patch} />

            {/* Meta controls: priority · assignee · tags · non-support */}
            <div className="px-5 py-2 border-b border-[var(--border-default)] flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                    <Flag size={12} className="text-[var(--text-tertiary)]" />
                    <select value={thread.priority || 'normal'} onChange={e => patch({ priority: e.target.value })}
                        className="text-xs rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1.5 py-1">
                        {PRIORITY_IDS.map(p => <option key={p} value={p}>{t(`support.priority.${p}`, p)}</option>)}
                    </select>
                </label>

                <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                    <Users size={12} className="text-[var(--text-tertiary)]" />
                    <select value={thread.assignee_user_id || ''} onChange={e => patch({ assignee_user_id: e.target.value || null })}
                        className="text-xs rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-1.5 py-1 max-w-[160px]">
                        <option value="">{t('support.ticket.unassigned', 'Unassigned')}</option>
                        {user?.id && !teammates.some(tm => tm.id === user.id) && <option value={user.id}>{t('support.ticket.assign_me', 'Assign to me')}</option>}
                        {teammates.map(tm => <option key={tm.id} value={tm.id}>{tm.name || tm.email || tm.id}{tm.id === user?.id ? ` (${t('support.ticket.you', 'you')})` : ''}</option>)}
                    </select>
                </label>

                {tagPalette.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <TagIcon size={12} className="text-[var(--text-tertiary)]" />
                        {tagPalette.filter(tg => tg.name !== NOT_SUPPORT_TAG).map(tg => (
                            <button key={tg.id || tg.name} onClick={() => toggleTag(tg.name)}
                                className={`px-1.5 py-0.5 rounded border text-[11px] ${editableTags.includes(tg.name)
                                    ? 'border-[var(--accent-primary)] bg-[var(--bg-secondary)] text-[var(--text-primary)]'
                                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}>
                                {tg.name}
                            </button>
                        ))}
                    </div>
                )}

                <div className="flex items-center gap-2 ml-auto">
                    {slaBreached(thread) && (
                        <span className="flex items-center gap-1 text-[11px] text-rose-500" title={t('support.ticket.sla_breached', 'SLA breached')}>
                            <AlertTriangle size={12} /> {t('support.ticket.sla_breached', 'SLA breached')}
                        </span>
                    )}
                    {thread.csat_score != null && (
                        <span className="flex items-center gap-1 text-[11px] text-amber-500" title={thread.csat_comment || ''}>
                            <Star size={12} /> {thread.csat_score}/5
                        </span>
                    )}
                    <button onClick={toggleContext}
                        className={`flex items-center gap-1 px-2 py-1 rounded border text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] ${showContext ? 'border-[var(--accent-primary)]' : 'border-[var(--border-default)]'}`}>
                        <Users size={12} /> {t('support.ticket.customer', 'Customer')}
                    </button>
                    <button onClick={toggleActivity}
                        className={`flex items-center gap-1 px-2 py-1 rounded border text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] ${showActivity ? 'border-[var(--accent-primary)]' : 'border-[var(--border-default)]'}`}>
                        <Clock size={12} /> {t('support.ticket.activity', 'Activity')}
                    </button>
                    <button onClick={() => patch(isNotSupport ? { unfilter: true } : { markNotSupport: true })}
                        className="flex items-center gap-1 px-2 py-1 rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                        {isNotSupport ? <><RotateCcw size={12} /> {t('support.ticket.is_support', 'This is support')}</> : <><EyeOff size={12} /> {t('support.ticket.mark_not_support', 'Not support')}</>}
                    </button>
                </div>
            </div>

            {showContext && <TicketContextPanel context={context} t={t} />}

            {showActivity && (
                <div className="px-5 py-2 border-b border-[var(--border-default)] max-h-56 overflow-y-auto">
                    <TicketTimeline threadId={threadId} teammates={teammates} />
                </div>
            )}

            <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
                {messages.map(m => <MessageBubble key={m.id} m={m} t={t} />)}
            </div>

            <TicketDetailSection reply={reply} setReply={setReply} internal={internal} t={t} setInternal={setInternal} canned={canned} setShowCanned={setShowCanned} showCanned={showCanned} draftWithAi={draftWithAi} drafting={drafting} send={send} busy={busy} />
        </div>
    );
}

/** The customer panel: profile, plan and recent tickets, once the context has loaded. */
function TicketContextPanel({ context, t }: { context: TicketContext | null; t: TranslateFn }) {
    return (
        <div className="px-5 py-2 border-b border-[var(--border-default)] text-[11px] text-[var(--text-secondary)] flex flex-col gap-1">
            {!context ? <span className="italic text-[var(--text-tertiary)]">{t('support.common.loading', 'Loading…')}</span> : (
                <>
                    {context.profile && (
                        <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                            <span><span className="text-[var(--text-tertiary)]">{t('support.context.name', 'Name')}:</span> {context.profile.name || '—'}</span>
                            <span><span className="text-[var(--text-tertiary)]">{t('support.context.org', 'Organization')}:</span> {context.profile.organizationName || '—'}</span>
                            <span><span className="text-[var(--text-tertiary)]">{t('support.context.role', 'Role')}:</span> {context.profile.orgRole || '—'}</span>
                            <span><span className="text-[var(--text-tertiary)]">{t('support.context.logged_in', 'Logged in')}:</span> {context.profile.loggedIn ? '✓' : '—'}</span>
                        </div>
                    )}
                    {context.subscription && context.subscription.status && (
                        <div><span className="text-[var(--text-tertiary)]">{t('support.context.plan', 'Plan')}:</span> {context.subscription.planName || context.subscription.planTier || '—'} · {context.subscription.status}</div>
                    )}
                    {Array.isArray(context.recentThreads) && context.recentThreads.length > 0 && (
                        <div>
                            <span className="text-[var(--text-tertiary)]">{t('support.context.recent', 'Recent tickets')}:</span>{' '}
                            {context.recentThreads.map((rt, i) => <span key={i}>{i > 0 ? ', ' : ''}{rt.subject || '(no subject)'} ({statusLabel(t, rt.status)})</span>)}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function TicketDetailHeader({ thread, t, patch }: { thread: SupportThread; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; patch: (body: Record<string, unknown>) => Promise<void>; }) {
    return <header className="px-5 py-3 border-b border-[var(--border-default)] flex items-center justify-between gap-3">
        <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--text-primary)] truncate">{thread.subject || t('support.thread.no_subject', '(no subject)')}</div>
            <div className="text-xs text-[var(--text-tertiary)] truncate">{thread.requester_email} · <span className={STATUS_COLORS[thread.status]}>{statusLabel(t, thread.status)}</span></div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
            <select value={thread.status} onChange={e => patch({ status: e.target.value })}
                className="text-xs rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1">
                {STATUS_IDS.map(s => <option key={s} value={s}>{statusLabel(t, s)}</option>)}
            </select>
            {thread.status !== 'resolved' && (
                <button onClick={() => patch({ status: 'resolved' })}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-green-500/40 text-green-600 dark:text-green-400 hover:bg-green-500/10">
                    <CheckCircle2 size={12} /> {t('support.ticket.resolve', 'Resolve')}
                </button>
            )}
        </div>
    </header>;
}

function TicketDetailSection({ reply, setReply, internal, t, setInternal, canned, setShowCanned, showCanned, draftWithAi, drafting, send, busy }: { reply: string; setReply: Dispatch<SetStateAction<string>>; internal: boolean; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; setInternal: Dispatch<SetStateAction<boolean>>; canned: CannedResponse[]; setShowCanned: Dispatch<SetStateAction<boolean>>; showCanned: boolean; draftWithAi: () => Promise<void>; drafting: boolean; send: () => Promise<void>; busy: boolean; }) {
    return <div className="border-t border-[var(--border-default)] p-3 flex flex-col gap-2">
        <textarea value={reply} onChange={e => setReply(e.target.value)} rows={4}
            placeholder={internal ? t('support.composer.internal_placeholder', 'Internal note (not visible to the customer)…') : t('support.composer.reply_placeholder', 'Type your reply… or let the AI draft one.')}
            className="text-sm rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 resize-y" />
        <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                <input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} /> {t('support.composer.internal_note', 'Internal note')}
            </label>
            <div className="flex items-center gap-2">
                {canned.length > 0 && (
                    <div className="relative">
                        <button onClick={() => setShowCanned(v => !v)}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-[var(--border-default)] hover:bg-[var(--bg-secondary)]">
                            <MessageSquareText size={13} /> {t('support.composer.insert_canned', 'Canned reply')}
                        </button>
                        {showCanned && (
                            <div className="absolute bottom-full mb-1 right-0 w-64 max-h-60 overflow-y-auto rounded border border-[var(--border-default)] bg-[var(--bg-card)] shadow-lg z-10">
                                {canned.map(c => (
                                    <button key={c.id || c.shortcut || c.title} onClick={() => { setReply(r => (r ? `${r}\n\n` : '') + (c.body || '')); setShowCanned(false); } }
                                        className="block w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-secondary)] border-b border-[var(--border-default)] last:border-0">
                                        <div className="font-medium text-[var(--text-primary)] truncate">{c.title}{c.shortcut ? ` · ${c.shortcut}` : ''}</div>
                                        <div className="text-[var(--text-tertiary)] truncate">{c.body}</div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <button onClick={draftWithAi} disabled={drafting}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-[var(--border-default)] hover:bg-[var(--bg-secondary)] disabled:opacity-60">
                    {drafting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} {t('support.composer.ai_draft', 'AI draft')}
                </button>
                <button onClick={send} disabled={busy || !reply.trim()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded text-white font-medium disabled:opacity-60 bg-[var(--accent-primary)]">
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} {internal ? t('support.composer.save_note', 'Save note') : t('support.composer.send', 'Send')}
                </button>
            </div>
        </div>
    </div>;
}

function MessageBubble({ m, t }: MessageBubbleProps) {
    const isReq = m.author_kind === 'requester';
    const isSystem = m.author_kind === 'system';
    const isInternal = m.internal_note;
    const isDraft = m.email_send_status && m.email_send_status.state === 'draft';
    const align = isReq ? 'items-start' : 'items-end';
    const bubble = isReq
        ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)]'
        : isInternal
            ? 'bg-amber-500/10 border border-amber-500/30 text-[var(--text-primary)]'
            : 'text-white';
    if (isSystem) {
        return <div className="text-center text-[11px] text-[var(--text-tertiary)] italic py-1">{m.body}</div>;
    }
    return (
        <div className={`flex flex-col ${align}`}>
            <div className="text-[10px] text-[var(--text-tertiary)] mb-0.5 px-1">
                {m.author_display || m.author_kind}
                {isInternal && ` · ${t('support.message.internal_note', 'internal note')}`}
                {isDraft && ` · ${t('support.message.draft_unsent', 'draft (not sent)')}`}
                {m.email_send_status && m.email_send_status.ok === false && ` · ${t('support.message.send_failed', '⚠ send failed')}`}
            </div>
            {m.body_html ? (
                <div className="w-full max-w-[680px] rounded-lg overflow-hidden border border-[var(--border-default)] bg-white">
                    <EmailHtmlBody html={m.body_html} />
                </div>
            ) : (
                <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${bubble}`}
                    style={!isReq && !isInternal ? { background: 'var(--accent-primary)' } : undefined}>
                    {m.body}
                </div>
            )}
            {Array.isArray(m.attachments) && m.attachments.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1 px-1 max-w-[80%]">
                    {m.attachments.map((a, i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-tertiary)]" title={a.mimeType || ''}>
                            📎 {a.filename || t('support.message.attachment', 'attachment')}
                        </span>
                    ))}
                </div>
            )}
            {Array.isArray(m.kb_citations) && m.kb_citations.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1 px-1 max-w-[80%]">
                    {m.kb_citations.map((c, i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-tertiary)]" title={`score ${c.score ?? ''}`}>
                            📎 {c.title}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}
