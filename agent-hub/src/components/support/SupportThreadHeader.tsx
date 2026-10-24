import { CheckCircle2, Shield } from 'lucide-react';
import type React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { CsatStars, SlaBadge, TagChips } from './SupportInboxBadges';
import type { SupportThread } from './SupportInboxPanel.types';
import { PRIORITY_BADGES, STATUS_LABELS, roleLabel } from './supportInboxLabels';
import type { useSupportThreadEdits } from './useSupportInboxActions';

interface SupportThreadHeaderProps {
    thread: SupportThread;
    edits: ReturnType<typeof useSupportThreadEdits>;
}

/** Who wrote, where from, the SLA and tags of the open thread, with the status and priority controls. */
export default function SupportThreadHeader({ thread, edits }: SupportThreadHeaderProps) {
    const { t } = useTranslation();
    const { newTag, setNewTag, patchThread, addTag, removeTag } = edits;
    return (
        <div className="p-4 border-b border-[var(--border-default)]">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <div className="text-sm font-semibold mb-1 text-[var(--text-primary)]">{thread.subject}</div>
                    <div className="text-xs flex flex-wrap items-center gap-3 text-[var(--text-muted)]">
                        <span>From: {thread.requester_name ? `${thread.requester_name} <${thread.requester_email}>` : thread.requester_email}</span>
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                            <Shield className="w-3 h-3" /> {roleLabel(thread.requester_org_role)}
                        </span>
                        {thread.requester_org_name && (
                            <span>{t('support.support_inbox_at', 'at')} <strong className="text-[var(--text-primary)]">{thread.requester_org_name}</strong></span>
                        )}
                        <span>Source: {thread.source}</span>
                        {thread.ai_handled && <span className="[color:#0ea5e9]">{t('support.support_inbox_ai_handled', 'AI handled')}</span>}
                        {thread.ai_escalated_reason && <span className="[color:#b45309]">Escalated: {thread.ai_escalated_reason}</span>}
                        <SlaBadge thread={thread} />
                        {thread.csat_score && <CsatStars score={thread.csat_score} />}
                        {thread.category && <span className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{thread.category}</span>}
                    </div>
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                        <TagChips tags={thread.tags} onRemove={removeTag} />
                        <input
                            value={newTag}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewTag(e.target.value)}
                            onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && addTag()}
                            placeholder={t('support.support_inbox_tag', '+ tag')}
                            className="text-xs px-1.5 py-0.5 rounded border w-20 [background:var(--bg-card)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                        />
                    </div>
                </div>
                <div className="flex items-center gap-1.5">
                    <select
                        value={thread.status}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => patchThread({ status: e.target.value })}
                        className="px-2 py-1 rounded-md border text-xs [background:var(--bg-card)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                    >
                        {Object.entries(STATUS_LABELS).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
                    </select>
                    <select
                        value={thread.priority}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => patchThread({ priority: e.target.value })}
                        className="px-2 py-1 rounded-md border text-xs [background:var(--bg-card)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                    >
                        {Object.entries(PRIORITY_BADGES).map(([k, v]) => (<option key={k} value={k}>{v.label}</option>))}
                    </select>
                    {thread.status !== 'resolved' && (
                        <button
                            onClick={() => patchThread({ status: 'resolved' })}
                            className="px-2 py-1 rounded-md text-xs flex items-center gap-1 border [background:rgba(16,185,129,0.1)] [color:#059669]! [border-color:rgba(16,185,129,0.3)]"
                        >
                            <CheckCircle2 className="w-3.5 h-3.5" /> {t('support.support_inbox_resolve', 'Resolve')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
