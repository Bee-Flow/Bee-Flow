import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../../utils/helpers';
import { integrationsAdminKeys, useFeatureFlagsQuery } from '../../api/queries/integrationsAdmin';
import { BookOpen, FolderKanban, Sparkles, FileDown, Maximize2, LayoutList } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import type { LucideIcon } from 'lucide-react';
import { mutate, ApiError } from '../../api/mutate';
import { useToastOnMessage } from '@/components/admin/ai-config/ui/useToastOnMessage';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Spinner from '@/components/shared/Spinner';
import Toggle from '@/components/shared/Toggle';

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
 * One settings row per flag; the outcome of a toggle is said as a toast.
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

    useToastOnMessage(message);

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
        <SettingsGroup
            title={t('integ.feature_kill_switches_feature_flags', 'Feature Flags')}
            description={t('integ.feature_kill_switches_enable_or_disable_platform_features', 'Enable or disable platform features globally. Changes take effect on next page load for all users.')}
        >
            {loading ? (
                <div className="flex justify-center py-6"><Spinner size="sm" /></div>
            ) : (
                <SettingsList>
                    {FLAGS.map(({ key, label, desc, icon: Icon }) => (
                        <SettingRow key={key} icon={<Icon className="h-4 w-4" />} label={label} hint={desc}>
                            <div className="flex justify-end">
                                <Toggle checked={flags[key]} onChange={() => toggle(key, label)} disabled={!!saving[key]} ariaLabel={label} />
                            </div>
                        </SettingRow>
                    ))}
                </SettingsList>
            )}
        </SettingsGroup>
    );
}
