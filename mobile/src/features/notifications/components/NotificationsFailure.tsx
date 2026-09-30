/**
 * A failed write gets a real, re-readable line on the screen. Toasts here only
 * ever confirm — an error that scrolls away after two seconds is an error the
 * user cannot act on.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import type { DescribedError } from '@/core/api/errors';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Icon, IconButton } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ frame: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm } });

export function NotificationsFailure({ failure, onDismiss }: { failure: DescribedError; onDismiss: () => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.frame}>
            <Banner
                tone="error"
                action={
                    <IconButton
                        icon={<Icon name="X" size={16} color={theme.colors.textMuted} />}
                        accessibilityLabel="Dismiss this message"
                        onPress={onDismiss}
                    />
                }
            >
                {`${failure.title}. ${failure.message}`}
            </Banner>
        </View>
    );
}
