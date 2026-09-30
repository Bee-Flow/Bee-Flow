/**
 * GitHub Sync (web: integrations/github/GitHubSyncPanel.jsx): commit the
 * organisation's agent and skill configurations to a GitHub repository —
 * system prompts as .md files, one traceable commit per change. Pushing uses
 * YOUR GitHub token, so it asks for a connected GitHub first. Org admins who
 * may manage agents (every route requires `manage_agents`).
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { OrgSettingsFrame } from '@/features/org';
import { Button, EmptyState, Group, NoteRow } from '@/shared/ui';

import { GithubConfigSheet } from '../components/GithubConfigSheet';
import { GithubDetailsSheet } from '../components/GithubDetailsSheet';
import { GithubRepoGroup } from '../components/GithubRepoGroup';
import { useGithubSyncStatus } from '../hooks/githubHooks';
import { useGithubActions } from '../hooks/useGithubActions';
import { useIntegrationAccess } from '../hooks/useIntegrationAccess';

export function GithubSyncScreen() {
    const t = useTranslation();
    const router = useRouter();
    const { manageAgents, admin } = useIntegrationAccess();
    const query = useGithubSyncStatus(manageAgents);
    const actions = useGithubActions();
    const [configuring, setConfiguring] = useState(false);
    // Each opening mounts a fresh sheet: the form starts from the stored config.
    const [opening, setOpening] = useState(0);
    const configure = () => {
        setOpening((n) => n + 1);
        setConfiguring(true);
    };
    const [details, setDetails] = useState(false);

    return (
        <OrgSettingsFrame
            title={t('settings.github_sync', 'GitHub Sync')}
            subtitle={t('mobile.orgIntegrations.gh_intro', 'Version-control your AI agent configurations by syncing them to a GitHub repository.')}
            allowed={manageAgents}
            // An org admin without "Manage agents" reaches this from the hub.
            denied={
                admin
                    ? {
                          icon: 'Lock',
                          title: t('mobile.org.needs_permission_title', 'Needs another permission'),
                          message: t('mobile.orgIntegrations.gh_needs_manage_agents', 'Syncing agents to GitHub needs the Manage agents permission as well.'),
                      }
                    : undefined
            }
            query={query}
        >
            {(status) => (
                <>
                    {!status.githubConnected ? (
                        <EmptyState
                            icon="GitBranch"
                            title={t('mobile.orgIntegrations.gh_not_connected', 'GitHub Not Connected')}
                            message={t('mobile.orgIntegrations.gh_not_connected_hint', 'Connect your GitHub account under Integrations first, then return here to configure sync.')}
                            actionLabel={t('settings.integrations', 'Integrations')}
                            onAction={() => router.push('/integrations')}
                        />
                    ) : null}
                    {status.githubConnected && !status.configured ? (
                        <EmptyState
                            icon="FolderGit2"
                            title={t('mobile.orgIntegrations.gh_setup', 'Set Up Agent Sync')}
                            message={t(
                                'mobile.orgIntegrations.gh_setup_hint',
                                'Choose a GitHub repository to store your agent configurations. Every change will be tracked as a commit with full diff history.',
                            )}
                            actionLabel={t('mobile.orgIntegrations.gh_configure', 'Configure Repository')}
                            onAction={configure}
                        />
                    ) : null}
                    {status.githubConnected && status.configured && status.config ? (
                        <>
                            <GithubRepoGroup
                                config={status.config}
                                overview={status.overview}
                                actions={{
                                    busy: actions.busy,
                                    onEdit: configure,
                                    onDisconnect: () => void actions.disconnect(),
                                    onPushAll: actions.pushAll,
                                    onPushPending: actions.pushPending,
                                    onDetails: () => setDetails(true),
                                }}
                            />
                            <Group>
                                <NoteRow>
                                    {t(
                                        'mobile.orgIntegrations.gh_md_note',
                                        'Agent system prompts are stored as .md files for clean diffs. Each agent change creates a traceable commit in your GitHub repo.',
                                    )}
                                </NoteRow>
                            </Group>
                        </>
                    ) : null}
                    {status.githubConnected && status.configured && !status.config ? (
                        <Button label={t('mobile.orgIntegrations.gh_configure', 'Configure Repository')} onPress={configure} />
                    ) : null}
                    <GithubConfigSheet key={opening} visible={configuring} config={status.config} onClose={() => setConfiguring(false)} />
                    <GithubDetailsSheet visible={details} onClose={() => setDetails(false)} />
                </>
            )}
        </OrgSettingsFrame>
    );
}
