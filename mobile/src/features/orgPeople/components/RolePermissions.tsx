/**
 * The web's RolePermissionEditor, as two groups: "What this role may use" —
 * the switches the organisation owns (only ids from `editablePermissions`,
 * so no switch can silently revert) — and "Fixed by this role", read-only.
 * The draft is saved whole, not as a delta, from the SaveBar.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, ListRow, NoteRow, ToggleRow } from '@/shared/ui';

import { permissionCopy } from '../model/roles';

export function EditablePermissions({
    rows,
    granted,
    disabled,
    onToggle,
}: {
    rows: { id: string }[];
    granted: readonly string[];
    disabled: boolean;
    onToggle: (id: string) => void;
}) {
    const t = useTranslation();
    if (rows.length === 0) return null;
    return (
        <Group title={t('admin.org_roles_editable', 'What this role may use')}>
            {rows.map(({ id }) => {
                const copy = permissionCopy(id, t);
                return (
                    <ToggleRow
                        key={id}
                        testID={`perm-${id}`}
                        label={copy.label}
                        description={copy.description || undefined}
                        value={granted.includes(id)}
                        disabled={disabled}
                        onValueChange={() => onToggle(id)}
                    />
                );
            })}
        </Group>
    );
}

export function FixedPermissions({ ids, withEditor }: { ids: readonly string[]; withEditor: boolean }) {
    const t = useTranslation();
    const theme = useTheme();
    if (withEditor && ids.length === 0) return null;
    return (
        <Group
            title={
                withEditor
                    ? t('admin.org_roles_fixed', 'Fixed by this role')
                    : t('admin.org_roles_permissions', 'Permissions')
            }
        >
            {ids.length === 0 ? (
                <NoteRow>{t('admin.org_roles_none', 'No permissions could be read for this role.')}</NoteRow>
            ) : (
                ids.map((id) => {
                    const copy = permissionCopy(id, t);
                    return (
                        <ListRow
                            key={id}
                            testID={`fixed-${id}`}
                            title={copy.label}
                            subtitle={copy.description || undefined}
                            leading={<Icon name="Check" size={16} color={theme.colors.accentPrimary} />}
                            chevron={false}
                        />
                    );
                })
            )}
        </Group>
    );
}
