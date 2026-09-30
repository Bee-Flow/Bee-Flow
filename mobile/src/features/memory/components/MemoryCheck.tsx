/** The selection circle a memory row shows in selection mode. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon } from '@/shared/ui';

const styles = StyleSheet.create({
    circle: {
        width: 24,
        height: 24,
        borderRadius: 12,
        marginTop: 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: StyleSheet.hairlineWidth,
    },
});

export function MemoryCheck({ checked }: { checked: boolean }) {
    const theme = useTheme();
    return (
        <View
            style={[
                styles.circle,
                {
                    borderColor: checked ? theme.colors.accentPrimary : theme.colors.borderDefault,
                    backgroundColor: checked ? theme.colors.accentPrimary : 'transparent',
                },
            ]}
        >
            {checked ? <Icon name="Check" size={14} color={theme.colors.accentPrimaryFg} /> : null}
        </View>
    );
}
