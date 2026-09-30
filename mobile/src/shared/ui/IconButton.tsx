/**
 * A square, icon-only button. Separate component rather than a Button prop
 * because the sizing rules are different: an icon button is square and its
 * label lives in accessibilityLabel, which is not optional.
 *
 * The web's IconButton (shared/IconButton.tsx) is a 24–32px ghost with an 8px
 * radius and a hover tint; on a phone the square is the 48dp touch target and
 * the press state is the web's hover tint (`itemHoverBg`).
 */

import React, { type ReactNode } from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { HIT_SLOP } from '@/core/theme/tokens';

import { tint } from './tint';

export type IconButtonTone = 'default' | 'accent' | 'danger';

export function IconButton({
    icon,
    onPress,
    accessibilityLabel,
    accessibilityHint,
    disabled = false,
    tone = 'default',
    selected,
    style,
    testID,
}: {
    icon: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityHint?: string;
    disabled?: boolean;
    /**
     * `accent` sits on the active-item tint. `danger` rests like the default
     * and presses to the error colour at 10% (the web's `danger` variant,
     * whose rose tint is its hover).
     */
    tone?: IconButtonTone;
    /** For a toggle (a pin, a star): announced as selected and drawn on the active tint. */
    selected?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}) {
    const styles = useThemedStyles(makeStyles);
    const resting = selected || tone === 'accent' ? styles.accent : null;
    const pressedStyle = tone === 'danger' ? styles.pressedDanger : styles.pressed;

    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={accessibilityHint}
            accessibilityState={{ disabled, selected }}
            hitSlop={HIT_SLOP}
            style={({ pressed }) => [
                styles.base,
                resting,
                pressed ? pressedStyle : null,
                disabled ? styles.disabled : null,
                style,
            ]}
        >
            {icon}
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    base: {
        width: theme.minTouch,
        height: theme.minTouch,
        borderRadius: theme.radii.sm,
        alignItems: 'center',
        justifyContent: 'center',
    } satisfies ViewStyle,
    accent: { backgroundColor: theme.colors.itemActiveBg } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    pressedDanger: { backgroundColor: tint(theme.colors.error, 10) } satisfies ViewStyle,
    disabled: { opacity: 0.4 } satisfies ViewStyle,
});
