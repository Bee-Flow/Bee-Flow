/** A hairline between rows, optionally inset from the leading edge. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

export function Divider({ inset = 0 }: { /** Leading inset in dp, to line up with row text. */ inset?: number }) {
    const theme = useTheme();
    return (
        <View
            style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: theme.colors.borderSubtle,
                marginLeft: inset,
            }}
        />
    );
}
