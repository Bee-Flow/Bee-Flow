/**
 * The pages captured so far, above the shutter. Tapping one discards it. The
 * strip holds one sitting's shots, so a ScrollView over them is bounded.
 */

import { Image } from 'expo-image';
import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon } from '@/shared/ui';

import { scanStyles as styles } from './scanStyles';

export interface ScanPage {
    uri: string;
    width: number;
    height: number;
}

export function ScanFilmstrip({ pages, onDiscard }: { pages: ScanPage[]; onDiscard: (uri: string) => void }) {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    if (pages.length === 0) return null;

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.filmstrip, { bottom: insets.bottom + 128 }]}
            contentContainerStyle={{ gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg }}
        >
            {pages.map((page, i) => (
                <Pressable
                    key={page.uri}
                    onPress={() => onDiscard(page.uri)}
                    accessibilityRole="button"
                    accessibilityLabel={`Discard page ${i + 1}`}
                >
                    <Image
                        source={{ uri: page.uri }}
                        style={[styles.thumb, { borderRadius: theme.radii.sm }]}
                        contentFit="cover"
                    />
                    <View style={styles.discardBadge}>
                        <Icon name="X" size={11} color="#fff" />
                    </View>
                </Pressable>
            ))}
        </ScrollView>
    );
}
