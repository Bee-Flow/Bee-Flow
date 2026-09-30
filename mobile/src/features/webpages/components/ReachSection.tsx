/**
 * How a page is doing — counted on external links only (see reachOf). The
 * figures put the value first and the label under it, which is why this is
 * not the kit's Stat (label first, upper-cased).
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Card, Section, Text } from '@/shared/ui';

import type { Reach } from '../model/format';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', gap: theme.spacing.lg },
        figure: { flex: 1, gap: theme.spacing.xxs },
    });

function Figure({ label, value }: { label: string; value: string }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.figure}>
            <Text variant="heading" numberOfLines={1}>
                {value}
            </Text>
            <Text variant="label" tone="tertiary">
                {label}
            </Text>
        </View>
    );
}

export function ReachSection({ reach }: { reach: Reach }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Section
            title={t('mobile.webpages.reach.title', 'Reach')}
            subtitle={t(
                'mobile.webpages.reach.hint',
                'Counted on external links only — visits from inside the app are not tracked',
            )}
        >
            <Card>
                <View style={styles.row}>
                    <Figure label={t('mobile.webpages.reach.views', 'Views')} value={String(reach.views)} />
                    <Figure label={t('mobile.webpages.reach.live', 'Live links')} value={String(reach.live)} />
                    <Figure
                        label={t('mobile.webpages.reach.last', 'Last opened')}
                        value={reach.lastViewedAt ? timeAgo(reach.lastViewedAt) : '—'}
                    />
                </View>
            </Card>
        </Section>
    );
}
