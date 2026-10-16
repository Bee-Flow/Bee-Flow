import { AlertTriangle, Bot, User } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import EmailHtmlBody from './EmailHtmlBody';
import { formatRelative } from './supportInboxLabels';
import type { SupportMessage } from './SupportInboxPanel.types';

/** The conversation of the open thread, one card per message. */
export default function SupportMessageList({ messages }: { messages: SupportMessage[] }) {
    const { t } = useTranslation();
    return (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map(m => {
                const isStaff = m.author_kind === 'staff';
                const isAI = m.author_kind === 'ai';
                const isSystem = m.author_kind === 'system';
                return (
                    <div key={m.id} className="rounded-lg p-3 text-sm" style={{
                        background: m.internal_note ? 'rgba(245,158,11,0.08)'
                            : isStaff ? 'rgba(16,185,129,0.08)'
                                : isAI ? 'rgba(14,165,233,0.08)'
                                    : isSystem ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
                        border: '1px solid var(--border-default)',
                        color: 'var(--text-primary)',
                    }}>
                        <div className="flex items-center gap-2 text-xs mb-1 text-[var(--text-muted)]">
                            {isAI ? <Bot className="w-3.5 h-3.5" /> : isStaff ? <User className="w-3.5 h-3.5" /> : isSystem ? <AlertTriangle className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
                            <span className="font-medium text-[var(--text-secondary)]">
                                {m.author_display || m.author_kind}
                            </span>
                            {m.internal_note && <span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(245,158,11,0.2)', color: '#b45309' }}>{t('support.support_inbox_internal_note', 'internal note')}</span>}
                            <span className="ml-auto">{formatRelative(m.created_at)}</span>
                        </div>
                        {m.body_html ? (
                            <div className="rounded-md overflow-hidden border bg-white border-[var(--border-default)]">
                                <EmailHtmlBody html={m.body_html} />
                            </div>
                        ) : (
                            <div className="whitespace-pre-wrap">{m.body}</div>
                        )}
                        {Array.isArray(m.kb_citations) && m.kb_citations.length > 0 && (
                            <div className="mt-2 pt-2 border-t text-xs border-[var(--border-default)] text-[var(--text-muted)]">
                                Cited: {m.kb_citations.map(c => c.title).filter(Boolean).join(' · ')}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
