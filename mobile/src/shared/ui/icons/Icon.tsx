/**
 * One Lucide icon by name — the phone's only icon primitive.
 *
 * The web app draws Lucide throughout, so the phone does too (it used to draw
 * Feather, Lucide's ancestor, whose names and a few shapes differ). Names are
 * Lucide's current PascalCase names; the set lives in registry.generated.ts,
 * produced by scripts/sync-web-icons.mjs.
 *
 * The stroke follows the web's navigation: 1.75 at rest, 2.25 (ACTIVE_STROKE)
 * for the selected item. Lucide has no filled variants, so a heavier stroke is
 * how an icon says "current".
 */

import React from 'react';
import { View, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';

import { ICON_REGISTRY, type IconName } from './registry.generated';

export type { IconName };

/** The web nav's resting stroke. */
export const DEFAULT_STROKE = 1.75;
/** The web nav's stroke for the active or primary item. */
export const ACTIVE_STROKE = 2.25;

export interface IconProps {
    name: IconName;
    /** Edge of the square, in dp. */
    size?: number;
    color?: ColorValue;
    strokeWidth?: number;
    /** Layout around the glyph (a margin, an alignment). */
    style?: StyleProp<ViewStyle>;
    testID?: string;
    /** Hide the glyph from a screen reader when the row already says it in words. */
    accessibilityElementsHidden?: boolean;
}

/** Does the registry hold this name? Narrows free text (a stored `icon`). */
export function isIconName(name: string): name is IconName {
    return Object.prototype.hasOwnProperty.call(ICON_REGISTRY, name);
}

export function Icon({
    name,
    size = 16,
    color,
    strokeWidth = DEFAULT_STROKE,
    style,
    testID,
    accessibilityElementsHidden,
}: IconProps) {
    const Glyph = ICON_REGISTRY[name];
    const glyph = <Glyph size={size} color={color as string | undefined} strokeWidth={strokeWidth} />;
    // Lucide hands every extra prop to each path as well as to the <Svg>, so
    // layout and test props go on a wrapper instead — only when there are any,
    // since most icons need no view of their own.
    if (!style && !testID && !accessibilityElementsHidden) return glyph;
    return (
        <View
            style={style}
            testID={testID}
            accessibilityElementsHidden={accessibilityElementsHidden}
            importantForAccessibility={accessibilityElementsHidden ? 'no-hide-descendants' : undefined}
        >
            {glyph}
        </View>
    );
}
