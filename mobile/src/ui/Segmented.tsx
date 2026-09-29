/**
 * An exclusive mode switch — pick one of two or three.
 *
 * The app had no such primitive. Screens that needed one faked it with `Chip`
 * (`app/agents/index.tsx`, `app/tasks/index.tsx`), which is a MULTI-select
 * control: it announces itself to TalkBack as a button rather than a tab, and
 * visually it says "any number of these can be on" when exactly one can. The
 * web has had a real one all along — `agent-hub/src/components/cowork/
 * CoworkModeSwitch.jsx` — and it is the element in the centre of the owner's
 * web screenshot.
 *
 * The active segment is a raised white pill on a recessed track, which is the
 * shape both the web app and Android's own material switches use. Inactive
 * segments are transparent rather than tinted, so the control reads as one
 * object with a highlight moving inside it, not as two competing buttons.
 */

import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from './Text';
import { useTheme } from '../theme/ThemeProvider';

export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
    icon?: ReactNode;
    /** A dot on the segment — "something is happening in here". */
    badge?: boolean;
}

export function Segmented<T extends string>({
    options,
    value,
    onChange,
    accessibilityLabel,
}: {
    options: SegmentedOption<T>[];
    value: T;
    onChange: (next: T) => void;
    accessibilityLabel?: string;
}) {
    const theme = useTheme();

    return (
        <View
            accessibilityRole="tablist"
            accessibilityLabel={accessibilityLabel}
            style={{
                flexDirection: 'row',
                padding: 3,
                borderRadius: theme.radii.pill,
                backgroundColor: theme.colors.bgSecondary,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.borderSubtle,
            }}
        >
            {options.map((option) => {
                const selected = option.value === value;
                return (
                    <Pressable
                        key={option.value}
                        onPress={() => onChange(option.value)}
                        accessibilityRole="tab"
                        accessibilityState={{ selected }}
                        accessibilityLabel={option.label}
                        // 34 + 16 clears the 48dp minimum without a fat header.
                        hitSlop={theme.hitSlop}
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 6,
                            height: 34,
                            paddingHorizontal: 14,
                            borderRadius: theme.radii.pill,
                            backgroundColor: selected ? theme.colors.bgCard : 'transparent',
                            ...(selected ? theme.elevation.card : null),
                        }}
                    >
                        {option.icon}
                        <Text
                            variant="caption"
                            weight={selected ? 'semibold' : 'regular'}
                            tone={selected ? 'primary' : 'tertiary'}
                        >
                            {option.label}
                        </Text>
                        {option.badge ? (
                            <View
                                accessibilityElementsHidden
                                style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 3,
                                    backgroundColor: theme.colors.accentText,
                                }}
                            />
                        ) : null}
                    </Pressable>
                );
            })}
        </View>
    );
}
