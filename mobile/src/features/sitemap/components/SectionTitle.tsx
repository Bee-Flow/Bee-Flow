/** A small caps-style label above a section of the map. */

import React from 'react';
import { StyleSheet } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

export function SectionTitle({ title, inset = false }: { title: string; inset?: boolean }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <Text variant="label" tone="tertiary" style={[styles.title, inset && styles.inset]}>
            {title}
        </Text>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        title: {
            paddingTop: theme.spacing.lg,
            paddingBottom: theme.spacing.xs,
            paddingHorizontal: theme.spacing.xs,
        },
        // A list that bleeds to the screen edge lines its headers up with the rows.
        inset: { paddingHorizontal: theme.spacing.lg },
    });
