/**
 * A routine row's own menu: open it, edit its flow, its runs, delete.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ActionMenu } from '@/shared/ui';

import type { Automation } from '../model/types';

export function RoutineRowMenu({
    automation,
    onClose,
    onDelete,
}: {
    /** The row's routine; the menu is open while this is non-null. */
    automation: Automation | null;
    onClose: () => void;
    onDelete: (automation: Automation) => void;
}) {
    const t = useTranslation();
    const router = useRouter();
    const id = automation?.id ?? '';
    return (
        <ActionMenu
            visible={automation !== null}
            onClose={onClose}
            title={automation?.title || t('mobile.automations.untitled', 'Untitled routine')}
            items={[
                { id: 'open', icon: 'SquarePen', label: t('mobile.automations.open', 'Open'), onPress: () => router.push(`/automations/${id}`) },
                { id: 'edit', icon: 'Workflow', label: t('mobile.automations.edit_flow', 'Edit flow'), onPress: () => router.push(`/automations/${id}/build`) },
                { id: 'runs', icon: 'History', label: t('routine_editor.run_history', 'Run history'), onPress: () => router.push(`/automations/${id}/runs`) },
                {
                    id: 'delete', icon: 'Trash2', destructive: true, label: t('common.delete', 'Delete'),
                    onPress: () => automation && onDelete(automation),
                },
            ]}
        />
    );
}
