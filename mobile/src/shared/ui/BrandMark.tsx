/**
 * The Bee Flow bee, drawn straight onto whatever surface it sits on.
 *
 * The app icon (assets/icon.png) is the bee on its own near-black square,
 * which is right on a launcher and wrong inside the app: on the Day theme it
 * was a heavy black tile, on Night a black tile on a near-black drawer. So
 * the app draws the bee without a field, in two inks: white on a dark theme,
 * the light theme's `--text-primary` (#0f172a) on a light one. Both keep the
 * yellow stripes. Both were cut from the earlier assets/adaptive-icon.png (the
 * bee on transparency, before the launcher moved to ink on yellow), cropped
 * to the bee and scaled to 192px.
 */

import { Image } from 'expo-image';
import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';

const MARK_ON_LIGHT = require('../../../assets/bee-mark-ink.png');
const MARK_ON_DARK = require('../../../assets/bee-mark.png');

/** A product name, not a sentence: the same in every language. */
const BRAND = 'Bee Flow';

/** The file for a theme: white ink on a dark ground, dark ink on a light one. */
export function brandMarkSource(dark: boolean): number {
    return dark ? MARK_ON_DARK : MARK_ON_LIGHT;
}

export function BrandMark({
    size = 40,
    decorative = false,
}: {
    size?: number;
    /** True where a title next to it already says "Bee Flow" to a screen reader. */
    decorative?: boolean;
}) {
    const theme = useTheme();
    return (
        <Image
            source={brandMarkSource(theme.dark)}
            accessibilityLabel={decorative ? undefined : BRAND}
            accessibilityElementsHidden={decorative}
            importantForAccessibility={decorative ? 'no-hide-descendants' : 'auto'}
            contentFit="contain"
            style={sizes(size)}
            testID="brand-mark"
        />
    );
}

/** A square of `size`, cached so each size is one object, not one per render. */
const sizeCache = new Map<number, { width: number; height: number }>();
function sizes(size: number): { width: number; height: number } {
    let hit = sizeCache.get(size);
    if (!hit) {
        hit = { width: size, height: size };
        sizeCache.set(size, hit);
    }
    return hit;
}

