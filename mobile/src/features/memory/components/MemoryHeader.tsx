/**
 * Two headers, because selection mode IS a different mode: the back button
 * becomes a cancel, the title becomes a count, and the destructive action
 * changes meaning. `showBack={false}` with an explicit leading is how a screen
 * says "this bar is not a place you navigate back from".
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { nOf } from '@/shared/lib/plural';
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
    const t = useTranslation();

    if (selectedCount > 0) {
        return (
            <ScreenHeader
                size="large"
                showBack={false}
                global={false}
                leading={
                    <IconButton
                        icon={<Icon name="X" size={20} color={theme.colors.textPrimary} />}
                        accessibilityLabel={t('meetings.cancel_selection', 'Cancel selection')}
                        onPress={onCancelSelection}
                    />
                }
                title={t('knowledge.memory_selected', '{count} selected', { count: selectedCount })}
                actions={
                    <IconButton
                        icon={<Icon name="Trash2" size={20} color={theme.colors.error} />}
                        accessibilityLabel={t('mobile.memory.forget_n_selected', 'Forget {count} selected', { count: selectedCount })}
                        tone="danger"
                        onPress={onForgetSelected}
                    />
                }
            />
        );
    }

    return (
        <ScreenHeader
            title={t('settings.memory_title', 'Memory')}
            subtitle={
                total === 0
                    ? t('mobile.memory.nothing_yet', 'Nothing remembered yet')
                    : nOf(t, 'mobile.memory.remembered_about_you', total, [
                          '{count} thing remembered about you',
                          '{count} things remembered about you',
                      ])
            }
            actions={
                total > 0 ? (
                    <IconButton
                        icon={<Icon name="Trash2" size={20} color={theme.colors.error} />}
                        accessibilityLabel={t('mobile.memory.forget_everything', 'Forget everything')}
                        tone="danger"
                        onPress={onForgetEverything}
                    />
                ) : null
            }
        />
    );
}
