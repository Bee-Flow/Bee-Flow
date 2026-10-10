import { Lightbulb, Download, ChevronRight, AlertTriangle, ShieldAlert, Trash2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import ImportMemoryModal from '../../components/knowledge/memory/ImportMemoryModal';
import { typeLabel, type MemoryStats } from '../../components/knowledge/memory/memoryTypes';
import { exportMemories } from '../../components/knowledge/memory/useMemories';
import Toggle from '../../components/shared/Toggle';
import { toast } from '../../components/shared/Toast';
import useConfirm from '../../components/shared/useConfirm';
import { useTranslation } from '../../hooks/useTranslation';
import { formatRelativeTime } from '../../utils/dateFormatters';
import { API_BASE, authFetch } from '../../utils/helpers';

/**
 * Settings → Memory.
 *
 * THE SWITCH is the account-wide master switch (`memoryEnabled`, read as
 * `!== false` because memory defaults ON). Off means PAUSED, not deleted: the
 * data is kept, nothing new is saved and nothing stored reaches a chat. Manage
 * and Export stay reachable so a person can pause memory and still get their
 * data out. Import is the exception: the server refuses it while paused, so the
 * button is disabled with an explanation.
 *
 * THE COUNT has three states (`statsStatus`: loading | ok | error). A pending
 * fetch and a 403 must never paint "0", or a full memory looks like a new one.
 *
 * ORG OFF: when the organisation has memory disabled the personal switches are
 * disabled and a notice says why; the stored data stays manageable.
 */

export type StatsStatus = 'loading' | 'ok' | 'error';

export interface MemoryUser {
    memoryEnabled?: boolean;
    orgMemoryEnabled?: boolean;
    sensitiveOptInAllowed?: boolean;
    memorySensitiveOptIn?: boolean;
    [key: string]: unknown;
}

interface MemorySectionProps {
    memoryStats: MemoryStats | null;
    statsStatus?: StatsStatus;
    onRetryStats?: () => void;
    user?: MemoryUser | null;
    onUpdateUser?: (patch: Partial<MemoryUser>) => void;
    onOpenMemory?: (view?: 'review') => void;
    onImported?: () => void;
}

const ROW = 'border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]';
const CARD = 'overflow-hidden rounded-xl border border-[var(--border-subtle)]';
const HEADING = 'mb-2 px-1 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-tertiary)]';
const ROW_BUTTON = 'flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50';

async function saveUserSettings(patch: Record<string, boolean>): Promise<void> {
    const res = await authFetch(`${API_BASE}/ai/user-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function CountValue({ status, count }: { status: StatsStatus; count: number | null }) {
    const { t } = useTranslation();
    if (status === 'loading') {
        return (
            <span
                data-testid="memory-count-loading"
                aria-busy="true"
                aria-label={t('common.loading', 'Loading...')}
                className="inline-block h-6 w-8 animate-pulse rounded-md bg-[var(--bg-tertiary)]"
            />
        );
    }
    if (status === 'error') return <AlertTriangle className="h-5 w-5 text-[var(--warning)]" aria-hidden="true" />;
    return <span className="text-[22px] font-bold tabular-nums text-[var(--text-primary)]">{count}</span>;
}

function CountDetail({ status, count, stats, onRetry }: { status: StatsStatus; count: number | null; stats: MemoryStats | null; onRetry?: () => void }) {
    const { t } = useTranslation();
    if (status === 'error') {
        return (
            <div className={`flex items-center gap-3 px-5 py-3 ${ROW}`}>
                <p className="flex-1 text-[12px] text-[var(--text-tertiary)]">{t('settings.memory_stats_error', 'Could not load your memory statistics.')}</p>
                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        data-testid="memory-stats-retry"
                        className="rounded-md border border-[var(--border-default)] px-2.5 py-1 text-[12px] font-medium text-[var(--text-primary)]"
                    >
                        {t('settings.memory_stats_retry', 'Retry')}
                    </button>
                )}
            </div>
        );
    }
    if (status !== 'ok') return null;
    const labels = stats?.typeDistribution?.labels ?? [];
    const data = stats?.typeDistribution?.data ?? [];
    if ((count ?? 0) > 0 && labels.length > 0) {
        return (
            <div className={`flex flex-wrap gap-2 px-5 py-3 ${ROW}`}>
                {labels.map((label, i) => (
                    <span key={label} className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
                        {typeLabel(t, label)}: {data[i]}
                    </span>
                ))}
            </div>
        );
    }
    if (count === 0) {
        return (
            <div className={`px-5 py-3 ${ROW}`}>
                <p className="text-[12px] text-[var(--text-tertiary)]">{t('settings.memory_empty', 'No memories yet. As you chat, facts and preferences are automatically saved.')}</p>
            </div>
        );
    }
    return null;
}

export default function MemorySection({
    memoryStats, statsStatus, onRetryStats, user, onUpdateUser, onOpenMemory, onImported,
}: MemorySectionProps) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [showImport, setShowImport] = useState(false);

    // Absent means ON, matching the server default. `!!user.memoryEnabled`
    // would tell every existing user their memory had been disabled.
    const orgOff = user?.orgMemoryEnabled === false;
    const storedEnabled = user?.memoryEnabled !== false;
    const [enabled, setEnabled] = useState(storedEnabled);
    const [saving, setSaving] = useState(false);
    const [switchError, setSwitchError] = useState<string | null>(null);
    useEffect(() => { setEnabled(storedEnabled); }, [storedEnabled]);

    const sensitiveAllowed = user?.sensitiveOptInAllowed === true;
    const storedSensitive = user?.memorySensitiveOptIn === true;
    const [sensitive, setSensitive] = useState(storedSensitive);
    const [sensitiveSaving, setSensitiveSaving] = useState(false);
    useEffect(() => { setSensitive(storedSensitive); }, [storedSensitive]);

    const toggleMaster = async (next: boolean) => {
        setSwitchError(null);
        setEnabled(next);
        onUpdateUser?.({ memoryEnabled: next });
        setSaving(true);
        try {
            await saveUserSettings({ memoryEnabled: next });
        } catch {
            setEnabled(!next);
            onUpdateUser?.({ memoryEnabled: !next });
            setSwitchError(t('settings.memory_switch_error', 'Could not change the memory setting. Please try again.'));
        } finally {
            setSaving(false);
        }
    };

    const toggleSensitive = async (next: boolean) => {
        if (!next) {
            const ok = await confirm({
                title: t('settings.memory_sensitive_off_title', 'Stop remembering sensitive topics?'),
                description: t('settings.memory_sensitive_off_desc', 'Sensitive memories that are already saved, or waiting for your review, will be deleted. This cannot be undone.'),
                confirmLabel: t('settings.memory_sensitive_off_confirm', 'Turn off and delete'),
                destructive: true,
            });
            if (!ok) return;
        }
        setSensitive(next);
        onUpdateUser?.({ memorySensitiveOptIn: next });
        setSensitiveSaving(true);
        try {
            await saveUserSettings({ memorySensitiveOptIn: next });
            if (!next) onRetryStats?.();
        } catch {
            setSensitive(!next);
            onUpdateUser?.({ memorySensitiveOptIn: !next });
            toast.error(t('settings.memory_sensitive_error', 'Could not change this setting. Please try again.'));
        } finally {
            setSensitiveSaving(false);
        }
    };

    const clearAll = async () => {
        const ok = await confirm({
            title: t('settings.memory_clear_personal_title', 'Delete all your personal memories?'),
            description: t('settings.memory_clear_personal_desc', 'Every personal memory will be removed and no longer used in your chats. Project memories are not affected. This cannot be undone.'),
            confirmLabel: t('settings.memory_clear_confirm', 'Delete all'),
            destructive: true,
        });
        if (!ok) return;
        try {
            const res = await authFetch(`${API_BASE}/agents/memory/clear`, { method: 'POST' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            toast.success(t('settings.memory_cleared', 'Your personal memories were deleted'));
            onRetryStats?.();
        } catch {
            toast.error(t('settings.memory_clear_personal_error', 'Could not delete your personal memories. Please try again.'));
        }
    };

    const exportAll = async () => {
        try { await exportMemories(); } catch { toast.error(t('knowledge.memory_export_error', 'Could not export your memories. Please try again.')); }
    };

    // A parent that has not adopted `statsStatus` yet: a missing stats object is a pending fetch, never a zero.
    const status: StatsStatus = statsStatus || (memoryStats ? 'ok' : 'loading');
    const count = status === 'ok' ? (memoryStats?.total || 0) : null;
    const pending = status === 'ok' ? (memoryStats?.pendingReview ?? 0) : 0;
    const switchDisabled = saving || orgOff;

    return (
        <div className="space-y-6">
            <div className="space-y-1.5">
                <p className={HEADING}>{t('settings.memory_title', 'Memory')}</p>
                {orgOff && (
                    <div role="status" data-testid="memory-org-off" className="mb-2 flex items-start gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-4 py-3 text-[13px] text-[var(--text-primary)]">
                        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--warning)]" aria-hidden="true" />
                        <span>{t('settings.memory_org_off', 'Your organisation has turned memory off. Nothing is saved or used in chats, and you cannot change this here. Memories you already have are kept, and you can still manage or export them.')}</span>
                    </div>
                )}
                <div className={CARD}>
                    <div className={`px-5 py-4 ${ROW}`}>
                        <div className="flex items-center gap-4">
                            <div className="flex-1">
                                <p className="text-[13px] font-medium text-[var(--text-primary)]">{t('settings.memory_switch', 'Use memory')}</p>
                                <p className="text-[12px] font-medium text-[var(--text-secondary)]" data-testid="memory-state">
                                    {enabled && !orgOff
                                        ? t('settings.memory_state_on', 'On')
                                        : t('settings.memory_state_paused', 'Paused (kept, not used or saved)')}
                                </p>
                                <p className="text-[11px] text-[var(--text-tertiary)]">
                                    {enabled
                                        ? t('settings.memory_switch_on_desc', 'Facts and preferences from your chats are saved and used in later chats.')
                                        : t('settings.memory_switch_off_desc', 'Memory is paused: nothing new is saved and your stored memories are not used in chats. They are kept here, and you can still manage or export them.')}
                                </p>
                            </div>
                            <Toggle
                                checked={enabled && !orgOff}
                                onChange={toggleMaster}
                                disabled={switchDisabled}
                                ariaLabel={t('settings.memory_switch', 'Use memory')}
                            />
                        </div>
                        {switchError && (
                            <p role="alert" data-testid="memory-switch-error" className="mt-2 text-[11px] text-[var(--error)]">{switchError}</p>
                        )}
                    </div>

                    {sensitiveAllowed && (
                        <div className={`px-5 py-4 ${ROW}`}>
                            <div className="flex items-center gap-4">
                                <ShieldAlert className="h-4 w-4 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                                <div className="flex-1">
                                    <p className="text-[13px] font-medium text-[var(--text-primary)]">{t('settings.memory_sensitive', 'Remember sensitive topics')}</p>
                                    <p className="text-[11px] text-[var(--text-tertiary)]">
                                        {t('settings.memory_sensitive_desc', 'By default, health, beliefs, orientation and similar topics are never remembered. If you allow it, such memories wait for your approval before they are used.')}
                                    </p>
                                </div>
                                <Toggle
                                    checked={sensitive}
                                    onChange={toggleSensitive}
                                    disabled={sensitiveSaving || orgOff || !enabled}
                                    ariaLabel={t('settings.memory_sensitive', 'Remember sensitive topics')}
                                />
                            </div>
                        </div>
                    )}

                    <div className={`flex items-center gap-4 px-5 py-4 ${ROW}`}>
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--accent-primary)]">
                            <Lightbulb className="h-4 w-4" aria-hidden="true" />
                        </div>
                        <div className="flex-1">
                            <p className="text-[13px] font-medium text-[var(--text-primary)]">{t('settings.memory_stored', 'Stored memories')}</p>
                            <p className="text-[11px] text-[var(--text-tertiary)]">{t('settings.memory_desc', 'Persisted facts about you, your projects, and preferences')}</p>
                            {status === 'ok' && memoryStats?.lastUpdatedAt && (
                                <p className="text-[11px] text-[var(--text-tertiary)]">
                                    {t('settings.memory_last_updated', 'Last updated {when}', {
                                        when: formatRelativeTime(memoryStats.lastUpdatedAt, { nowLabel: t('knowledge.memory_just_now', 'just now') }),
                                    })}
                                </p>
                            )}
                        </div>
                        <CountValue status={status} count={count} />
                    </div>

                    <CountDetail status={status} count={count} stats={memoryStats} onRetry={onRetryStats} />

                    {pending > 0 && (
                        <button type="button" onClick={() => onOpenMemory?.('review')} data-testid="memory-review-row" className={`${ROW_BUTTON} ${ROW}`}>
                            <span className="flex-1 text-[13px] text-[var(--text-primary)]">
                                {t('settings.memory_pending_review', '{count} waiting for your review', { count: pending })}
                            </span>
                            <ChevronRight className="h-3.5 w-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                        </button>
                    )}

                    {/* Manage stays reachable with memory paused: the switch makes memory inert, never a data trap. */}
                    <button
                        type="button"
                        onClick={() => onOpenMemory?.()}
                        data-tour="memory-manage"
                        data-testid="memory-manage-row"
                        className={`${ROW_BUTTON} ${ROW}`}
                    >
                        <span className="flex-1 text-[13px] text-[var(--text-primary)]">{t('settings.memory_manage', 'Manage memories')}</span>
                        <ChevronRight className="h-3.5 w-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                    </button>
                    <button type="button" onClick={exportAll} data-testid="memory-export-row" className={`${ROW_BUTTON} ${ROW}`}>
                        <Download className="h-4 w-4 text-[var(--text-tertiary)]" aria-hidden="true" />
                        <span className="flex-1 text-[13px] text-[var(--text-primary)]">{t('settings.memory_export', 'Export all memories')}</span>
                    </button>
                    <button type="button" onClick={clearAll} data-testid="memory-clear-row" disabled={status !== 'ok' || count === 0} className={`${ROW_BUTTON} ${ROW}`}>
                        <Trash2 className="h-4 w-4 text-rose-500" aria-hidden="true" />
                        <span className="flex-1 text-[13px] text-rose-500">{t('settings.memory_clear_all', 'Delete all personal memories')}</span>
                    </button>
                </div>
            </div>

            <div className="space-y-1.5">
                <p className={HEADING}>{t('settings.memory_import_title', 'Import memory from other AI providers')}</p>
                <div className={CARD}>
                    <div className="flex items-center gap-4 bg-[var(--bg-secondary)] px-5 py-4">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--accent-primary)]">
                            <Download className="h-4 w-4" aria-hidden="true" />
                        </div>
                        <div className="flex-1">
                            <p className="text-[13px] font-medium text-[var(--text-primary)]">{t('settings.memory_import_title', 'Import memory from other AI providers')}</p>
                            <p className="text-[11px] text-[var(--text-tertiary)]">
                                {t('settings.memory_import_desc', "Bring relevant context and data from another AI provider. We'll provide a prompt you can use from your other account.")}
                            </p>
                            {!orgOff && !enabled && (
                                <p data-testid="memory-import-paused" className="mt-1 text-[11px] text-[var(--text-secondary)]">
                                    {t('settings.memory_import_paused', 'Importing is not available while memory is paused. Turn memory on to import.')}
                                </p>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowImport(true)}
                            disabled={orgOff || !enabled}
                            data-testid="memory-import-button"
                            className="rounded-lg bg-[var(--accent-primary)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
                        >
                            {t('settings.memory_import_button', 'Import')}
                        </button>
                    </div>
                </div>
            </div>

            <div className="space-y-1.5">
                <p className={HEADING}>{t('settings.memory_about_title', 'About')}</p>
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-5 py-4">
                    <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
                        {t('settings.memory_about_desc', 'Memories help the AI remember facts, preferences, and context from your conversations. They persist across sessions for a more personalised experience.')}
                    </p>
                </div>
            </div>

            {showImport && <ImportMemoryModal onClose={() => setShowImport(false)} onImported={() => onImported?.()} />}
            {confirmDialog}
        </div>
    );
}
