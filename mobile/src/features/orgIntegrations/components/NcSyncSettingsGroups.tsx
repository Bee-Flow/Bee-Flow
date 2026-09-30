/**
 * Who Nextcloud Sync mirrors (NextcloudSyncPanel.jsx): the mode, whether new
 * accounts start active or pending, which Nextcloud groups to mirror (in the
 * selective mode) and which never to — even under "mirror everything".
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ChoiceGroup, type Choice } from '@/features/org';
import { Group, NoteRow, ToggleRow } from '@/shared/ui';

import { toggleIn } from '../model/lists';
import { syncModeLabel } from '../model/nextcloud';
import type { NcDefaultStatus, NcSyncMode, NcSyncSettings } from '../model/nextcloudTypes';

export function NcSyncSettingsGroups({
    draft,
    groupNames,
    groupsError,
    disabled,
    onChange,
}: {
    draft: NcSyncSettings;
    groupNames: readonly string[];
    groupsError: string | null;
    disabled: boolean;
    onChange: <K extends keyof NcSyncSettings>(key: K, value: NcSyncSettings[K]) => void;
}) {
    const t = useTranslation();
    const modes: Choice<NcSyncMode>[] = [
        { value: 'mirror_all', label: syncModeLabel('mirror_all', t), description: t('mobile.orgIntegrations.nc_mode_mirror_desc', 'Every Nextcloud user is automatically created in Bee Flow.') },
        { value: 'selective_groups', label: syncModeLabel('selective_groups', t), description: t('mobile.orgIntegrations.nc_mode_selective_desc', 'Only users in the chosen NC groups are mirrored.') },
        { value: 'manual', label: syncModeLabel('manual', t), description: t('mobile.orgIntegrations.nc_mode_manual_desc', 'New NC users are not auto-created — invite manually.') },
    ];
    const statuses: Choice<NcDefaultStatus>[] = [
        { value: 'active', label: t('mobile.orgIntegrations.nc_status_active', 'Active immediately (recommended)') },
        { value: 'pending', label: t('mobile.orgIntegrations.nc_status_pending', 'Pending — admin must approve') },
    ];
    const groupToggles = (key: 'syncGroups' | 'excludedGroups') =>
        groupNames.map((name) => (
            <ToggleRow
                key={name}
                testID={`nc-${key}-${name}`}
                label={name}
                value={draft[key].includes(name)}
                disabled={disabled}
                onValueChange={() => onChange(key, toggleIn(draft[key], name, groupNames))}
            />
        ));
    return (
        <>
            <ChoiceGroup title={t('mobile.orgIntegrations.nc_mode', 'Sync mode')} choices={modes} value={draft.mode} onChange={(mode) => onChange('mode', mode)} disabled={disabled} />
            <ChoiceGroup
                title={t('mobile.orgIntegrations.nc_default_status', 'New user default status')}
                choices={statuses}
                value={draft.newUserDefaultStatus}
                onChange={(status) => onChange('newUserDefaultStatus', status)}
                disabled={disabled}
            />
            {groupsError ? <Group><NoteRow>{groupsError}</NoteRow></Group> : null}
            {draft.mode === 'selective_groups' && groupNames.length > 0 ? (
                <Group title={t('mobile.orgIntegrations.nc_mirror_groups', 'Groups to mirror')} footer={t('mobile.orgIntegrations.nc_mirror_groups_hint', 'Only members of these NC groups are synced.')}>
                    {groupToggles('syncGroups')}
                </Group>
            ) : null}
            {groupNames.length > 0 ? (
                <Group
                    title={t('mobile.orgIntegrations.nc_excluded', 'Excluded groups')}
                    footer={t('mobile.orgIntegrations.nc_excluded_hint', 'Members of these NC groups are NEVER mirrored, even under "mirror everything".')}
                >
                    {groupToggles('excludedGroups')}
                </Group>
            ) : null}
        </>
    );
}
