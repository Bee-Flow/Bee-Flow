/** GitHub Sync's actions with the web's result sentences (GitHubSyncPanel.jsx). */

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { useToast } from '@/shared/ui';

import { useDisconnectGithubSync, usePushAllToGithub, usePushPendingToGithub } from './githubHooks';

export function useGithubActions() {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const disconnect = useDisconnectGithubSync();
    const pushAll = usePushAllToGithub();
    const pushPending = usePushPendingToGithub();
    const fail = (err: unknown) => toast(describeError(err).message, 'error');

    return {
        busy: pushAll.isPending || pushPending.isPending,
        pushAll: () =>
            pushAll.mutate(undefined, {
                onSuccess: (r) => {
                    const skipped = r.agents.skipped + r.skills.skipped;
                    const done = t('mobile.orgIntegrations.gh_pushed_all', 'Sync complete! {agents} agents, {skills} skills pushed.', {
                        agents: r.agents.pushed,
                        skills: r.skills.pushed,
                    });
                    const unchanged = skipped > 0 ? ` ${t('mobile.orgIntegrations.gh_unchanged', '({n} unchanged)', { n: skipped })}` : '';
                    toast(`${done}${unchanged}`, 'success');
                },
                onError: fail,
            }),
        pushPending: () =>
            pushPending.mutate(undefined, {
                onSuccess: (r) => {
                    const done = t('mobile.orgIntegrations.gh_pushed_pending', 'Pushed {n} pending changes.', { n: r.pushed });
                    const errors = r.errors > 0 ? ` ${t('mobile.orgIntegrations.gh_push_errors', '({n} errors)', { n: r.errors })}` : '';
                    toast(`${done}${errors}`, r.errors > 0 ? 'error' : 'success');
                },
                onError: fail,
            }),
        disconnect: async () => {
            const ok = await confirm({
                title: t('mobile.orgIntegrations.gh_disconnect_title', 'Disconnect GitHub sync?'),
                message: t('mobile.orgIntegrations.gh_disconnect_message', 'This will stop syncing agent configurations.'),
                confirmLabel: t('mobile.orgIntegrations.gh_disconnect', 'Disconnect'),
            });
            if (!ok) return;
            disconnect.mutate(undefined, {
                onSuccess: () => toast(t('mobile.orgIntegrations.gh_disconnected', 'GitHub sync disconnected'), 'success'),
                onError: fail,
            });
        },
    };
}
