/** The bordered row and the bare input TextField and SearchField share. */

import { StyleSheet } from 'react-native';

export const fieldStyles = StyleSheet.create({
    field: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: StyleSheet.hairlineWidth,
    },
    input: { flex: 1, padding: 0 },
});
