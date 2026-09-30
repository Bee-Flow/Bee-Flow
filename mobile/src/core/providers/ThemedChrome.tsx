/** Status bar and window background follow the theme, not the OS setting. */

import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import React, { useEffect } from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';

export function ThemedChrome() {
    const theme = useTheme();
    useEffect(() => {
        void SystemUI.setBackgroundColorAsync(theme.colors.bgPrimary);
    }, [theme]);
    return <StatusBar style={theme.dark ? 'light' : 'dark'} />;
}
