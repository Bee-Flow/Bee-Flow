import { Settings, Check } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/shared/Button';
import Toggle from '@/components/shared/Toggle';
import { INPUT } from '@/components/shared/adminUi';

const inputClass = INPUT;

interface GitHubConfigFormProps {
    configured: boolean | undefined;
    showConfig: boolean;
    configuring: boolean;
    repoOwner: string;
    setRepoOwner: (value: string) => void;
    repoName: string;
    setRepoName: (value: string) => void;
    branch: string;
    setBranch: (value: string) => void;
    autoSync: boolean;
    setAutoSync: (value: boolean) => void;
    onConfigure: () => void;
    onCancel: () => void;
}

/** The repository form: owner, name, branch and the auto-sync switch. */
export function GitHubConfigForm({ configured, showConfig, configuring, repoOwner, setRepoOwner, repoName, setRepoName, branch, setBranch, autoSync, setAutoSync, onConfigure, onCancel }: GitHubConfigFormProps) {
    const { t } = useTranslation();
    return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-5 space-y-4">
            <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <Settings className="w-4 h-4 text-[var(--text-muted)]" aria-hidden="true" />
                {t('integ.git_hub_sync_repository_configuration', 'Repository Configuration')}
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                    <label className="block text-xs font-medium mb-1.5 text-[var(--text-secondary)]">{t('integ.git_hub_sync_repository_owner', 'Repository Owner')}</label>
                    <input
                        type="text"
                        value={repoOwner}
                        onChange={e => setRepoOwner(e.target.value)}
                        placeholder={t('integ.git_hub_sync_your_username', 'your-username')}
                        className={inputClass}
                    />
                </div>
                <div>
                    <label className="block text-xs font-medium mb-1.5 text-[var(--text-secondary)]">{t('integ.git_hub_sync_repository_name', 'Repository Name')}</label>
                    <input
                        type="text"
                        value={repoName}
                        onChange={e => setRepoName(e.target.value)}
                        placeholder={t('integ.git_hub_sync_beeflow_agents', 'beeflow-agents')}
                        className={inputClass}
                    />
                </div>
            </div>

            <div>
                <label className="block text-xs font-medium mb-1.5 text-[var(--text-secondary)]">{t('integ.git_hub_sync_branch', 'Branch')}</label>
                <input
                    type="text"
                    value={branch}
                    onChange={e => setBranch(e.target.value)}
                    placeholder={t('integ.git_hub_sync_main', 'main')}
                    className={inputClass}
                />
            </div>

            <Toggle
                checked={autoSync}
                onChange={setAutoSync}
                label={t('integ.git_hub_sync_auto_sync', 'Auto-sync')}
                description={t('integ.git_hub_sync_automatically_push_changes_when_agents', 'Automatically push changes when agents are modified')}
            />

            <div className="flex gap-3 pt-2">
                <Button variant="primary" icon={configuring ? undefined : Check} busy={configuring} onClick={onConfigure}>
                    {configured ? t('admin_connections.gh_update_config', 'Update Configuration') : t('admin_connections.gh_connect_repo', 'Connect Repository')}
                </Button>
                {(configured || showConfig) && (
                    <Button variant="ghost" onClick={onCancel}>
                        {t('integ.git_hub_sync_cancel', 'Cancel')}
                    </Button>
                )}
            </div>
        </div>
    );
}
