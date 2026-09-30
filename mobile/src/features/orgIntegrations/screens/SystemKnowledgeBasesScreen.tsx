/**
 * System knowledge bases (web: knowledge/SystemKnowledgeBasesPanel.jsx, the
 * legacy /app/org-settings/knowledge-bases tab): the read-only collections Bee
 * Flow maintains, and switching one on makes it available to the
 * organisation's agents and chat — the same picker as its own bases.
 *
 * Differences from the web, both deliberate: the super admin's "Refresh now"
 * is absent, because the server no longer serves /api/kb/system/:slug/refresh
 * or /status; and where the subscription governs the betas (cloud) the
 * switches are shown locked with why, since the server ignores them there.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useSystemKnowledgeBases, type SystemKb } from '@/features/knowledge';
import { OrgLockedScreen } from '@/features/org';
import { QueryList } from '@/shared/patterns';
import { NoteRow, Screen, ScreenHeader, useToast } from '@/shared/ui';

import { SystemKbRow } from '../components/SystemKbRow';
import { useActiveFeatures } from '../hooks/integrationQueries';
import { useIntegrationAccess } from '../hooks/useIntegrationAccess';
import { useToggleSystemKb } from '../hooks/useToggleSystemKb';

const keyOf = (kb: SystemKb) => kb.id;

export function SystemKnowledgeBasesScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const access = useIntegrationAccess();
    const query = useSystemKnowledgeBases(access.admin);
    const features = useActiveFeatures(access.admin);
    const toggle = useToggleSystemKb(access.orgId, access.isSuperAdmin, () => query.refetch());
    const governed = features.data?.betaGoverned === true && !access.isSuperAdmin;
    const title = t('mobile.org.section_knowledge_bases', 'System knowledge bases');
    if (!access.admin) return <OrgLockedScreen title={title} />;

    const onToggle = (kb: SystemKb) => toggle.mutate(kb, { onError: (err) => toast(describeError(err).message, 'error') });

    return (
        <Screen edges={['top']}>
            <ScreenHeader title={title} subtitle={t('mobile.knowledge.system_hint', 'Read-only collections maintained by Bee Flow')} />
            <QueryList
                query={query}
                keyExtractor={keyOf}
                renderItem={({ item }) => (
                    <SystemKbRow kb={item} locked={governed} busy={toggle.isPending && toggle.variables?.id === item.id} onToggle={onToggle} />
                )}
                ListHeaderComponent={
                    <NoteRow>
                        {governed
                            ? t('mobile.orgIntegrations.kb_governed', 'On this deployment your subscription plan decides which system knowledge bases your organisation has.')
                            : t(
                                  'mobile.orgIntegrations.kb_intro',
                                  'Switch a collection on to make it available to your agents and chat — the same picker as your own knowledge bases.',
                              )}
                    </NoteRow>
                }
                empty={{
                    icon: 'BookOpen',
                    title: t('mobile.knowledge.system_empty', 'No system knowledge bases yet'),
                    message: t('mobile.knowledge.system_empty_hint', 'The server provides them when a feature that uses one is switched on.'),
                }}
            />
        </Screen>
    );
}
