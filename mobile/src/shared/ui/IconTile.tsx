/**
 * A glyph centred on a small rounded square, the lead of a navigation row:
 * grey on the tertiary background for a Settings hub row, or a colour on a
 * 15% tint of itself for an organisation section (the web's OrgSubItem).
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Icon, type IconName } from './icons/Icon';
import { tint } from './tint';

export interface IconTileProps {
    name: IconName;
    /** The glyph's colour, over a 15% tint of it. Default: secondary text on the tertiary background. */
    color?: string;
}

export function IconTile({ name, color }: IconTileProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const fill = { backgroundColor: color ? tint(color, 15) : theme.colors.bgTertiary };
    return (
        <View style={[styles.tile, fill]}>
            <Icon name={name} size={15} color={color ?? theme.colors.textSecondary} />
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        tile: {
            width: 30,
            height: 30,
            borderRadius: theme.radii.sm,
            alignItems: 'center',
            justifyContent: 'center',
        },
    });
