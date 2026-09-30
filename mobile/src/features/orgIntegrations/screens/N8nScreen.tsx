/**
 * n8n (web: pages/settings/N8nSection.jsx, under Integrations): the
 * organisation's n8n connection, the workflows the AI may run as tools, and
 * who may let the AI modify workflows — the web's three tabs. Org admins
 * (requireOrgAdminForN8n on every write).
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { OrgSettingsFrame } from '@/features/org';
import { useConfirmLeave } from '@/shared/patterns';
import { ErrorState, LoadingState, SaveBar, Segmented, useToast } from '@/shared/ui';

import { N8nConnectionPane } from '../components/N8nConnectionPane';
import { N8nPermissionsPane } from '../components/N8nPermissionsPane';
import { N8nStatusBadge } from '../components/N8nStatusBadge';
import { N8nWorkflowsPane } from '../components/N8nWorkflowsPane';
import { useN8nConfig, useN8nPermissions } from '../hooks/n8nQueries';
import { useIntegrationAccess } from '../hooks/useIntegrationAccess';
import { useWorkflowDraft } from '../hooks/useWorkflowDraft';
import type { N8nTestResult } from '../model/n8nTypes';

type Tab = 'connection' | 'workflows' | 'permissions';

const styles = StyleSheet.create({ head: { gap: 8, alignItems: 'flex-start' } });

export function N8nScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const { admin } = useIntegrationAccess();
    const [tab, setTab] = useState<Tab>('connection');
    const [test, setTest] = useState<N8nTestResult | null>(null);
    const query = useN8nConfig(admin);
    const permissions = useN8nPermissions(admin && tab === 'permissions');
    const draft = useWorkflowDraft(query.data?.workflows ?? []);
    useConfirmLeave(draft.dirty);
    const tabs = [
        { value: 'connection' as const, label: t('mobile.orgIntegrations.n8n_connection', 'Connection') },
        { value: 'workflows' as const, label: t('mobile.orgIntegrations.n8n_workflows', 'Workflows') },
        { value: 'permissions' as const, label: t('mobile.orgIntegrations.n8n_permissions', 'Permissions') },
    ];
    const onSaveAll = () =>
        draft.save().then(
            () => toast(t('mobile.orgIntegrations.n8n_workflows_saved', 'Workflows saved'), 'success'),
            (err: unknown) => toast(describeError(err).message, 'error'),
        );

    return (
        <OrgSettingsFrame
            title={t('mobile.orgIntegrations.n8n', 'n8n')}
            subtitle={t('org.integ_n8n_desc', 'Connect n8n workflows as AI tools')}
            allowed={admin}
            query={query}
            onRefresh={() => permissions.refetch()}
            footer={
                tab === 'workflows' ? (
                    <SaveBar dirty={draft.dirty} saving={draft.saving} onSave={() => void onSaveAll()} onDiscard={draft.discard} />
                ) : null
            }
        >
            {(config) => (
                <>
                    <View style={styles.head}>
                        <N8nStatusBadge configured={config.configured} test={test} />
                        <Segmented options={tabs} value={tab} onChange={setTab} fullWidth />
                    </View>
                    {tab === 'connection' ? (
                        <N8nConnectionPane config={config} test={test} onTested={setTest} onPermissions={() => setTab('permissions')} />
                    ) : null}
                    {tab === 'workflows' ? <N8nWorkflowsPane configured={config.configured} draft={draft} /> : null}
                    {tab === 'permissions' && permissions.data ? <N8nPermissionsPane summary={permissions.data} /> : null}
                    {tab === 'permissions' && permissions.isLoading ? <LoadingState /> : null}
                    {tab === 'permissions' && permissions.isError ? (
                        <ErrorState error={permissions.error} onRetry={() => void permissions.refetch()} />
                    ) : null}
                </>
            )}
        </OrgSettingsFrame>
    );
}
