import { Settings, Check, Loader2 } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';

const inputClass = "w-full px-3 py-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-sm outline-none focus:border-[var(--accent-primary)] transition-colors";

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
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-4">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <Settings className="w-4 h-4 text-[var(--text-muted)]" />
                {t('integ.git_hub_sync_repository_configuration', 'Repository Configuration')}
            </h3>

            <div className="grid grid-cols-2 gap-4">
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

            <div className="flex items-center gap-3 p-3 rounded-xl bg-[var(--bg-secondary)]">
                <button
                    onClick={() => setAutoSync(!autoSync)}
                    className={`w-10 h-5.5 rounded-full transition-all flex-shrink-0 relative ${autoSync ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-tertiary)]'}`}
                >
                    <span className={`absolute top-0.5 w-4.5 h-4.5 rounded-full bg-white shadow-sm transition-all ${autoSync ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
                <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">{t('integ.git_hub_sync_auto_sync', 'Auto-sync')}</p>
                    <p className="text-[11px] text-[var(--text-muted)]">{t('integ.git_hub_sync_automatically_push_changes_when_agents', 'Automatically push changes when agents are modified')}</p>
                </div>
            </div>

            <div className="flex gap-3 pt-2">
                <button
                    onClick={onConfigure}
                    disabled={configuring}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 [background:var(--brand-gradient)]"
                >
                    {configuring ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {configured ? 'Update Configuration' : 'Connect Repository'}
                </button>
                {(configured || showConfig) && (
                    <button
                        onClick={onCancel}
                        className="px-4 py-2.5 rounded-xl text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                    >
                        {t('integ.git_hub_sync_cancel', 'Cancel')}
                    </button>
                )}
            </div>
        </div>
    );
}
