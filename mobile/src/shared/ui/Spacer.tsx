/** Vertical rhythm without every caller inventing its own margin. */

import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

export function Spacer({ size = 'lg' }: { size?: keyof ReturnType<typeof useTheme>['spacing'] }) {
    const theme = useTheme();
    return <View style={{ height: theme.spacing[size] }} />;
}
