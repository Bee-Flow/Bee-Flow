import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { integrationsAdminKeys, useFeatureFlagsQuery } from '../../api/queries/integrationsAdmin';
import { BookOpen, FolderKanban, Sparkles, FileDown, Maximize2, LayoutList } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import type { LucideIcon } from 'lucide-react';
import { ApiError } from '../../api/mutate';
import { useToastOnMessage } from '@/components/admin/ai-config/ui/useToastOnMessage';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Spinner from '@/components/shared/Spinner';
import Toggle from '@/components/shared/Toggle';
import { apiRequest } from '@/api/typedRequest';

interface FlagDef {
    key: string;
    labelKey: string;
    label: string;
    descKey: string;
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
 * Self-contained (loads + saves its own state). Mounted in one place only,
 * Whole server > Licence & features > Feature switches (the Ceiling under
 * Access links there). These are operator kill-switches, not entitlement
 * grants — they take effect for everyone on next page load.
 *
 * One settings row per flag; a toggle saves at once and says so as a toast.
 * `bare`: just the list (and the note on when a change applies), for a page
 * whose frame already names it, so no second heading is stacked on the first.
 */

const FLAGS: FlagDef[] = [
    { key: 'notebooksEnabled', labelKey: 'admin_platform.flag_notebooks', label: 'Notebooks', descKey: 'admin_platform.flag_notebooks_desc', desc: 'Collaborative notebooks with AI assistance', icon: BookOpen },
    { key: 'projectsEnabled', labelKey: 'admin_platform.flag_projects', label: 'Projects', descKey: 'admin_platform.flag_projects_desc', desc: 'Organise chats into shared project folders', icon: FolderKanban },
    { key: 'askAiEnabled', labelKey: 'admin_platform.flag_ask_ai', label: 'Ask AI', descKey: 'admin_platform.flag_ask_ai_desc', desc: 'AI assistance inside notebooks', icon: Sparkles },
    { key: 'exportEnabled', labelKey: 'admin_platform.flag_export', label: 'Export', descKey: 'admin_platform.flag_export_desc', desc: 'Export notebooks to Word or PDF', icon: FileDown },
    { key: 'openInNotebookEnabled', labelKey: 'admin_platform.flag_open_in_notebook', label: 'Open in notebook', descKey: 'admin_platform.flag_open_in_notebook_desc', desc: 'Open a chat as a full notebook', icon: Maximize2 },
    { key: 'notebooksMenuEnabled', labelKey: 'admin_platform.flag_notebooks_menu', label: 'Notebooks menu', descKey: 'admin_platform.flag_notebooks_menu_desc', desc: 'Show Notebooks in the sidebar menu', icon: LayoutList },
];

export default function FeatureKillSwitches({ bare = false }: { bare?: boolean }) {
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
        const failed = t('admin_platform.flag_save_failed', 'Could not change {feature}', { feature: label });
        setSaving(s => ({ ...s, [key]: true }));
        try {
            const res = await apiRequest('POST /ai/config', { body: { [key]: newVal } }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                queryClient.setQueryData<Record<string, unknown> | null>(integrationsAdminKeys.featureFlags, (old) => ({ ...(old ?? {}), [key]: newVal }));
                setMessage({ type: 'success', text: newVal
                    ? t('admin_platform.flag_on', '{feature} switched on', { feature: label })
                    : t('admin_platform.flag_off', '{feature} switched off', { feature: label }) });
            } else {
                setMessage({ type: 'error', text: failed });
            }
        } catch {
            setMessage({ type: 'error', text: failed });
        }
        setSaving(s => ({ ...s, [key]: false }));
    };

    const list = loading ? (
        <div className="flex justify-center py-6"><Spinner size="sm" /></div>
    ) : (
        <SettingsList>
            {FLAGS.map(({ key, labelKey, label: fallback, descKey, desc, icon: Icon }) => {
                const label = t(labelKey, fallback);
                return (
                    <SettingRow inline key={key} icon={<Icon className="h-4 w-4" />} label={label} hint={t(descKey, desc)}>
                        <div className="flex justify-end">
                            <Toggle checked={flags[key]} onChange={() => toggle(key, label)} disabled={!!saving[key]} ariaLabel={label} />
                        </div>
                    </SettingRow>
                );
            })}
        </SettingsList>
    );

    const note = t('admin_platform.flags_note', 'Switch platform features on or off for everyone on this server. A change applies on the next page load.');
    if (bare) {
        return (
            <div className="flex flex-col gap-3" data-testid="feature-switches">
                <p className="m-0 text-[13px] text-[var(--text-secondary)]">{note}</p>
                {list}
            </div>
        );
    }
    return (
        <SettingsGroup title={t('admin_platform.feature_switches', 'Feature switches')} description={note}>
            {list}
        </SettingsGroup>
    );
}
