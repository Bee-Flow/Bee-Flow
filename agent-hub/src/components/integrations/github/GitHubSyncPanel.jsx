import { GitBranch, Check, AlertTriangle, FolderGit2 } from 'lucide-react';
import React from 'react';
import { GitHubConfigForm } from './GitHubConfigForm';
import { GitHubRepoCard } from './GitHubRepoCard';
import { GitHubSyncActions } from './GitHubSyncActions';
import { GitHubSyncDetails } from './GitHubSyncDetails';
import { useGitHubSync } from './useGitHubSync';
import { useTranslation } from '../../../hooks/useTranslation';

const GitHubSyncPanel = ({ user }) => {
    const { t } = useTranslation();
    const {
        status, loading, syncing, configuring, message, details, showDetails, setShowDetails,
        repoOwner, setRepoOwner, repoName, setRepoName, branch, setBranch, autoSync, setAutoSync,
        showConfig, setShowConfig, confirmDialog,
        handleConfigure, handleDisconnect, handlePushAll, handlePushPending, fetchDetails,
    } = useGitHubSync();

    if (loading) {
        return (
            <div className="max-w-2xl space-y-4 animate-pulse">
                <div className="h-6 w-48 bg-[var(--bg-tertiary)] rounded-lg" />
                <div className="h-32 bg-[var(--bg-tertiary)] rounded-2xl" />
                <div className="h-24 bg-[var(--bg-tertiary)] rounded-2xl" />
            </div>
        );
    }

    return (
        <div className="max-w-2xl space-y-6">
            {/* Header */}
            <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
                    <FolderGit2 className="w-5 h-5 text-[var(--accent-primary)]" />
                    {t('integ.git_hub_sync_github_sync', 'GitHub Sync')}
                </h2>
                <p className="text-sm text-[var(--text-muted)] mt-0.5">
                    {t('integ.git_hub_sync_version_control_your_ai_agent', 'Version-control your AI agent configurations by syncing them to a GitHub repository.')}
                </p>
            </div>

            {/* Message Banner */}
            {message && (
                <div className={`p-3 rounded-xl text-sm font-medium flex items-center gap-2 ${message.type === 'success'
                    ? 'bg-green-500/10 text-green-500 border border-green-500/20'
                    : 'bg-red-500/10 text-red-500 border border-red-500/20'
                    }`}>
                    {message.type === 'success' ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                    {message.text}
                </div>
            )}

            {/* GitHub Connection Required */}
            {!status?.githubConnected && (
                <div className="p-5 rounded-2xl border-2 border-dashed border-[var(--border-subtle)] text-center">
                    <GitBranch className="w-10 h-10 mx-auto mb-3 text-[var(--text-muted)] opacity-40" />
                    <p className="text-sm font-medium text-[var(--text-primary)]">{t('integ.git_hub_sync_github_not_connected', 'GitHub Not Connected')}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                        {t('integ.git_hub_sync_connect_your_github_account_in', 'Connect your GitHub account in Settings → Connections first, then return here to configure sync.')}
                    </p>
                </div>
            )}

            {/* Not Configured */}
            {status?.githubConnected && !status?.configured && !showConfig && (
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
                    <div className="p-6 text-center">
                        <div className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-4"
                            style={{ background: 'var(--brand-gradient-soft)' }}>
                            <FolderGit2 className="w-7 h-7 text-[var(--accent-primary)]" />
                        </div>
                        <h3 className="text-base font-bold text-[var(--text-primary)] mb-1">{t('integ.git_hub_sync_set_up_agent_sync', 'Set Up Agent Sync')}</h3>
                        <p className="text-sm text-[var(--text-muted)] mb-5 max-w-md mx-auto">
                            {t('integ.git_hub_sync_choose_a_github_repository_to_store', 'Choose a GitHub repository to store your agent configurations. Every change will be tracked as a commit with full diff history.')}
                        </p>
                        <button
                            onClick={() => setShowConfig(true)}
                            className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
                            style={{ background: 'var(--brand-gradient)' }}
                        >
                            {t('integ.git_hub_sync_configure_repository', 'Configure Repository')}
                        </button>
                    </div>
                </div>
            )}

            {/* Configuration Form */}
            {status?.githubConnected && (showConfig || (!status?.configured && showConfig)) && (
                <GitHubConfigForm
                    configured={status?.configured}
                    showConfig={showConfig}
                    configuring={configuring}
                    repoOwner={repoOwner} setRepoOwner={setRepoOwner}
                    repoName={repoName} setRepoName={setRepoName}
                    branch={branch} setBranch={setBranch}
                    autoSync={autoSync} setAutoSync={setAutoSync}
                    onConfigure={handleConfigure}
                    onCancel={() => setShowConfig(false)}
                />
            )}

            {/* Sync Dashboard (when configured) */}
            {status?.configured && !showConfig && (
                <>
                    {/* Connected Repo Card */}
                    <GitHubRepoCard
                        config={status.config}
                        overview={status.overview}
                        onEdit={() => setShowConfig(true)}
                        onDisconnect={handleDisconnect}
                    />

                    <GitHubSyncActions
                        syncing={syncing}
                        overview={status.overview}
                        lastFullSync={status.config?.lastFullSync}
                        showDetails={showDetails}
                        onPushAll={handlePushAll}
                        onPushPending={handlePushPending}
                        onToggleDetails={() => showDetails ? setShowDetails(false) : fetchDetails()}
                    />

                    {/* Detailed Sync States */}
                    {showDetails && details && (
                        <GitHubSyncDetails details={details} />
                    )}

                    {/* Info Box */}
                    <div className="p-3 rounded-xl text-[12px] flex items-start gap-2"
                        style={{ background: 'var(--brand-gradient-soft)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                        <FolderGit2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-[var(--accent-primary)]" />
                        <span>
                            {t('integ.git_hub_sync_agent_system_prompts_are_stored_as', 'Agent system prompts are stored as')} <code className="text-[11px] px-1 py-0.5 rounded bg-[var(--bg-tertiary)]">.md</code> {t('integ.git_hub_sync_files_for_clean_diffs_each_agent', 'files for clean diffs. Each agent change creates a traceable commit in your GitHub repo.')}
                        </span>
                    </div>
                </>
            )}
            {confirmDialog}
        </div>
    );
};

export default GitHubSyncPanel;
