/**
 * Delete the routine — after asking what uses it (the app buttons that
 * start it), in the automations feature's guarded delete sheet. Its runs
 * and versions go with it; there is no undo.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { DeleteRoutineSheet } from '@/features/automations';
import { Group, Icon, SettingRow } from '@/shared/ui';

export function DangerGroup({ automation, onDeleted }: { automation: { id: string; title: string } | null; onDeleted: () => void }) {
    const t = useTranslation();
    const [deleting, setDeleting] = useState(false);
    if (!automation) return null;
    return (
        <>
            <Group
                title={t('mobile.flow.settings.danger', 'Danger zone')}
                footer={t('mobile.flow.settings.delete_hint', 'Deleting removes the routine, its runs and its versions. It cannot be undone.')}
            >
                <SettingRow
                    label={t('routines.delete_title', 'Delete routine')}
                    icon={<Icon name="Trash2" size={18} />}
                    destructive
                    onPress={() => setDeleting(true)}
                    testID="settings-delete"
                />
            </Group>
            <DeleteRoutineSheet automation={deleting ? automation : null} onClose={() => setDeleting(false)} onDeleted={onDeleted} />
        </>
    );
}
