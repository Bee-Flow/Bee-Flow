/** A skill's icon (one emoji) and name, side by side — creating and renaming share it. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { TextField } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', gap: theme.spacing.md },
        icon: { width: 84 },
        name: { flex: 1 },
    });

export function NameIconFields({
    name,
    icon,
    onName,
    onIcon,
    nameError,
    autoFocus = false,
}: {
    name: string;
    icon: string;
    onName: (name: string) => void;
    onIcon: (icon: string) => void;
    nameError?: string;
    autoFocus?: boolean;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            <TextField
                label={t('mobile.skills.icon', 'Icon')}
                value={icon}
                onChangeText={onIcon}
                placeholder="⚡"
                maxLength={4}
                containerStyle={styles.icon}
            />
            <TextField
                label={t('common.name', 'Name')}
                value={name}
                onChangeText={onName}
                error={nameError}
                autoFocus={autoFocus}
                containerStyle={styles.name}
            />
        </View>
    );
}
