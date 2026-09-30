/**
 * The "+ Add …" under an editable list of rows (a rule, a stage, a question,
 * a table tool — see RowCard).
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/shared/ui';

export function AddButton({ label, onPress, disabled = false, testID }: { label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
    return (
        <View style={styles.add}>
            <Button size="sm" variant="ghost" iconName="Plus" label={label} onPress={onPress} disabled={disabled} testID={testID} />
        </View>
    );
}

const styles = StyleSheet.create({
    add: { flexDirection: 'row' },
});
