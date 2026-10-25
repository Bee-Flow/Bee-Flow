import React, { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../../utils/helpers';
import { integrationsAdminKeys, useFeatureFlagsQuery } from '../../api/queries/integrationsAdmin';
import { BookOpen, FolderKanban, Sparkles, FileDown, Maximize2, LayoutList, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import type { LucideIcon } from 'lucide-react';
import { mutate, ApiError } from '../../api/mutate';

interface FlagDef {
    key: string;
    label: string;
    desc: string;
    icon: LucideIcon;
}

interface FlashMessage {
    type: 'success' | 'error';
    text: string;
}

/**
 * FeatureKillSwitches — the global platform feature flags
 * (notebooks / projects / ask-ai / export / open-in-notebook / notebooks-menu),
 * persisted via GET/POST /ai/config (configStore feature_*_enabled).
 *
 * Self-contained (loads + saves its own state) so it can be reused both on the
 * Integrations admin panel and inside the self-hosted Ceiling editor without
 * duplicating the toggle logic. These are operator kill-switches, not
 * entitlement grants — they take effect for everyone on next page load.
 *
 * Emerald + blue only.
 */

const FLAGS: FlagDef[] = [
    { key: 'notebooksEnabled', label: 'Notebooks', desc: 'AI-powered collaborative notebooks', icon: BookOpen },
    { key: 'projectsEnabled', label: 'Projects', desc: 'Organize chats into shared project folders', icon: FolderKanban },
    { key: 'askAiEnabled', label: 'Ask AI', desc: 'Enable AI assistance in notebooks', icon: Sparkles },
    { key: 'exportEnabled', label: 'Export', desc: 'Enable exporting notebooks to Word/PDF', icon: FileDown },
    { key: 'openInNotebookEnabled', label: 'Open in Notebook', desc: 'Allow opening chats as full notebooks', icon: Maximize2 },
    { key: 'notebooksMenuEnabled', label: 'Notebooks Menu', desc: "Show 'Notebooks' in the sidebar menu", icon: LayoutList },
];

export default function FeatureKillSwitches() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const flagsQuery = useFeatureFlagsQuery();
    // Server answer over the all-on defaults; a saved toggle is written into the cache.
    const flags = useMemo(() => {
        const next: Record<string, boolean> = {};
        for (const f of FLAGS) next[f.key] = flagsQuery.data?.[f.key] !== undefined ? !!flagsQuery.data[f.key] : true;
        return next;
    }, [flagsQuery.data]);
    const loading = flagsQuery.isPending;
    const [saving, setSaving] = useState<Record<string, boolean>>({});
    const [message, setMessage] = useState<FlashMessage | null>(null);

    useEffect(() => { if (!message) return; const t = setTimeout(() => setMessage(null), 3000); return () => clearTimeout(t); }, [message]);

    const toggle = async (key: string, label: string) => {
        const newVal = !flags[key];
        setSaving(s => ({ ...s, [key]: true }));
        try {
            const res = await mutate(`${API_BASE}/ai/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: newVal }),
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                queryClient.setQueryData<Record<string, unknown> | null>(integrationsAdminKeys.featureFlags, (old) => ({ ...(old ?? {}), [key]: newVal }));
                setMessage({ type: 'success', text: `${label} ${newVal ? 'enabled' : 'disabled'}` });
            } else {
                setMessage({ type: 'error', text: `Failed to update ${label}` });
            }
        } catch (e) {
            setMessage({ type: 'error', text: `Failed to update ${label}` });
        }
        setSaving(s => ({ ...s, [key]: false }));
    };

    return (
        <div className="rounded-2xl border overflow-hidden bg-[var(--bg-secondary)] border-[var(--border-default)]">
            <div className="px-6 py-4 border-b flex items-center justify-between border-[var(--border-subtle)]">
                <div>
                    <h3 className="font-semibold text-[var(--text-primary)]">{t('integ.feature_kill_switches_feature_flags', 'Feature Flags')}</h3>
                    <p className="text-xs mt-0.5 text-[var(--text-muted)]">
                        {t('integ.feature_kill_switches_enable_or_disable_platform_features', 'Enable or disable platform features globally. Changes take effect on next page load for all users.')}
                    </p>
                </div>
                {message ? (
                    <span className="inline-flex items-center gap-1.5 text-xs flex-shrink-0" style={{ color: message.type === 'success' ? '#10b981' : '#dc2626' }}>
                        {message.type === 'success' ? <Check className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}{message.text}
                    </span>
                ) : null}
            </div>
            <div className="p-4">
                {loading ? (
                    <div className="py-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {FLAGS.map(({ key, label, desc, icon: Icon }) => {
                            const on = flags[key];
                            return (
                                <div key={key}
                                    className="flex items-center gap-3 px-4 py-3 rounded-xl transition-all"
                                    style={{ background: on ? 'rgba(16, 185, 129, 0.06)' : 'var(--bg-primary)', border: `1px solid ${on ? 'rgba(16, 185, 129, 0.2)' : 'var(--border-subtle)'}` }}>
                                    <Icon className="w-5 h-5 shrink-0" style={{ color: on ? '#10b981' : 'var(--text-muted)' }} />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-medium" style={{ color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>{label}</div>
                                        <div className="text-xs text-[var(--text-muted)]">{desc}</div>
                                    </div>
                                    <button
                                        onClick={() => toggle(key, label)}
                                        disabled={!!saving[key]}
                                        className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-green-500' : 'bg-gray-600'}`}>
                                        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${on ? 'left-6' : 'left-1'}`} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
