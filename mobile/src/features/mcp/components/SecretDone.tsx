/** Done — the only way out of the secret sheet, disabled until both acts are done. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => StyleSheet.create({ box: { gap: theme.spacing.sm } });

function hintFor(taken: boolean, acknowledged: boolean): string | undefined {
    if (!taken) return 'Copy or share the token first';
    return acknowledged ? undefined : 'Confirm that you have saved it';
}

export function SecretDone({
    taken,
    acknowledged,
    onDone,
}: {
    taken: boolean;
    acknowledged: boolean;
    onDone: () => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const ready = taken && acknowledged;

    return (
        <View style={styles.box}>
            <Button
                label="Done"
                onPress={onDone}
                size="lg"
                fullWidth
                disabled={!ready}
                accessibilityHint={hintFor(taken, acknowledged)}
            />
            {ready ? null : (
                <Text variant="caption" tone="tertiary" center accessibilityLiveRegion="polite">
                    {!taken ? 'Copy or share the token, then tick the box.' : 'Tick the box to confirm you have saved it.'}
                </Text>
            )}
        </View>
    );
}
