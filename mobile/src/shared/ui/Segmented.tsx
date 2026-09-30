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
 * The shape is the web's SegmentedControl (shared/SegmentedControl.tsx): a
 * bgTertiary track with a 12 radius and a subtle edge, segments with an 8
 * radius, and the active one on bgCard with an inset default-border ring.
 * Inactive segments are transparent rather than tinted, so the control reads
 * as one object with a highlight moving inside it — and their words are
 * textSecondary, not tertiary, because they are still choices on offer.
 *
 * A segment may carry a `count` (the Studio strips' "Used by 3"): the same
 * size as the label, only dimmer, or in the error/warning colour. A nullish
 * count renders nothing rather than a 0.
 */

import React, { type ReactNode } from 'react';
import { Pressable, Text as RNText, View, type TextStyle, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Text } from './Text';

export type SegmentedCountTone = 'neutral' | 'error' | 'warning';

export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
    icon?: ReactNode;
    /** A dot on the segment — "something is happening in here". */
    badge?: boolean;
    /** A count after the label. Nullish renders nothing. */
    count?: number | null;
    countTone?: SegmentedCountTone;
    disabled?: boolean;
}

export function Segmented<T extends string>({
    options,
    value,
    onChange,
    accessibilityLabel,
    fullWidth = false,
    iconOnly = false,
}: {
    options: SegmentedOption<T>[];
    value: T;
    onChange: (next: T) => void;
    accessibilityLabel?: string;
    /** Equal-width segments across the row instead of their natural width. */
    fullWidth?: boolean;
    /**
     * Icons without their words, for a toolbar short of room: every option
     * then needs an icon, and its label is what a screen reader says.
     */
    iconOnly?: boolean;
}) {
    const styles = useThemedStyles(makeStyles);

    return (
        <View
            accessibilityRole="tablist"
            accessibilityLabel={accessibilityLabel}
            style={styles.track}
        >
            {options.map((option) => {
                const selected = option.value === value;
                const hasCount = option.count !== undefined && option.count !== null;
                return (
                    <Pressable
                        key={option.value}
                        onPress={() => onChange(option.value)}
                        disabled={option.disabled}
                        accessibilityRole="tab"
                        accessibilityState={{ selected, disabled: option.disabled }}
                        accessibilityLabel={hasCount ? `${option.label}, ${option.count}` : option.label}
                        // 36 + 12 clears the 48dp minimum without a fat header.
                        hitSlop={styles.hitSlop}
                        style={[
                            styles.segment,
                            iconOnly ? styles.segmentIcon : null,
                            fullWidth ? styles.segmentFull : null,
                            selected ? styles.active : null,
                            option.disabled ? styles.disabled : null,
                        ]}
                    >
                        {option.icon}
                        {iconOnly ? null : (
                            <Text
                                variant="caption"
                                weight={selected ? 'semibold' : 'medium'}
                                tone={selected ? 'primary' : 'secondary'}
                                numberOfLines={1}
                            >
                                {option.label}
                                {hasCount ? (
                                    <RNText style={styles.count[option.countTone ?? 'neutral']}>{` ${option.count}`}</RNText>
                                ) : null}
                            </Text>
                        )}
                        {option.badge ? <View accessibilityElementsHidden style={styles.dot} /> : null}
                    </Pressable>
                );
            })}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    track: {
        flexDirection: 'row',
        gap: theme.spacing[1],
        padding: theme.spacing[1],
        borderRadius: theme.radii.md,
        backgroundColor: theme.colors.bgTertiary,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        maxWidth: '100%',
    } satisfies ViewStyle,
    segment: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing[1.5],
        height: 36,
        paddingHorizontal: theme.spacing[3.5],
        borderRadius: theme.radii.sm,
        // Squeezed rather than spilling out of the track when a row is short
        // of room: the label truncates instead.
        flexShrink: 1,
        minWidth: 0,
    } satisfies ViewStyle,
    segmentIcon: { width: 44, paddingHorizontal: 0 } satisfies ViewStyle,
    segmentFull: { flex: 1 } satisfies ViewStyle,
    active: {
        backgroundColor: theme.colors.bgCard,
        boxShadow: `0 1px 2px rgba(0, 0, 0, 0.06), inset 0 0 0 1px ${theme.colors.borderDefault}`,
    } satisfies ViewStyle,
    disabled: { opacity: 0.5 } satisfies ViewStyle,
    hitSlop: { top: 6, bottom: 6, left: 0, right: 0 },
    count: {
        neutral: { color: theme.colors.textTertiary, fontVariant: ['tabular-nums'] },
        error: { color: theme.colors.errorInk, fontVariant: ['tabular-nums'] },
        warning: { color: theme.colors.warningInk, fontVariant: ['tabular-nums'] },
    } satisfies Record<SegmentedCountTone, TextStyle>,
    dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.accentText,
    } satisfies ViewStyle,
});
