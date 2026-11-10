import { CheckCircle2, Shield } from 'lucide-react';
import type React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { CsatStars, SlaBadge, TagChips } from './SupportInboxBadges';
import type { SupportThread } from './SupportInboxPanel.types';
import { priorityBadges, roleLabel, statusLabels } from './supportInboxLabels';
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
                    <h3 className="m-0 mb-1 text-[15px] font-semibold text-[var(--text-primary)]">{thread.subject}</h3>
                    <div className="text-xs flex flex-wrap items-center gap-3 text-[var(--text-tertiary)]">
                        <span>From: {thread.requester_name ? `${thread.requester_name} <${thread.requester_email}>` : thread.requester_email}</span>
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                            <Shield className="w-3 h-3" /> {roleLabel(thread.requester_org_role, t)}
                        </span>
                        {thread.requester_org_name && (
                            <span>{t('support.support_inbox_at', 'at')} <strong className="text-[var(--text-primary)]">{thread.requester_org_name}</strong></span>
                        )}
                        <span>Source: {thread.source}</span>
                        {thread.ai_handled && <span className="text-[var(--info-ink)]">{t('support.support_inbox_ai_handled', 'AI handled')}</span>}
                        {thread.ai_escalated_reason && <span className="text-[var(--warning-ink)]">Escalated: {thread.ai_escalated_reason}</span>}
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
                            className="w-20 rounded-md border px-1.5 py-0.5 text-xs border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                        />
                    </div>
                </div>
                <div className="flex items-center gap-1.5">
                    <select
                        value={thread.status}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => patchThread({ status: e.target.value })}
                        className="rounded-md border px-2 py-1 text-xs border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                    >
                        {Object.entries(statusLabels(t)).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
                    </select>
                    <select
                        value={thread.priority}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => patchThread({ priority: e.target.value })}
                        className="rounded-md border px-2 py-1 text-xs border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                    >
                        {Object.entries(priorityBadges(t)).map(([k, v]) => (<option key={k} value={k}>{v.label}</option>))}
                    </select>
                    {thread.status !== 'resolved' && (
                        <button
                            onClick={() => patchThread({ status: 'resolved' })}
                            className="flex items-center gap-1 rounded-md border border-[color-mix(in_srgb,var(--success)_35%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] px-2 py-1 text-xs font-medium text-[var(--success-ink)]"
                        >
                            <CheckCircle2 className="w-3.5 h-3.5" /> {t('support.support_inbox_resolve', 'Resolve')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
