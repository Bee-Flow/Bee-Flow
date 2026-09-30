/**
 * Underline tabs — the web's Tabs (shared/Tabs.tsx) for a phone: a row of
 * tabs on a subtle bottom border, the active one in primary ink over a 2px
 * accent underline, the rest in tertiary ink. A tab may carry a count pill
 * (the text colour at 8% under secondary ink, as on the web, where a white
 * tint vanished on the light themes).
 *
 * It scrolls sideways, because a Studio object's sections do not fit a phone's
 * width, and brings the active tab into view when it changes from outside
 * (a deep link, a swipe on the content below).
 *
 * `Segmented` is the other tab-like control: that one is a mode switch of two
 * or three; this one is a strip of sections.
 */

import React, { useEffect, useRef } from 'react';
import { Pressable, ScrollView, View, type LayoutChangeEvent, type TextStyle, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { ACTIVE_STROKE, Icon, type IconName } from './icons/Icon';
import { Text } from './Text';
import { tint } from './tint';

export interface TabBarItem<T extends string> {
    id: T;
    label: string;
    /** A count pill after the label. Nullish renders nothing, never a 0. */
    count?: number | null;
    icon?: IconName;
    disabled?: boolean;
}

export interface TabBarProps<T extends string> {
    items: readonly TabBarItem<T>[];
    value: T;
    onChange: (id: T) => void;
    accessibilityLabel?: string;
    testID?: string;
}

/** How far to scroll so a tab at [x, x + width] shows in a viewport, or null when it already does. */
export function scrollTargetFor(
    tab: { x: number; width: number },
    viewport: { offset: number; width: number },
    gutter = 24,
): number | null {
    if (viewport.width <= 0) return null;
    if (tab.x < viewport.offset) return Math.max(0, tab.x - gutter);
    const overflow = tab.x + tab.width - (viewport.offset + viewport.width);
    if (overflow > 0) return viewport.offset + overflow + gutter;
    return null;
}

export function TabBar<T extends string>({ items, value, onChange, accessibilityLabel, testID }: TabBarProps<T>) {
    const styles = useThemedStyles(makeStyles);
    const scroller = useRef<ScrollView>(null);
    const layouts = useRef(new Map<string, { x: number; width: number }>());
    const viewport = useRef({ offset: 0, width: 0 });

    useEffect(() => {
        const tab = layouts.current.get(value);
        const target = tab ? scrollTargetFor(tab, viewport.current) : null;
        if (target !== null) scroller.current?.scrollTo({ x: target, animated: true });
    }, [value]);

    const remember = (id: string) => (e: LayoutChangeEvent) => {
        const { x, width } = e.nativeEvent.layout;
        layouts.current.set(id, { x, width });
    };

    return (
        <View style={styles.bar} testID={testID}>
            <ScrollView
                ref={scroller}
                horizontal
                showsHorizontalScrollIndicator={false}
                accessibilityRole="tablist"
                accessibilityLabel={accessibilityLabel}
                contentContainerStyle={styles.strip}
                scrollEventThrottle={64}
                onLayout={(e) => {
                    viewport.current.width = e.nativeEvent.layout.width;
                }}
                onScroll={(e) => {
                    viewport.current.offset = e.nativeEvent.contentOffset.x;
                }}
            >
                {items.map((item) => {
                    const selected = item.id === value;
                    const hasCount = item.count !== undefined && item.count !== null;
                    return (
                        <Pressable
                            key={item.id}
                            onLayout={remember(item.id)}
                            onPress={() => onChange(item.id)}
                            disabled={item.disabled}
                            accessibilityRole="tab"
                            accessibilityState={{ selected, disabled: item.disabled }}
                            accessibilityLabel={hasCount ? `${item.label}, ${item.count}` : item.label}
                            testID={testID ? `${testID}-${item.id}` : undefined}
                            style={({ pressed }) => [
                                styles.tab,
                                pressed && !selected ? styles.pressed : null,
                                item.disabled ? styles.disabled : null,
                            ]}
                        >
                            {item.icon ? (
                                <Icon
                                    name={item.icon}
                                    size={16}
                                    color={selected ? styles.activeInk.color : styles.idleInk.color}
                                    strokeWidth={selected ? ACTIVE_STROKE : undefined}
                                />
                            ) : null}
                            <Text
                                variant="caption"
                                weight={selected ? 'semibold' : 'medium'}
                                style={selected ? styles.activeInk : styles.idleInk}
                                numberOfLines={1}
                            >
                                {item.label}
                            </Text>
                            {hasCount ? (
                                <View style={styles.count}>
                                    <Text variant="label" weight="semibold" style={styles.countText}>
                                        {String(item.count)}
                                    </Text>
                                </View>
                            ) : null}
                            {selected ? <View style={styles.underline} /> : null}
                        </Pressable>
                    );
                })}
            </ScrollView>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    bar: { borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle } satisfies ViewStyle,
    strip: { paddingHorizontal: theme.spacing[2], gap: theme.spacing[1] } satisfies ViewStyle,
    tab: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[2],
        minHeight: 44,
        paddingHorizontal: theme.spacing[3.5],
        borderTopLeftRadius: 6,
        borderTopRightRadius: 6,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    disabled: { opacity: 0.5 } satisfies ViewStyle,
    activeInk: { color: theme.colors.textPrimary } satisfies TextStyle,
    idleInk: { color: theme.colors.textTertiary } satisfies TextStyle,
    count: {
        minWidth: 20,
        height: 20,
        paddingHorizontal: theme.spacing[1.5],
        borderRadius: theme.radii.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tint(theme.colors.textPrimary, 8),
    } satisfies ViewStyle,
    countText: { color: theme.colors.textSecondary, fontVariant: ['tabular-nums'] } satisfies TextStyle,
    underline: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 2,
        backgroundColor: theme.colors.accentPrimary,
    } satisfies ViewStyle,
});
