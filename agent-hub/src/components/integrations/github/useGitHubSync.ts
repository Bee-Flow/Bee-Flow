import { useState, useEffect, useCallback } from 'react';
import { githubSyncApi } from '@/api/githubSyncApi';
import { errorMessage } from '@/utils/caughtError';
import useConfirm from '../../shared/useConfirm';
import type { GitHubSyncDetail, GitHubSyncMessage, GitHubSyncStatus } from './githubSync.types';

/** The sync status, the configuration form and the actions of the GitHub sync panel. */
export function useGitHubSync() {
    const [status, setStatus] = useState<GitHubSyncStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [configuring, setConfiguring] = useState(false);
    const [message, setMessage] = useState<GitHubSyncMessage | null>(null);
    const [details, setDetails] = useState<GitHubSyncDetail[] | null>(null);
    const [showDetails, setShowDetails] = useState(false);

    // Config form
    const [repoOwner, setRepoOwner] = useState('');
    const [repoName, setRepoName] = useState('');
    const [branch, setBranch] = useState('main');
    const [autoSync, setAutoSync] = useState(false);
    const [showConfig, setShowConfig] = useState(false);
    const { confirm, confirmDialog } = useConfirm();

    const fetchStatus = useCallback(async () => {
        try {
            const res = await githubSyncApi.status();
            if (res.ok) {
                const data = await res.json();
                setStatus(data);
                if (data.config) {
                    setRepoOwner(data.config.repoOwner || '');
                    setRepoName(data.config.repoName || '');
                    setBranch(data.config.branch || 'main');
                    setAutoSync(data.config.autoSync || false);
                }
            }
        } catch (err) {
            console.error('[GitHubSync] Status fetch error:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchStatus(); }, [fetchStatus]);

    useEffect(() => {
        if (message) {
            const timer = setTimeout(() => setMessage(null), 5000);
            return () => clearTimeout(timer);
        }
    }, [message]);

    const handleConfigure = async () => {
        if (!repoOwner.trim() || !repoName.trim()) {
            setMessage({ type: 'error', text: 'Repository owner and name are required' });
            return;
        }
        setConfiguring(true);
        try {
            const res = await githubSyncApi.configure({ repoOwner: repoOwner.trim(), repoName: repoName.trim(), branch: branch.trim() || 'main', autoSync });
            const data = await res.json();
            if (res.ok) {
                setMessage({ type: 'success', text: 'GitHub sync configured successfully!' });
                setShowConfig(false);
                await fetchStatus();
            } else {
                setMessage({ type: 'error', text: data.error || 'Configuration failed' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'Failed to configure sync' });
        } finally {
            setConfiguring(false);
        }
    };

    const handleDisconnect = async () => {
        if (!(await confirm({ title: 'Disconnect GitHub sync?', description: 'This will stop syncing agent configurations.', confirmLabel: 'Disconnect', destructive: true }))) return;
        try {
            const res = await githubSyncApi.disconnect();
            if (res.ok) {
                setMessage({ type: 'success', text: 'GitHub sync disconnected' });
                setStatus(prev => ({ ...prev, configured: false, config: null, overview: null }));
                // Clear the config form so re-configuring starts from a clean slate.
                setRepoOwner('');
                setRepoName('');
                setBranch('main');
                setAutoSync(false);
                setShowConfig(false);
                setShowDetails(false);
                setDetails(null);
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'Failed to disconnect' });
        }
    };

    const handlePushAll = async () => {
        setSyncing(true);
        try {
            const res = await githubSyncApi.push();
            const data = await res.json();
            if (res.ok) {
                const r = data.results;
                setMessage({
                    type: 'success',
                    text: `Sync complete! ${r.agents.pushed} agents, ${r.skills.pushed} skills pushed.${r.agents.skipped + r.skills.skipped > 0 ? ` (${r.agents.skipped + r.skills.skipped} unchanged)` : ''}`
                });
                await fetchStatus();
            } else {
                setMessage({ type: 'error', text: data.error || 'Sync failed' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'Sync failed: ' + errorMessage(err) });
        } finally {
            setSyncing(false);
        }
    };

    const handlePushPending = async () => {
        setSyncing(true);
        try {
            const res = await githubSyncApi.pushPending();
            const data = await res.json();
            if (res.ok) {
                const r = data.results;
                setMessage({ type: 'success', text: `Pushed ${r.pushed} pending changes.${r.errors > 0 ? ` (${r.errors} errors)` : ''}` });
                await fetchStatus();
            } else {
                setMessage({ type: 'error', text: data.error || 'Push failed' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'Push failed: ' + errorMessage(err) });
        } finally {
            setSyncing(false);
        }
    };

    const fetchDetails = async () => {
        try {
            const res = await githubSyncApi.details();
            if (res.ok) {
                const data = await res.json();
                setDetails(data);
                setShowDetails(true);
            }
        } catch (err) {
            console.error('[GitHubSync] Details fetch error:', err);
        }
    };

    return {
        status, loading, syncing, configuring, message, details, showDetails, setShowDetails,
        repoOwner, setRepoOwner, repoName, setRepoName, branch, setBranch, autoSync, setAutoSync,
        showConfig, setShowConfig, confirmDialog,
        handleConfigure, handleDisconnect, handlePushAll, handlePushPending, fetchDetails,
    };
}
