/**
 * The n8n Workflows tab (N8nSection.jsx WorkflowsTab): discover the active
 * webhook workflows on the instance, add one as an AI tool, and switch the
 * configured ones on and off or open one to edit it. Needs a connection.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { Badge, Button, EmptyState, Group, ListRow, SearchField, Switch, useToast } from '@/shared/ui';

import { N8nWorkflowSheet } from './N8nWorkflowSheet';
import { useDiscoverN8n } from '../hooks/n8nMutations';
import type { WorkflowDraft } from '../hooks/useWorkflowDraft';
import { matchDiscovered, matchWorkflows } from '../model/n8n';
import type { DiscoveredWorkflow, N8nWorkflow } from '../model/n8nTypes';

export function N8nWorkflowsPane({ configured, draft }: { configured: boolean; draft: WorkflowDraft }) {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const discover = useDiscoverN8n();
    const [query, setQuery] = useState('');
    const [openId, setOpenId] = useState<string | null>(null);
    if (!configured) {
        return (
            <EmptyState
                icon="Info"
                title={t('mobile.orgIntegrations.n8n_connect_first', 'Connect to n8n first — fill in the URL and API key on the Connection tab.')}
            />
        );
    }
    const found = matchDiscovered(discover.data ?? [], query);
    const shown = matchWorkflows(draft.list, query);
    const enabledCount = draft.list.filter((w) => w.enabled).length;

    const onDiscover = () =>
        discover.mutate(undefined, {
            onSuccess: (list) =>
                toast(t('mobile.orgIntegrations.n8n_found', 'Found {n} webhook workflow(s)', { n: list.length }), 'success'),
            onError: (err) => toast(describeError(err).message, 'error'),
        });
    const onAdd = async (workflow: DiscoveredWorkflow) => {
        try {
            if (await draft.add(workflow)) toast(t('mobile.orgIntegrations.n8n_added', 'Added "{name}"', { name: workflow.name }), 'success');
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };
    const onRemove = async (workflow: N8nWorkflow) => {
        const ok = await confirm({
            title: t('mobile.orgIntegrations.n8n_wf_remove', 'Remove workflow'),
            message: t('mobile.orgIntegrations.n8n_wf_remove_message', 'The AI can no longer run "{name}". The workflow itself stays in n8n.', { name: workflow.name }),
            confirmLabel: t('mobile.orgIntegrations.n8n_wf_remove', 'Remove workflow'),
        });
        if (!ok) return;
        setOpenId(null);
        draft.remove(workflow.id).catch((err: unknown) => toast(describeError(err).message, 'error'));
    };

    return (
        <>
            <SearchField value={query} onChangeText={setQuery} placeholder={t('mobile.orgIntegrations.n8n_search', 'Search workflows...')} />
            <Button
                testID="n8n-discover"
                label={t('mobile.orgIntegrations.n8n_discover', 'Discover')}
                variant="secondary"
                iconName="RefreshCw"
                loading={discover.isPending}
                onPress={onDiscover}
            />
            {found.length > 0 ? (
                <Group title={t('mobile.orgIntegrations.n8n_available', 'Available to add')}>
                    {found.map((workflow) => {
                        const added = draft.list.some((w) => w.id === workflow.id);
                        return (
                            <ListRow
                                key={workflow.id}
                                testID={`n8n-found-${workflow.id}`}
                                title={workflow.name}
                                subtitle={workflow.webhookNodes.map((n) => `${n.method} /webhook/${n.path}`).join(', ')}
                                trailing={
                                    added ? (
                                        <Badge label={t('mobile.orgIntegrations.n8n_added_badge', 'Added')} tone="success" icon="Check" />
                                    ) : (
                                        <Button label={t('mobile.orgIntegrations.n8n_add', 'Add')} size="sm" iconName="Plus" onPress={() => void onAdd(workflow)} />
                                    )
                                }
                            />
                        );
                    })}
                </Group>
            ) : null}
            {draft.list.length === 0 ? (
                <EmptyState
                    icon="Workflow"
                    title={t('mobile.orgIntegrations.n8n_none', 'No workflows configured yet. Tap Discover to scan your n8n instance for webhook-triggered workflows.')}
                />
            ) : (
                <Group
                    title={t('mobile.orgIntegrations.n8n_workflows_count', 'Workflows ({on}/{all} enabled)', { on: enabledCount, all: draft.list.length })}
                >
                    {shown.map((workflow) => (
                        <ListRow
                            key={workflow.id}
                            testID={`n8n-wf-${workflow.id}`}
                            title={workflow.name}
                            subtitle={`n8n_run_${workflow.slug} · ${t('mobile.orgIntegrations.n8n_inputs', '{n} input(s)', { n: workflow.inputs.length })}`}
                            trailing={<Switch value={workflow.enabled} onValueChange={(enabled) => draft.update(workflow.id, { enabled })} />}
                            onPress={() => setOpenId(workflow.id)}
                        />
                    ))}
                </Group>
            )}
            <N8nWorkflowSheet
                workflow={draft.list.find((w) => w.id === openId) ?? null}
                draft={draft}
                onRemove={(workflow) => void onRemove(workflow)}
                onClose={() => setOpenId(null)}
            />
        </>
    );
}
