/**
 * The two brand glyphs lucide-react-native dropped in 1.0 (trademarks), kept
 * with the exact path data of release 0.562 (ISC licence, https://lucide.dev),
 * so a stored `app.icon: 'Github'` and the settings rows that name it keep
 * drawing the same glyph. The web keeps the same two the same way
 * (agent-hub/src/components/icons/brandIcons.ts), which is why they stay in its
 * ICON_REGISTRY.
 *
 * Drawn with react-native-svg directly rather than Lucide's `createLucideIcon`:
 * that factory lives in the package barrel, and importing the barrel bundles
 * all ~1,700 icons (registry.generated.ts explains why that is off the table).
 * They take the props <Icon> passes: size, color, strokeWidth.
 */
import type { LucideIcon } from 'lucide-react-native';
import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

interface BrandProps {
    size?: number | string;
    color?: string;
    strokeWidth?: number | string;
}

function brand(displayName: string, children: React.ReactNode): LucideIcon {
    function BrandIcon({ size = 24, color = 'currentColor', strokeWidth = 2 }: BrandProps) {
        return (
            <Svg
                width={size}
                height={size}
                viewBox="0 0 24 24"
                fill="none"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                {children}
            </Svg>
        );
    }
    BrandIcon.displayName = displayName;
    return BrandIcon as unknown as LucideIcon;
}

export const Github = brand(
    'Github',
    <>
        <Path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
        <Path d="M9 18c-4.51 2-5-2-7-2" />
    </>,
);

export const Linkedin = brand(
    'Linkedin',
    <>
        <Path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
        <Rect width="4" height="12" x="2" y="9" />
        <Circle cx="4" cy="4" r="2" />
    </>,
);
