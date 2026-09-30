/**
 * The depth slider: a pill track with a stop per depth tier, a fill that
 * darkens with travel, and the labels underneath. Dragging or tapping picks
 * the nearest stop. Labels are placed off the SAME stop centres as the dots —
 * the web's one-expression rule — so the two rows cannot disagree, and the
 * outer ones are nudged inward so "Deep Thinking" stays inside the panel.
 */

import React from 'react';
import { StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import {
    fillColor,
    indexFromX,
    LABEL_WIDTH,
    stopCenter,
    THUMB_RADIUS,
    TRACK_HEIGHT,
} from '@/features/chat/model/tierGeometry';
import { tierLabel, type TierKey, type TierMap } from '@/features/chat/model/tiers';
import { Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    track: {
        height: TRACK_HEIGHT,
        borderRadius: theme.radii.pill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgTertiary,
    },
    fill: { position: 'absolute' as const, left: 5, top: 5, bottom: 5, borderRadius: theme.radii.pill },
    dot: { position: 'absolute' as const, borderRadius: theme.radii.pill },
    labels: { height: 16, marginTop: 8 },
    label: { position: 'absolute' as const, width: LABEL_WIDTH, fontSize: 10, lineHeight: 16 },
});

function dotStyle(theme: Theme, active: boolean, passed: boolean) {
    const size = active ? 28 : 10;
    const color = active ? '#ffffff' : passed ? 'rgba(255,255,255,0.6)' : theme.colors.textTertiary;
    return {
        size,
        style: {
            top: TRACK_HEIGHT / 2 - size / 2,
            width: size,
            height: size,
            backgroundColor: color,
            opacity: active || passed ? 1 : 0.45,
            ...(active ? theme.elevation.card : null),
        },
    };
}

function labelPlacement(i: number, count: number): { shift: number; align: 'left' | 'right' | 'center' } {
    if (i === 0) return { shift: 0.3, align: 'left' };
    if (i === count - 1) return { shift: 0.7, align: 'right' };
    return { shift: 0.5, align: 'center' };
}

export function TierTrack({
    stops,
    tiers,
    value,
    currentLabel,
    onChange,
    width,
    onWidth,
}: {
    stops: TierKey[];
    tiers: TierMap;
    value: TierKey;
    currentLabel: string;
    onChange: (next: TierKey) => void;
    /** The measured track width, kept by the dial so a reopened panel has it. */
    width: number;
    onWidth: (width: number) => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const activeIndex = stops.indexOf(value);
    const onScale = activeIndex >= 0;

    const selectFromEvent = (e: GestureResponderEvent) => {
        const next = stops[indexFromX(e.nativeEvent.locationX, stops.length, width)];
        if (next && next !== value) onChange(next);
    };

    return (
        <>
            <View
                accessibilityRole="adjustable"
                accessibilityLabel={t('mobile.chat.tier_depth', 'Response depth')}
                accessibilityValue={{ text: onScale ? currentLabel : t('mobile.chat.tier_off_scale', 'Not on the depth scale') }}
                onLayout={(e: LayoutChangeEvent) => onWidth(e.nativeEvent.layout.width)}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderGrant={selectFromEvent}
                onResponderMove={selectFromEvent}
                style={[styles.track, { opacity: onScale ? 1 : 0.45 }]}
            >
                {onScale && width > 0 ? (
                    <View
                        pointerEvents="none"
                        style={[
                            styles.fill,
                            {
                                width: Math.max(0, stopCenter(activeIndex, stops.length, width) + THUMB_RADIUS - 5),
                                backgroundColor: fillColor(
                                    theme.colors.textPrimary,
                                    theme.colors.bgTertiary,
                                    activeIndex,
                                    stops.length,
                                ),
                            },
                        ]}
                    />
                ) : null}
                {width > 0
                    ? stops.map((key, i) => {
                          const dot = dotStyle(theme, i === activeIndex, onScale && i < activeIndex);
                          const left = stopCenter(i, stops.length, width) - dot.size / 2;
                          return <View key={key} pointerEvents="none" style={[styles.dot, dot.style, { left }]} />;
                      })
                    : null}
            </View>

            <View style={styles.labels}>
                {width > 0
                    ? stops.map((key, i) => {
                          const { shift, align } = labelPlacement(i, stops.length);
                          const active = i === activeIndex;
                          return (
                              <Text
                                  key={key}
                                  numberOfLines={1}
                                  weight={active ? 'semibold' : 'regular'}
                                  style={[
                                      styles.label,
                                      {
                                          left: stopCenter(i, stops.length, width) - LABEL_WIDTH * shift,
                                          textAlign: align,
                                          color: active ? theme.colors.textPrimary : theme.colors.textTertiary,
                                      },
                                  ]}
                              >
                                  {tierLabel(key, tiers[key])}
                              </Text>
                          );
                      })
                    : null}
            </View>
        </>
    );
}
