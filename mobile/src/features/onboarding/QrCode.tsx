/**
 * The QR the user points their authenticator at.
 *
 * Drawn as one SVG path rather than a grid of <Rect>s: a version-6 symbol is
 * 41×41 modules, and ~800 dark ones as separate elements is 800 native views
 * for a picture that never changes. A single path is one view.
 *
 * The quiet zone is not decoration — a scanner needs four clear modules on
 * every side, and "the QR is inside a card whose padding happens to be white"
 * is not a promise this app can make across eight themes. So the light ground
 * is painted here, deliberately light-on-dark even in dark mode: a camera
 * reads an inverted symbol far less reliably than a conventional one, and
 * enrolment is a once-ever moment that must not be the one that fails.
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { encodeQr } from './qr';
import { useTheme } from '../../theme/ThemeProvider';

const QUIET_ZONE = 4;

export interface QrCodeProps {
    /** The payload. For enrolment this is the server's `otpauthUrl`. */
    value: string;
    /** Side length in dp. */
    size?: number;
    /** Announced to a screen reader in place of the picture. */
    accessibilityLabel?: string;
    /** Rendered when the payload cannot be encoded — never a broken QR. */
    fallback?: React.ReactNode;
}

export function QrCode({ value, size = 220, accessibilityLabel, fallback = null }: QrCodeProps) {
    const theme = useTheme();
    const matrix = useMemo(() => encodeQr(value), [value]);

    if (!matrix) return <>{fallback}</>;

    const side = matrix.size + QUIET_ZONE * 2;

    // One path, one move-and-rect per dark module. `h1 v1 h-1 z` is the
    // shortest way to say "a 1×1 square here" and keeps the string small
    // enough that re-parsing it is never the bottleneck.
    const path = matrix.modules
        .map((row, y) =>
            row
                .map((dark, x) =>
                    dark ? `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z` : '',
                )
                .join(''),
        )
        .join('');

    return (
        <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={
                accessibilityLabel ?? 'QR code for setting up your authenticator app'
            }
            style={{
                borderRadius: theme.radii.md,
                overflow: 'hidden',
                alignSelf: 'center',
            }}
        >
            <Svg width={size} height={size} viewBox={`0 0 ${side} ${side}`}>
                <Rect x={0} y={0} width={side} height={side} fill="#ffffff" />
                <Path d={path} fill="#000000" />
            </Svg>
        </View>
    );
}
