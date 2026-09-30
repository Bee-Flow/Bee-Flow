/**
 * Nextcloud integrations (web: integrations/nextcloud/OrgNcIntegrationsPanel.jsx),
 * for an NC-bound organisation: which Nextcloud tools the organisation's
 * agents may use (saved together), and per synced Nextcloud group, which of
 * them it may not (each switch saved at once). At run time "enable wins": a
 * member loses a tool only when every one of their groups blocks it.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { OrgSettingsFrame, useDraft } from '@/features/org';
import { useConfirmLeave } from '@/shared/patterns';
import { Group, SaveBar, ToggleRow, useToast } from '@/shared/ui';

import { NcExceptionsGroup } from '../components/NcExceptionsGroup';
import { NcGroupSheet } from '../components/NcGroupSheet';
import { useSaveNcIntegrations, useSetNcGroupDisabled } from '../hooks/integrationMutations';
import { useNcIntegrationGroups, useNcIntegrations } from '../hooks/integrationQueries';
import { useIntegrationAccess } from '../hooks/useIntegrationAccess';
import { toggleIn } from '../model/lists';
import type { NcIntegrationGroup } from '../model/types';

export function NcIntegrationsScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const access = useIntegrationAccess();
    const allowed = access.admin && access.isNcOrg;
    const orgId = allowed ? access.orgId : null;
    const query = useNcIntegrations(orgId);
    const groups = useNcIntegrationGroups(orgId);
    const save = useSaveNcIntegrations(orgId);
    const setGroup = useSetNcGroupDisabled(orgId);
    const form = useDraft(query.data ? { enabled: query.data.enabled } : null);
    useConfirmLeave(form.dirty);
    const [openGroupId, setOpenGroupId] = useState<string | null>(null);
    const order = (query.data?.catalog ?? []).map((tool) => tool.id);
    const enabled = form.draft?.enabled ?? [];

    const onSave = async () => {
        try {
            await save.mutateAsync(enabled);
            form.reset();
            toast(t('common.saved', 'Saved'), 'success');
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };
    const onToggleGroup = (group: NcIntegrationGroup, toolId: string) =>
        setGroup.mutate(
            { groupId: group.id, disabled: toggleIn(group.disabledIntegrations, toolId, order) },
            { onError: (err) => toast(describeError(err).message, 'error') },
        );
    const openGroup = groups.data?.find((g) => g.id === openGroupId) ?? null;

    return (
        <OrgSettingsFrame
            title={t('mobile.orgIntegrations.nc_title', 'Nextcloud integrations')}
            subtitle={t('org.integ_title', 'Organisation Integrations')}
            allowed={allowed}
            query={query}
            onRefresh={() => groups.refetch()}
            footer={<SaveBar dirty={form.dirty} saving={save.isPending} onSave={() => void onSave()} onDiscard={form.reset} />}
        >
            {(data) => (
                <>
                    <Group
                        title={t('mobile.orgIntegrations.nc_org_wide', 'Org-wide')}
                        footer={t('mobile.orgIntegrations.nc_org_wide_hint', 'Default for every member of this organisation.')}
                    >
                        {data.catalog.map((tool) => (
                            <ToggleRow
                                key={tool.id}
                                testID={`nc-tool-${tool.id}`}
                                label={tool.name}
                                description={tool.description}
                                value={enabled.includes(tool.id)}
                                disabled={save.isPending}
                                onValueChange={() => form.set('enabled', toggleIn(enabled, tool.id, order))}
                            />
                        ))}
                    </Group>
                    <NcExceptionsGroup groups={groups.data} onOpen={setOpenGroupId} />
                    <NcGroupSheet
                        group={openGroup}
                        catalog={data.catalog}
                        orgEnabled={data.enabled}
                        onToggle={onToggleGroup}
                        onClose={() => setOpenGroupId(null)}
                    />
                </>
            )}
        </OrgSettingsFrame>
    );
}
