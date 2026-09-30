/**
 * "Specific groups": tick the groups that may read the table. Nothing is sent
 * until Apply, and applying with none ticked makes the table private again —
 * never "the whole organisation", which is what an empty list on a published
 * table would mean.
 */

import React, { useCallback, useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { Button, Sheet, Text } from '@/shared/ui';

import { DirectoryList } from './DirectoryList';
import type { Directory } from '../model/types';

export function GroupPickerSheet({
    directory,
    current,
    onApply,
    onClose,
}: {
    directory: Directory | undefined;
    current: readonly string[];
    onApply: (ids: string[]) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(current));
    const isSelected = useCallback((id: string) => picked.has(id), [picked]);
    const onToggle = useCallback(
        (id: string) =>
            setPicked((cur) => {
                const next = new Set(cur);
                if (!next.delete(id)) next.add(id);
                return next;
            }),
        [],
    );
    // A group already shared with but not in the directory (no directory permission) stays pickable by id.
    const known = new Set((directory?.groups ?? []).map((g) => g.id));
    const entries = [...(directory?.groups ?? []), ...current.filter((id) => !known.has(id)).map((id) => ({ id, name: id }))];

    return (
        <Sheet
            visible
            scroll={false}
            onClose={onClose}
            title={t('datatables.share_groups', 'Specific groups')}
            subtitle={t('datatables.share_groups_desc', 'Only members of the groups you pick.')}
            footer={<Button fullWidth size="lg" label={t('datatables.filter_apply', 'Apply')} onPress={() => onApply([...picked])} testID="groups-apply" />}
        >
            {directory && !directory.available ? (
                <Text variant="caption" tone="tertiary">
                    {t('datatables.share_no_directory', 'You cannot see the organisation’s group list, so the groups are shown by id.')}
                </Text>
            ) : null}
            <DirectoryList
                entries={entries}
                isSelected={isSelected}
                onToggle={onToggle}
                emptyText={directory ? t('mobile.datatables.no_groups', 'There are no groups to pick.') : t('datatables.loading_groups', 'Loading groups…')}
            />
        </Sheet>
    );
}
