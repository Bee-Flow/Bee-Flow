/**
 * The filed request's reference number — the only thing the requester can
 * quote later, so it is shown in place of the form rather than toasted away.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Text } from '@/shared/ui';

export function DsrReceipt({ reference }: { reference: number }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    // The number sits inside the sentence, in bold; a translation may move it, so the
    // sentence is split on its placeholder rather than assembled from three pieces.
    const [before = '', after = ''] = t(
        'mobile.account.dsr_reference',
        'Your reference number is {reference}. Quote it if you need to follow up.',
    ).split('{reference}');
    return (
        <View style={styles.body}>
            <Banner tone="success" icon="CircleCheckBig">
                {t(
                    'mobile.account.dsr_recorded',
                    'Your request has been recorded. Bee Flow will respond within thirty days, as the GDPR requires.',
                )}
            </Banner>
            <Text variant="body">
                {before}
                <Text variant="body" weight="semibold" selectable>
                    #{reference}
                </Text>
                {after}
            </Text>
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.md },
    });
