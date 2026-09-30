/** A hub section with nothing in it yet: what it is for, and a real button to start. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        box: { padding: theme.spacing.lg, gap: theme.spacing.xs },
        action: { alignItems: 'flex-start', marginTop: theme.spacing.xs },
    });

export function HubSectionEmpty({
    title,
    message,
    actionLabel,
    onAction,
}: {
    title: string;
    message: string;
    actionLabel?: string;
    onAction?: () => void;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.box}>
            <Text variant="caption" weight="medium">
                {title}
            </Text>
            <Text variant="caption" tone="tertiary">
                {message}
            </Text>
            {actionLabel && onAction ? (
                // A real button, not a caption-sized text link: a call to
                // action in a section that owns the top third of the tab.
                <View style={styles.action}>
                    <Button label={actionLabel} onPress={onAction} variant="secondary" />
                </View>
            ) : null}
        </View>
    );
}
