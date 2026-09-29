import { Lightbulb, Download, ChevronRight, AlertTriangle } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import ImportMemoryModal from '../../components/knowledge/memory/ImportMemoryModal';
import { typeLabel } from '../../components/knowledge/memory/memoryTypes';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';

/**
 * Settings → Memory.
 *
 * THE SWITCH is the account-wide master switch (`memory_enabled_user_<id>` on
 * the server, read as `!== false` because memory defaults ON). It is
 * deliberately NOT a delete: with memory off nothing new is saved and nothing
 * stored is injected into a chat, but Manage, Import and Export stay reachable
 * so a user can turn memory off and still get their data out.
 *
 * THE COUNT has three states (`statsStatus`: loading | ok | error). Rendering
 * `memoryStats?.total || 0` painted "Stored memories 0" plus the empty-state
 * copy for a pending fetch and for a 403 alike — a user with a full memory
 * briefly looked like a new one, and a failed request was indistinguishable
 * from a genuine zero.
 */

const CARD_ROW = { background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-subtle)' };

// ── iOS-style toggle (same shape as PreferencesSection's) ────────────────────
const Toggle = ({ on, onClick, disabled, label }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={on}
        aria-label={label}
        className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
        style={{
            background: on ? 'var(--accent-primary)' : 'var(--border-default)',
            opacity: disabled ? 0.6 : 1,
        }}
    >
        <div
            className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
            style={{ transform: on ? 'translateX(20px)' : 'translateX(0)' }}
        />
    </button>
);

// ── "Use memory" row ─────────────────────────────────────────────────────────
const SwitchRow = ({ t, enabled, saving, error, onToggle }) => (
    <div className="px-5 py-4" style={CARD_ROW}>
        <div className="flex items-center gap-4">
            <div className="flex-1">
                <p className="text-[13px] font-medium text-black">{t('settings.memory_switch', 'Use memory')}</p>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {enabled
                        ? t('settings.memory_switch_on_desc', 'Facts and preferences from your chats are saved and used in later chats.')
                        : t('settings.memory_switch_off_desc', 'Memory is off: nothing new is saved and your stored memories are not used in chats. They stay here — you can still manage, export or import them.')}
                </p>
            </div>
            <Toggle on={enabled} onClick={onToggle} disabled={saving} label={t('settings.memory_switch', 'Use memory')} />
        </div>
        {error && (
            <p role="alert" className="text-[11px] mt-2" style={{ color: 'var(--error)' }} data-testid="memory-switch-error">
                {error}
            </p>
        )}
    </div>
);

// ── The number in the stat row: a placeholder while loading, never a zero ────
const CountValue = ({ t, status, count }) => {
    if (status === 'loading') {
        return (
            <span
                data-testid="memory-count-loading"
                aria-busy="true"
                aria-label={t('common.loading', 'Loading...')}
                className="inline-block w-8 h-6 rounded-md animate-pulse"
                style={{ background: 'var(--bg-tertiary)' }}
            />
        );
    }
    if (status === 'error') {
        return <AlertTriangle className="w-5 h-5" style={{ color: 'var(--warning)' }} aria-hidden="true" />;
    }
    return <span className="text-[22px] font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>{count}</span>;
};

// ── Below the stat row: the type chips, the empty state, or the error ────────
const CountDetail = ({ t, status, count, labels, data, onRetry }) => {
    if (status === 'error') {
        return (
            <div className="px-5 py-3 flex items-center gap-3" style={CARD_ROW}>
                <p className="text-[12px] flex-1" style={{ color: 'var(--text-muted)' }}>
                    {t('settings.memory_stats_error', 'Could not load your memory statistics.')}
                </p>
                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="px-2.5 py-1 rounded-md text-[12px] font-medium"
                        style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
                        data-testid="memory-stats-retry"
                    >
                        {t('settings.memory_stats_retry', 'Retry')}
                    </button>
                )}
            </div>
        );
    }
    if (status !== 'ok') return null;
    if (count > 0 && labels.length > 0) {
        return (
            <div className="px-5 py-3 flex flex-wrap gap-2" style={CARD_ROW}>
                {labels.map((label, i) => (
                    <span key={label} className="text-[11px] px-2 py-0.5 rounded-md" style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}>
                        {typeLabel(t, label)}: {data[i]}
                    </span>
                ))}
            </div>
        );
    }
    if (count === 0) {
        return (
            <div className="px-5 py-3" style={CARD_ROW}>
                <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{t('settings.memory_empty')}</p>
            </div>
        );
    }
    return null;
};

// ── Memory Section ───────────────────────────────────────────────────────────
const MemorySection = ({ memoryStats, statsStatus, onRetryStats, user, onUpdateUser, onOpenMemory, onImported }) => {
    const { t } = useTranslation();
    const [showImport, setShowImport] = useState(false);

    // Absent means ON, matching the server default. `!!user.memoryEnabled`
    // would tell every existing user their memory had been disabled.
    const storedEnabled = user?.memoryEnabled !== false;
    const [enabled, setEnabled] = useState(storedEnabled);
    const [saving, setSaving] = useState(false);
    const [switchError, setSwitchError] = useState(null);
    useEffect(() => { setEnabled(storedEnabled); }, [storedEnabled]);

    const handleToggle = async () => {
        const next = !enabled;
        setSwitchError(null);
        setEnabled(next);
        onUpdateUser?.({ memoryEnabled: next });
        setSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/user-settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ memoryEnabled: next }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
            console.error('Failed to save memory setting:', err);
            setEnabled(!next);
            onUpdateUser?.({ memoryEnabled: !next });
            setSwitchError(t('settings.memory_switch_error', 'Could not change the memory setting. Please try again.'));
        } finally {
            setSaving(false);
        }
    };

    // A parent that has not adopted `statsStatus` yet: a missing stats object
    // is a pending fetch, never a zero.
    const status = statsStatus || (memoryStats ? 'ok' : 'loading');
    const count = status === 'ok' ? (memoryStats?.total || 0) : null;
    const labels = memoryStats?.typeDistribution?.labels || [];
    const data = memoryStats?.typeDistribution?.data || [];

    return (
        <div className="space-y-6">
            {/* Memory card */}
            <div className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-widest px-1 mb-2" style={{ color: 'var(--text-muted)' }}>{t('settings.memory_title')}</p>
                <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
                    <SwitchRow t={t} enabled={enabled} saving={saving} error={switchError} onToggle={handleToggle} />

                    {/* Stat row */}
                    <div className="flex items-center gap-4 px-5 py-4" style={CARD_ROW}>
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(245, 158, 11, 0.1)' }}>
                            <Lightbulb className="w-4 h-4" style={{ color: '#d97706' }} />
                        </div>
                        <div className="flex-1">
                            <p className="text-[13px] font-medium text-black">{t('settings.memory_stored')}</p>
                            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                {t('settings.memory_desc')}
                            </p>
                        </div>
                        <CountValue t={t} status={status} count={count} />
                    </div>

                    <CountDetail t={t} status={status} count={count} labels={labels} data={data} onRetry={onRetryStats} />

                    {/* Manage row — reachable with memory off: the switch makes memory inert, never a data trap */}
                    <button
                        type="button"
                        onClick={onOpenMemory}
                        data-tour="memory-manage"
                        data-testid="memory-manage-row"
                        className="w-full flex items-center px-5 py-3.5 text-left transition-colors gap-3"
                        style={{ background: 'var(--bg-secondary)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
                    >
                        <span className="text-[13px] flex-1 text-black">{t('settings.memory_manage')}</span>
                        <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                    </button>
                </div>
            </div>

            {/* Import card */}
            <div className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-widest px-1 mb-2" style={{ color: 'var(--text-muted)' }}>{t('settings.memory_import_title', 'Import memory from other AI providers')}</p>
                <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
                    <div className="flex items-center gap-4 px-5 py-4" style={{ background: 'var(--bg-secondary)' }}>
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(245, 158, 11, 0.1)' }}>
                            <Download className="w-4 h-4" style={{ color: '#d97706' }} />
                        </div>
                        <div className="flex-1">
                            <p className="text-[13px] font-medium text-black">{t('settings.memory_import_title', 'Import memory from other AI providers')}</p>
                            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                {t('settings.memory_import_desc', "Bring relevant context and data from another AI provider. We'll provide a prompt you can use from your other account.")}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowImport(true)}
                            className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-white"
                            style={{ background: 'var(--accent-primary)' }}
                            data-testid="memory-import-button"
                        >
                            {t('settings.memory_import_button', 'Import')}
                        </button>
                    </div>
                </div>
            </div>

            {/* About card */}
            <div className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-widest px-1 mb-2" style={{ color: 'var(--text-muted)' }}>{t('settings.memory_about_title')}</p>
                <div className="rounded-xl px-5 py-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        {t('settings.memory_about_desc')}
                    </p>
                </div>
            </div>

            {showImport && (
                <ImportMemoryModal
                    onClose={() => setShowImport(false)}
                    onImported={() => onImported?.()}
                />
            )}
        </div>
    );
};

export default MemorySection;
