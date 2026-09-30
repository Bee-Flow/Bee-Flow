/**
 * A notebook's header actions: add a source, and a menu with what the web's
 * card menu offers (NotebookCard.jsx) — pin, rename, delete.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { ActionMenu, Icon, IconButton } from '@/shared/ui';

import { useSetNotebookPinned } from '../hooks/mutations';
import { useCachedPinned } from '../hooks/queries';

export function NotebookHeaderActions({
    notebookId,
    name,
    onAdd,
    onRename,
    onDelete,
}: {
    notebookId: string;
    /** Null until the notebook has loaded; the menu waits for it. */
    name: string | null;
    onAdd: () => void;
    onRename: () => void;
    onDelete: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const [menuOpen, setMenuOpen] = useState(false);
    // This header does not subscribe to the list query the pin is read from,
    // so a successful toggle is reflected here rather than by a re-render
    // that may never come.
    const [pinnedOverride, setPinnedOverride] = useState<boolean | null>(null);
    const cachedPinned = useCachedPinned(notebookId);
    const pinned = pinnedOverride ?? cachedPinned;
    const pin = useSetNotebookPinned(notebookId, { onSuccess: (_result, next) => setPinnedOverride(next) });

    return (
        <>
            <IconButton
                icon={<Icon name="Plus" size={20} color={theme.colors.textPrimary} />}
                accessibilityLabel={t('notebooks.add_source', 'Add Source')}
                onPress={onAdd}
            />
            <IconButton
                icon={<Icon name="EllipsisVertical" size={20} color={theme.colors.textSecondary} />}
                accessibilityLabel={t('notebooks.card_menu', 'Notebook actions')}
                disabled={name === null}
                onPress={() => setMenuOpen(true)}
            />
            <ActionMenu
                visible={menuOpen}
                onClose={() => setMenuOpen(false)}
                title={name ?? undefined}
                items={[
                    {
                        id: 'pin',
                        label: pinned ? t('notebooks.unpin', 'Unpin') : t('notebooks.pin', 'Pin'),
                        icon: 'Bookmark',
                        disabled: pin.isPending,
                        onPress: () => pin.mutate(!pinned),
                    },
                    { id: 'rename', label: t('notebooks.rename', 'Rename'), icon: 'PenLine', onPress: onRename },
                    { id: 'delete', label: t('notebooks.delete', 'Delete'), icon: 'Trash2', destructive: true, onPress: onDelete },
                ]}
            />
        </>
    );
}
