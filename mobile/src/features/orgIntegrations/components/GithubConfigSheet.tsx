/**
 * The repository to sync to (GitHubSyncPanel.jsx "Repository Configuration"):
 * owner, name, branch and auto-sync. The server checks the names against
 * GitHub's grammar and that the repository is reachable with your own
 * GitHub token; its refusal is shown in the sheet. The screen mounts a new
 * sheet on each opening, so the form starts from the stored configuration.
 */

import React, { useState } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { FormSheet } from '@/shared/patterns';
import { TextField, ToggleRow, useToast } from '@/shared/ui';

import { useConfigureGithubSync } from '../hooks/githubHooks';
import { formFrom, formProblem, type FormProblem } from '../model/github';
import type { GithubSyncConfig, GithubSyncForm } from '../model/githubTypes';

/** Example values, as the web's fields show them. */
const REPO_EXAMPLE = 'beeflow-agents';
const BRANCH_EXAMPLE = 'main';

function problemText(problem: FormProblem, t: TranslateFn): string | null {
    if (problem === 'owner') return t('mobile.orgIntegrations.gh_owner_invalid', 'The GitHub user or organisation, e.g. bee-flow.');
    if (problem === 'name') return t('mobile.orgIntegrations.gh_name_invalid', 'The repository name, e.g. agent-configs.');
    if (problem === 'branch') return t('mobile.orgIntegrations.gh_branch_invalid', 'That is not a valid git branch name.');
    return null;
}

export function GithubConfigSheet({ visible, config, onClose }: { visible: boolean; config: GithubSyncConfig | null; onClose: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const configure = useConfigureGithubSync();
    const [form, setForm] = useState<GithubSyncForm>(formFrom(config));
    const set = <K extends keyof GithubSyncForm>(key: K, value: GithubSyncForm[K]) => setForm((f) => ({ ...f, [key]: value }));
    const problem = formProblem(form);
    const touched = form.repoOwner.trim() !== '' && form.repoName.trim() !== '';

    const submit = async () => {
        try {
            await configure.mutateAsync(form);
            toast(t('mobile.orgIntegrations.gh_configured', 'GitHub sync configured successfully!'), 'success');
            onClose();
        } catch {
            // The sheet shows the server's reason.
        }
    };

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.orgIntegrations.gh_repo_config', 'Repository Configuration')}
            submitLabel={config ? t('mobile.orgIntegrations.gh_update', 'Update Configuration') : t('mobile.orgIntegrations.gh_connect', 'Connect Repository')}
            onSubmit={() => void submit()}
            submitting={configure.isPending}
            canSubmit={touched && problem === null}
            error={configure.error}
            cancelLabel={t('common.cancel', 'Cancel')}
        >
            <TextField
                testID="gh-owner"
                label={t('mobile.orgIntegrations.gh_owner', 'Repository Owner')}
                placeholder={t('mobile.orgIntegrations.gh_owner_ph', 'your-username')}
                autoCapitalize="none"
                value={form.repoOwner}
                error={touched && problem === 'owner' ? problemText(problem, t) : null}
                onChangeText={(v) => set('repoOwner', v)}
            />
            <TextField
                testID="gh-name"
                label={t('mobile.orgIntegrations.gh_name', 'Repository Name')}
                placeholder={REPO_EXAMPLE}
                autoCapitalize="none"
                value={form.repoName}
                error={touched && problem === 'name' ? problemText(problem, t) : null}
                onChangeText={(v) => set('repoName', v)}
            />
            <TextField
                testID="gh-branch"
                label={t('mobile.orgIntegrations.gh_branch', 'Branch')}
                placeholder={BRANCH_EXAMPLE}
                autoCapitalize="none"
                value={form.branch}
                error={problem === 'branch' ? problemText(problem, t) : null}
                onChangeText={(v) => set('branch', v)}
            />
            <ToggleRow
                testID="gh-auto-sync"
                gutter={false}
                label={t('mobile.orgIntegrations.gh_auto_sync', 'Auto-sync')}
                description={t('mobile.orgIntegrations.gh_auto_sync_desc', 'Automatically push changes when agents are modified')}
                value={form.autoSync}
                onValueChange={(v) => set('autoSync', v)}
            />
        </FormSheet>
    );
}
