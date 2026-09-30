/** One small action under an answer: copy, or a thumb. */

import React from 'react';
import { Pressable } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, type IconName } from '@/shared/ui';

/**
 * A 15px glyph with the standard 8px slop is a 31px target — well under the
 * 48px this app holds itself to. The vertical axis is free (nothing sits above
 * or below the row), so it takes most of the growth; horizontally each target
 * stops short of half the 24px gap so two never overlap.
 */
const HIT_SLOP = { top: 16, bottom: 16, left: 11, right: 11 };

export function MessageAction({
    icon,
    label,
    onPress,
    color,
    selected,
}: {
    icon: IconName;
    label: string;
    onPress: () => void;
    color?: string;
    /** Renders as a toggle to a screen reader rather than a plain button. */
    selected?: boolean;
}) {
    const theme = useTheme();
    return (
        <Pressable
            onPress={onPress}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={selected === undefined ? undefined : { selected }}
        >
            <Icon name={icon} size={15} color={color ?? theme.colors.textMuted} />
        </Pressable>
    );
}
