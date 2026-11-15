import { GitBranch, Check, AlertTriangle, FolderGit2, ArrowRight } from 'lucide-react';
import { GitHubConfigForm } from './GitHubConfigForm';
import { GitHubRepoCard } from './GitHubRepoCard';
import type { GitHubSyncConfig } from './githubSync.types';
import { GitHubSyncActions } from './GitHubSyncActions';
import { GitHubSyncDetails } from './GitHubSyncDetails';
import { useGitHubSync } from './useGitHubSync';
import NavLink from '@/components/shell/NavLink';
import { Button } from '@/components/shared/Button';
import { ALERT_ERROR, ALERT_INFO, ALERT_SUCCESS, DASHED, SECONDARY_BTN } from '@/components/shared/adminUi';
import type { PermissionUser } from '@/hooks/usePermissionCheck';
import { useTranslation } from '@/hooks/useTranslation';

interface GitHubSyncPanelProps {
    user: PermissionUser | null | undefined;
}

/** Where a member links their own GitHub account. */
const CONNECTIONS_HREF = '/app/settings/integrations';

function openConnections() {
    try {
        window.history.pushState({}, '', CONNECTIONS_HREF);
        window.dispatchEvent(new PopStateEvent('popstate'));
    } catch {
        window.location.href = CONNECTIONS_HREF;
    }
}

/** The link to Settings > Connections, where the viewer connects their own GitHub account. */
function ConnectionsLink() {
    const { t } = useTranslation();
    return (
        <NavLink href={CONNECTIONS_HREF} onNavigate={openConnections} className={`${SECONDARY_BTN} [text-decoration:none]!`}>
            {t('admin_connections.target_connections', 'Settings › Connections')}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </NavLink>
    );
}

/** No sync and no personal GitHub link: nothing can be set up until the viewer connects GitHub. */
function NotConnected() {
    const { t } = useTranslation();
    return (
        <div className={`${DASHED} flex-col items-center text-center py-6`}>
            <GitBranch className="w-8 h-8 text-[var(--text-muted)]" aria-hidden="true" />
            <p className="m-0 text-sm font-medium text-[var(--text-primary)]">{t('integ.git_hub_sync_github_not_connected', 'GitHub Not Connected')}</p>
            <p className="m-0 text-xs text-[var(--text-muted)] max-w-md">
                {t('admin_connections.gh_connect_first', 'Pushing to GitHub uses your own GitHub account. Connect it in Settings › Connections, then come back here to set up the sync.')}
            </p>
            <ConnectionsLink />
        </div>
    );
}

/**
 * A sync is configured but the viewer has no GitHub link of their own: the
 * sync shows and can be disconnected, pushing and editing wait for a link
 * (the server pushes with the caller's own token).
 */
function NeedsPersonalToken() {
    const { t } = useTranslation();
    return (
        <div className={ALERT_INFO} role="note">
            <GitBranch className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span>{t('admin_connections.gh_needs_token', 'Pushing to GitHub uses your own GitHub account. Connect it in Settings › Connections to push or change the repository.')}</span>
                <div><ConnectionsLink /></div>
            </div>
        </div>
    );
}

function SetUpCard({ onConfigure }: { onConfigure: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 text-center">
            <div className="w-12 h-12 mx-auto rounded-xl flex items-center justify-center mb-4 bg-[var(--bg-tertiary)]">
                <FolderGit2 className="w-6 h-6 text-[var(--text-secondary)]" aria-hidden="true" />
            </div>
            <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)] mb-1">{t('integ.git_hub_sync_set_up_agent_sync', 'Set Up Agent Sync')}</h3>
            <p className="text-sm text-[var(--text-muted)] mb-5 max-w-md mx-auto">
                {t('integ.git_hub_sync_choose_a_github_repository_to_store', 'Choose a GitHub repository to store your agent configurations. Every change will be tracked as a commit with full diff history.')}
            </p>
            <Button variant="primary" onClick={onConfigure}>
                {t('integ.git_hub_sync_configure_repository', 'Configure Repository')}
            </Button>
        </div>
    );
}

const GitHubSyncPanel = (_props: GitHubSyncPanelProps) => {
    const { t } = useTranslation();
    const {
        status, loading, syncing, configuring, message, details, showDetails, setShowDetails,
        repoOwner, setRepoOwner, repoName, setRepoName, branch, setBranch, autoSync, setAutoSync,
        showConfig, setShowConfig, confirmDialog,
        handleConfigure, handleDisconnect, handlePushAll, handlePushPending, fetchDetails,
    } = useGitHubSync();

    if (loading) {
        return (
            <div className="space-y-4 animate-pulse" role="status">
                <div className="h-32 bg-[var(--bg-tertiary)] rounded-xl" />
                <div className="h-24 bg-[var(--bg-tertiary)] rounded-xl" />
            </div>
        );
    }

    const connected = !!status?.githubConnected;
    const configured = !!status?.configured;
    return (
        <div className="space-y-6" data-testid="github-sync-panel">
            {message && (
                <div role={message.type === 'success' ? 'status' : 'alert'} className={message.type === 'success' ? ALERT_SUCCESS : ALERT_ERROR}>
                    {message.type === 'success' ? <Check className="w-4 h-4 shrink-0" aria-hidden="true" /> : <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />}
                    {message.text}
                </div>
            )}

            {!connected && !configured && <NotConnected />}
            {!connected && configured && <NeedsPersonalToken />}

            {connected && !configured && !showConfig && <SetUpCard onConfigure={() => setShowConfig(true)} />}

            {connected && showConfig && (
                <GitHubConfigForm
                    configured={configured}
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

            {configured && !showConfig && (
                <>
                    <GitHubRepoCard
                        config={status?.config as GitHubSyncConfig}
                        overview={status?.overview}
                        canEdit={connected}
                        onEdit={() => setShowConfig(true)}
                        onDisconnect={handleDisconnect}
                    />
                    <GitHubSyncActions
                        syncing={syncing}
                        canPush={connected}
                        overview={status?.overview}
                        lastFullSync={status?.config?.lastFullSync}
                        showDetails={showDetails}
                        onPushAll={handlePushAll}
                        onPushPending={handlePushPending}
                        onToggleDetails={() => showDetails ? setShowDetails(false) : fetchDetails()}
                    />
                    {showDetails && details && <GitHubSyncDetails details={details} />}
                    <div className={ALERT_INFO}>
                        <FolderGit2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
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
