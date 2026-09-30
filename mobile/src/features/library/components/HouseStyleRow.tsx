/** One house style: the default says so; any other offers to become it. */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, ListRow, Text } from '@/shared/ui';

import type { HouseStyle } from '../model/types';

export function HouseStyleRow({
    style,
    busy,
    onMakeDefault,
}: {
    style: HouseStyle;
    busy: boolean;
    onMakeDefault: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    return (
        <ListRow
            title={style.name}
            subtitle={style.description || t('mobile.library.house_style_added', 'Added {when}', { when: timeAgo(style.createdAt, { suffix: true }) })}
            wrapTitle
            leading={
                <Icon
                    name="Type"
                    size={20}
                    color={style.isDefault ? theme.colors.accentPrimary : theme.colors.textMuted}
                />
            }
            trailing={
                style.isDefault ? (
                    <Badge label="Default" tone="accent" />
                ) : (
                    <Text variant="label" tone="accent">
                        Make default
                    </Text>
                )
            }
            onPress={style.isDefault ? undefined : onMakeDefault}
            disabled={busy}
        />
    );
}
