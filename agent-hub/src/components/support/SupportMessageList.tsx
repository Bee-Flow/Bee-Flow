import { AlertTriangle, Bot, User } from 'lucide-react';
import { CHIP_WARNING } from '../mcpLibrary/ui';
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
                const tint = m.internal_note ? 'bg-[color-mix(in_srgb,var(--warning)_8%,transparent)]'
                    : isStaff ? 'bg-[color-mix(in_srgb,var(--success)_8%,transparent)]'
                        : isAI ? 'bg-[color-mix(in_srgb,var(--info)_8%,transparent)]'
                            : isSystem ? 'bg-[var(--bg-tertiary)]' : 'bg-[var(--bg-secondary)]';
                return (
                    <div key={m.id} className={`rounded-lg border border-[var(--border-default)] p-3 text-sm text-[var(--text-primary)] ${tint}`}>
                        <div className="flex items-center gap-2 text-xs mb-1 text-[var(--text-tertiary)]">
                            {isAI ? <Bot className="w-3.5 h-3.5" /> : isStaff ? <User className="w-3.5 h-3.5" /> : isSystem ? <AlertTriangle className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
                            <span className="font-medium text-[var(--text-secondary)]">
                                {m.author_display || m.author_kind}
                            </span>
                            {m.internal_note && <span className={CHIP_WARNING}>{t('support.support_inbox_internal_note', 'internal note')}</span>}
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
                            <div className="mt-2 pt-2 border-t text-xs border-[var(--border-default)] text-[var(--text-tertiary)]">
                                Cited: {m.kb_citations.map(c => c.title).filter(Boolean).join(' · ')}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
