/**
 * A placeholder shaped like the list it is standing in for: avatar-sized
 * squares beside two Skeleton bars per row. Static, like Skeleton.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';

import { Skeleton } from './Skeleton';

export function ListSkeleton({ rows = 6 }: { /** How many placeholder rows. */ rows?: number }) {
    const theme = useTheme();
    const t = useTranslation();
    return (
        <View
            accessibilityLabel={t('mobile.ui.loading', 'Loading')}
            style={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}
        >
            {Array.from({ length: rows }, (_, i) => (
                <View key={i} style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                    <Skeleton width={40} height={40} radius={theme.radii.md} />
                    <View style={{ flex: 1, gap: theme.spacing.sm, justifyContent: 'center' }}>
                        <Skeleton width={i % 3 === 0 ? '55%' : '75%'} height={14} />
                        <Skeleton width="40%" height={11} />
                    </View>
                </View>
            ))}
        </View>
    );
}
