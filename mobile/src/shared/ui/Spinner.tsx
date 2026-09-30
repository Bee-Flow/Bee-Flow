/**
 * The app's one activity indicator, painted in the accent so it moves with the
 * theme. LoadingState and every inline "working…" slot use this rather than a
 * bare ActivityIndicator in Android's own colour.
 */

import React from 'react';
import { ActivityIndicator } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

export function Spinner({ size = 'small' }: { size?: 'small' | 'large' }) {
    const theme = useTheme();
    return <ActivityIndicator size={size} color={theme.colors.accentPrimary} />;
}
