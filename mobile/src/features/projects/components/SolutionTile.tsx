/**
 * A Solution's tile: the kind tile of a solution, holding the icon its owner
 * picked. The web draws the stored emoji INSIDE the kind tile (SolutionCard,
 * the catalogue card), and a KindTile only draws Lucide glyphs — so an emoji
 * gets the same tile, shaped and tinted by kinds.ts, with the emoji in it.
 */

import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { AppIcon, KindTile, kindColor, resolveAppIcon, tileMetrics, tint } from '@/shared/ui';

export function SolutionTile({ icon, size = 36 }: { icon: string | null | undefined; size?: number }) {
    const theme = useTheme();
    const choice = resolveAppIcon(icon, 'Package');
    if (choice.kind === 'icon') return <KindTile kind="solution" icon={choice.name} size={size} />;
    const metrics = tileMetrics('solution', size);
    const tile: ViewStyle = {
        width: size,
        height: size,
        backgroundColor: tint(kindColor(theme, 'solution'), metrics.tintPercent),
        borderTopLeftRadius: metrics.radius.topLeft,
        borderTopRightRadius: metrics.radius.topRight,
        borderBottomRightRadius: metrics.radius.bottomRight,
        borderBottomLeftRadius: metrics.radius.bottomLeft,
    };
    return (
        <View style={[styles.tile, tile]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <AppIcon name={icon} size={Math.round(size * 0.5)} />
        </View>
    );
}

const styles = StyleSheet.create({ tile: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 } });
