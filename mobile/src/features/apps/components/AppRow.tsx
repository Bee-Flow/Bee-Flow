/** One Studio app in the list, wearing its author's colour and icon. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { AppIcon, ListRow } from '@/shared/ui';

import type { StudioAppMeta } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        tile: { width: 36, height: 36, borderRadius: theme.radii.md, alignItems: 'center', justifyContent: 'center' },
    });

export function AppRow({ app, onPress }: { app: StudioAppMeta; onPress: () => void }) {
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <ListRow
            title={app.name}
            subtitle={app.description || undefined}
            meta={app.publishedAt ? timeAgo(app.publishedAt) : undefined}
            wrapTitle
            leading={
                // `accentColor` is the app's own brand colour, set by its author;
                // falling back to the surface keeps an unbranded app from
                // looking broken.
                <View style={[styles.tile, { backgroundColor: app.accentColor ?? theme.colors.bgTertiary }]}>
                    <AppIcon name={app.icon} fallback="LayoutGrid" size={16} color={theme.colors.textPrimary} />
                </View>
            }
            onPress={onPress}
        />
    );
}
