/**
 * The player's seek bar: tap anywhere to jump, or drag and let go. While a
 * finger is down the bar follows the finger rather than the audio, so the
 * thumb does not fight the person holding it.
 */

import React, { useState } from 'react';
import { View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { fractionAt } from '../model/player';

const TRACK = 4;
const THUMB = 14;

const makeStyles = (theme: Theme) => ({
    hit: { height: 28, justifyContent: 'center' as const },
    track: { height: TRACK, borderRadius: TRACK / 2, backgroundColor: theme.colors.bgTertiary, overflow: 'hidden' as const },
    fill: { height: TRACK, backgroundColor: theme.colors.accentPrimary },
    thumb: {
        position: 'absolute' as const,
        width: THUMB,
        height: THUMB,
        marginLeft: -THUMB / 2,
        borderRadius: THUMB / 2,
        backgroundColor: theme.colors.accentPrimary,
    },
});

export function SeekBar({
    progress,
    disabled,
    onSeek,
}: {
    /** 0..1 through the recording. */
    progress: number;
    disabled: boolean;
    /** 0..1 where the finger let go. */
    onSeek: (fraction: number) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [width, setWidth] = useState(0);
    const [dragging, setDragging] = useState<number | null>(null);
    const shown = dragging ?? progress;
    const at = (e: GestureResponderEvent) => fractionAt(e.nativeEvent.locationX, width);
    // The one measurement that changes every tick, as computed styles.
    const percent = `${shown * 100}%` as const;
    const fillWidth = { width: percent };
    const thumbLeft = { left: percent };

    return (
        <View
            style={styles.hit}
            onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
            onStartShouldSetResponder={() => !disabled}
            onMoveShouldSetResponder={() => !disabled}
            onResponderGrant={(e) => setDragging(at(e))}
            onResponderMove={(e) => setDragging(at(e))}
            onResponderRelease={(e) => {
                setDragging(null);
                onSeek(at(e));
            }}
            onResponderTerminate={() => setDragging(null)}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={t('mobile.recording.seek', 'Position in the recording')}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(shown * 100) }}
        >
            <View style={styles.track} pointerEvents="none">
                <View style={[styles.fill, fillWidth]} />
            </View>
            <View style={[styles.thumb, thumbLeft]} pointerEvents="none" />
        </View>
    );
}
