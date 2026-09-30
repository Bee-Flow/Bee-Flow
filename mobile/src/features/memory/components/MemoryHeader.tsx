/**
 * Two headers, because selection mode IS a different mode: the back button
 * becomes a cancel, the title becomes a count, and the destructive action
 * changes meaning. `showBack={false}` with an explicit leading is how a screen
 * says "this bar is not a place you navigate back from".
 */

import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, ScreenHeader } from '@/shared/ui';

export function MemoryHeader({
    selectedCount,
    total,
    onCancelSelection,
    onForgetSelected,
    onForgetEverything,
}: {
    selectedCount: number;
    total: number;
    onCancelSelection: () => void;
    onForgetSelected: () => void;
    onForgetEverything: () => void;
}) {
    const theme = useTheme();

    if (selectedCount > 0) {
        return (
            <ScreenHeader
                size="large"
                showBack={false}
                global={false}
                leading={
                    <IconButton
                        icon={<Icon name="X" size={20} color={theme.colors.textPrimary} />}
                        accessibilityLabel="Cancel selection"
                        onPress={onCancelSelection}
                    />
                }
                title={`${selectedCount} selected`}
                actions={
                    <IconButton
                        icon={<Icon name="Trash2" size={20} color={theme.colors.error} />}
                        accessibilityLabel={`Forget ${selectedCount} selected`}
                        tone="danger"
                        onPress={onForgetSelected}
                    />
                }
            />
        );
    }

    return (
        <ScreenHeader
            title="Memory"
            subtitle={total === 0 ? 'Nothing remembered yet' : `${total} thing${total === 1 ? '' : 's'} remembered about you`}
            actions={
                total > 0 ? (
                    <IconButton
                        icon={<Icon name="Trash2" size={20} color={theme.colors.error} />}
                        accessibilityLabel="Forget everything"
                        tone="danger"
                        onPress={onForgetEverything}
                    />
                ) : null
            }
        />
    );
}
