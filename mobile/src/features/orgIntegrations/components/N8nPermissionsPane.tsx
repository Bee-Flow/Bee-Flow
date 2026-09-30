/**
 * The n8n Permissions tab (N8nSection.jsx PermissionsTab): who may let the AI
 * create, edit, delete and execute workflows. Running workflows from chat is
 * every member's once n8n is configured; this is about modifying them.
 * Organisation admins always may; groups are granted and revoked here, or a
 * new group is created with the permission in one step.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { FormSheet } from '@/shared/patterns';
import { Badge, Button, Group, Icon, IconButton, ListRow, NoteRow, TextField, useToast } from '@/shared/ui';

import { N8nGroupPickerSheet } from './N8nGroupPickerSheet';
import { useCreateN8nGroup, useSetN8nPermission } from '../hooks/n8nMutations';
import { MODIFY_N8N, type N8nGroup, type N8nPermissions } from '../model/n8nTypes';

export function N8nPermissionsPane({ summary }: { summary: N8nPermissions }) {
    const t = useTranslation();
    const theme = useTheme();
    const { toast } = useToast();
    const grant = useSetN8nPermission();
    const create = useCreateN8nGroup();
    const [picking, setPicking] = useState(false);
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState('');
    const held = new Set(summary.holders.map((g) => g.id));
    const addable = summary.availableGroups.filter((g) => !held.has(g.id));
    const total = summary.holders.length + (summary.orgAdminAlways ? 1 : 0);

    const change = (group: N8nGroup, action: 'add' | 'remove') =>
        grant.mutate(
            { permission: MODIFY_N8N, groupId: group.id, action },
            {
                onSuccess: () =>
                    toast(
                        action === 'add'
                            ? t('mobile.orgIntegrations.n8n_granted', 'Group granted access')
                            : t('mobile.orgIntegrations.n8n_revoked', 'Group access revoked'),
                        'success',
                    ),
                onError: (err) => toast(describeError(err).message, 'error'),
            },
        );
    const onCreate = async () => {
        try {
            await create.mutateAsync({ name: name.trim(), permission: MODIFY_N8N });
            toast(t('mobile.orgIntegrations.n8n_group_created', 'Group "{name}" created and granted access', { name: name.trim() }), 'success');
            setNaming(false);
            setName('');
        } catch {
            // The sheet shows the error.
        }
    };

    return (
        <>
            <NoteRow>
                {t(
                    'mobile.orgIntegrations.n8n_perm_intro',
                    'Running n8n workflows from chat works for every member automatically once n8n is configured. This controls modify access — who can let the AI create, edit, delete or execute workflows. Groups can also be edited under Users & Groups.',
                )}
            </NoteRow>
            <Group
                title={t('mobile.orgIntegrations.n8n_modify', 'Modify n8n Workflows')}
                footer={t(
                    'mobile.orgIntegrations.n8n_modify_hint',
                    'Allow the AI to create, edit, delete, activate and execute workflows on behalf of the user. Organisation admins have this by default — grant the same to other groups here.',
                )}
            >
                <ListRow title={t('mobile.orgIntegrations.n8n_grantees', '{n} grantee(s)', { n: total })} />
                {summary.orgAdminAlways ? (
                    <ListRow
                        title={t('mobile.orgIntegrations.n8n_org_admins', 'Organisation Admins')}
                        leading={<Icon name="Crown" size={18} color={theme.colors.warning} />}
                        trailing={<Badge label={t('mobile.orgIntegrations.n8n_always', 'always')} tone="warning" />}
                    />
                ) : null}
                {summary.holders.map((group) => (
                    <ListRow
                        key={group.id}
                        testID={`n8n-holder-${group.id}`}
                        title={group.name}
                        subtitle={t('mobile.orgIntegrations.members', '{n} members', { n: group.userCount })}
                        trailing={
                            <IconButton
                                icon={<Icon name="X" size={18} color={theme.colors.textTertiary} />}
                                accessibilityLabel={t('mobile.orgIntegrations.n8n_revoke', 'Revoke permission')}
                                disabled={grant.isPending}
                                onPress={() => change(group, 'remove')}
                            />
                        }
                    />
                ))}
                {summary.holders.length === 0 && !summary.orgAdminAlways ? (
                    <NoteRow>{t('mobile.orgIntegrations.n8n_no_holders', 'No groups currently hold this permission.')}</NoteRow>
                ) : null}
            </Group>
            {addable.length > 0 ? (
                <Button label={t('mobile.orgIntegrations.n8n_add_group', 'Add existing group')} variant="secondary" iconName="Plus" onPress={() => setPicking(true)} />
            ) : null}
            <Button label={t('mobile.orgIntegrations.n8n_create_group', 'Create new group')} variant="secondary" iconName="Plus" onPress={() => setNaming(true)} />
            <N8nGroupPickerSheet
                visible={picking}
                groups={addable}
                onPick={(group) => {
                    setPicking(false);
                    change(group, 'add');
                }}
                onClose={() => setPicking(false)}
            />
            <FormSheet
                visible={naming}
                onClose={() => setNaming(false)}
                title={t('mobile.orgIntegrations.n8n_create_group', 'Create new group')}
                submitLabel={t('mobile.orgIntegrations.n8n_create_grant', 'Create & grant')}
                onSubmit={() => void onCreate()}
                submitting={create.isPending}
                canSubmit={name.trim().length > 0}
                error={create.error}
            >
                <TextField
                    testID="n8n-new-group"
                    placeholder={t('mobile.orgIntegrations.n8n_group_name', 'New group name…')}
                    value={name}
                    onChangeText={setName}
                />
            </FormSheet>
        </>
    );
}
