/**
 * The kind tile: a Studio object's glyph on a tint of its kind colour, in the
 * kind's shape — the web's `kindTileStyle` (shared/kindColors.js). 28dp in an
 * object header, 30 in a legend, 36/48 on cards and empty states. The shape
 * says the kind a second time for anyone who cannot rely on colour: an
 * automation is trigger-shaped, a form is a circle.
 *
 * Decorative: the row or header around it names the object, so the tile is
 * hidden from a screen reader.
 */

import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

import { Icon, isIconName, type IconName } from './icons/Icon';
import { kindColor, kindOf, KIND_ICON, tileMetrics, type KindInput } from './kinds';
import { tint } from './tint';

export interface KindTileProps {
    /** A kind key, an alias ('kb', 'table', 'automations') or an object carrying one. */
    kind: KindInput;
    /** Edge in dp. Default 28, the object header's tile. */
    size?: number;
    /** Overrides the kind's glyph (a stored `app.icon`, say). Unknown names fall back to the kind's. */
    icon?: IconName | string | null;
    /** Overrides the tint percentage (18 at 28dp and under, 16 above). */
    tintPercent?: number;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

export function KindTile({ kind, size = 28, icon, tintPercent, style, testID }: KindTileProps) {
    const theme = useTheme();
    const key = kindOf(kind);
    const colour = kindColor(theme, key);
    const metrics = tileMetrics(key, size, tintPercent);
    const glyph: IconName = icon && isIconName(icon) ? icon : key ? KIND_ICON[key] : 'LayoutGrid';
    const tile: ViewStyle = {
        width: size,
        height: size,
        backgroundColor: tint(colour, metrics.tintPercent),
        borderTopLeftRadius: metrics.radius.topLeft,
        borderTopRightRadius: metrics.radius.topRight,
        borderBottomRightRadius: metrics.radius.bottomRight,
        borderBottomLeftRadius: metrics.radius.bottomLeft,
    };
    return (
        <View
            testID={testID}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.tile, tile, style]}
        >
            <Icon name={glyph} size={metrics.glyph} color={colour} />
        </View>
    );
}

const styles = StyleSheet.create({ tile: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 } });
