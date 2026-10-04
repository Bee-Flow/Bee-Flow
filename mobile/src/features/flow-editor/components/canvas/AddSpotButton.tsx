/**
 * A "+" beside a port nothing leaves from, or at the end of an open loop's body.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';

import { dotAt, makeCanvasStyles, PLUS } from './canvasStyles';
import { PlusButton } from './PlusButton';
import type { AddSpot } from './sceneEdges';
import type { Rect } from './viewport';

export function AddSpotButton({ spot, frame }: { spot: AddSpot; frame: Rect }) {
    const styles = useThemedStyles(makeCanvasStyles);
    const t = useTranslation();
    return (
        <View style={[styles.abs, dotAt(frame, spot.x, spot.y, PLUS)]}>
            <PlusButton target={spot.target} label={t('automations.ribbon.search_label', 'Add a step')} testID={`canvas-${spot.key}`} />
        </View>
    );
}
