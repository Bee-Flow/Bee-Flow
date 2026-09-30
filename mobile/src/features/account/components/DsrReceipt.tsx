/**
 * The filed request's reference number — the only thing the requester can
 * quote later, so it is shown in place of the form rather than toasted away.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Text } from '@/shared/ui';

export function DsrReceipt({ reference }: { reference: number }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.body}>
            <Banner tone="success" icon="CircleCheckBig">
                Your request has been recorded. Bee Flow will respond within thirty days, as
                the GDPR requires.
            </Banner>
            <Text variant="body">
                Your reference number is{' '}
                <Text variant="body" weight="semibold" selectable>
                    #{reference}
                </Text>
                . Quote it if you need to follow up.
            </Text>
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.md },
    });
