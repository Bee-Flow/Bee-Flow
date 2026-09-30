/** Grant "Modify n8n Workflows" to an existing group: the org's groups that do not hold it yet. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ListRow, Sheet } from '@/shared/ui';

import type { N8nGroup } from '../model/n8nTypes';

export function N8nGroupPickerSheet({
    visible,
    groups,
    onPick,
    onClose,
}: {
    visible: boolean;
    groups: readonly N8nGroup[];
    onPick: (group: N8nGroup) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    return (
        <Sheet visible={visible} onClose={onClose} title={t('mobile.orgIntegrations.n8n_pick_group', 'Select a group to grant…')}>
            {groups.map((group) => (
                <ListRow
                    key={group.id}
                    testID={`n8n-pick-${group.id}`}
                    title={group.name}
                    subtitle={[
                        t('mobile.orgIntegrations.members', '{n} members', { n: group.userCount }),
                        group.isGlobal ? t('mobile.orgIntegrations.n8n_global', 'global') : null,
                    ]
                        .filter(Boolean)
                        .join(' · ')}
                    onPress={() => onPick(group)}
                />
            ))}
        </Sheet>
    );
}
