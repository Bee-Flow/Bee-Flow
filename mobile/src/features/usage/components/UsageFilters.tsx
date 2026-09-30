/** The period chips, and — for someone in an organisation — whose usage to show. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip } from '@/shared/ui';

const RANGES = [7, 30, 90] as const;

export function UsageFilters({
    days,
    onDays,
    inOrg,
    mineOnly,
    onMineOnly,
}: {
    days: number;
    onDays: (days: number) => void;
    /** Someone with no organisation is force-scoped to themselves server-side,
     *  so the scope switch is meaningless for them and is not shown. */
    inOrg: boolean;
    mineOnly: boolean;
    onMineOnly: (mineOnly: boolean) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.filters}>
            <View accessibilityRole="tablist" style={styles.row}>
                {RANGES.map((n) => (
                    <Chip key={n} label={t('mobile.usage.range_days', '{n} days', { n })} selected={days === n} onPress={() => onDays(n)} />
                ))}
            </View>
            {inOrg ? (
                <View style={styles.row}>
                    <Chip label={t('mobile.usage.scope_me', 'Just me')} selected={mineOnly} onPress={() => onMineOnly(true)} />
                    <Chip label={t('mobile.usage.scope_org', 'Whole organisation')} selected={!mineOnly} onPress={() => onMineOnly(false)} />
                </View>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        filters: { gap: theme.spacing.md },
        row: { flexDirection: 'row', gap: theme.spacing.sm },
    });
