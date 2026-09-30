/**
 * An icon somebody chose — `app.icon`, `project.icon`, a webpage's or an MCP
 * server's — drawn the way the web's AppIcon.jsx draws it.
 *
 * Those fields are free text written by the web app's pickers: a Lucide name
 * ("LayoutGrid") from the icon picker, or an emoji ("📁") where the web offers
 * an emoji. Rendering the field as text showed a web-made app's icon as the
 * literal word "LayoutGrid". So:
 *
 *   - a registry name draws that icon (kebab-case is accepted too);
 *   - anything with an emoji or other non-ASCII symbol in it is drawn as text;
 *   - an empty or unknown name draws `fallback` — the web's own default for
 *     that field where it has one ('LayoutGrid' for apps), else its
 *     FALLBACK_ICON. The web could still lazy-load an unregistered Lucide name;
 *     the phone ships only the registry, so such a name draws the fallback.
 *
 * Org icon packs (the web's `/api/icons` overrides) are not applied here yet.
 */

import React from 'react';
import { StyleSheet, type ColorValue } from 'react-native';

import { Text } from '../Text';
import { Icon, isIconName, type IconName } from './Icon';
import { WEB_FALLBACK_ICON } from './registry.generated';

export type AppIconChoice = { kind: 'icon'; name: IconName } | { kind: 'text'; text: string };

/** Printable ASCII only: an icon name, never an emoji. */
const ASCII = /^[\x20-\x7e]*$/;

/** 'layout-grid' / 'layout_grid' / 'layout grid' → 'LayoutGrid'. */
function pascalCase(value: string): string {
    return value
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join('');
}

/** What a stored icon value draws. Pure, so the rules are testable without a renderer. */
export function resolveAppIcon(value: string | null | undefined, fallback: IconName = WEB_FALLBACK_ICON): AppIconChoice {
    const text = (value ?? '').trim();
    if (!text) return { kind: 'icon', name: fallback };
    if (!ASCII.test(text)) return { kind: 'text', text };
    if (isIconName(text)) return { kind: 'icon', name: text };
    const pascal = pascalCase(text);
    return { kind: 'icon', name: isIconName(pascal) ? pascal : fallback };
}

export interface AppIconProps {
    /** The stored value: a Lucide name, an emoji, or nothing. */
    name: string | null | undefined;
    /** Drawn for an empty or unknown name. Pass the web's default for the field. */
    fallback?: IconName;
    size?: number;
    color?: ColorValue;
    strokeWidth?: number;
}

export function AppIcon({ name, fallback, size = 16, color, strokeWidth }: AppIconProps) {
    const choice = resolveAppIcon(name, fallback);
    if (choice.kind === 'icon') return <Icon name={choice.name} size={size} color={color} strokeWidth={strokeWidth} />;
    // An emoji is a picture, not copy: it keeps the icon's size whatever the
    // system font scale, so it stays inside the tile that holds it.
    const box = { fontSize: size, lineHeight: Math.round(size * 1.25) };
    return (
        <Text style={[styles.emoji, box]} allowFontScaling={false} numberOfLines={1} accessibilityElementsHidden>
            {choice.text}
        </Text>
    );
}

const styles = StyleSheet.create({
    emoji: { textAlign: 'center' },
});
