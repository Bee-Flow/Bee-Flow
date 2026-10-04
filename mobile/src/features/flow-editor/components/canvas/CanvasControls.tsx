/**
 * The canvas's controls: ONE small bar in the top right corner, off the flow
 * as far as a phone allows (the bottom is the findings pill's):
 *
 *   72%   the zoom, and tapping it fits the flow at a size you can read
 *   +     add a step (unwired — draw its lines after)
 *   🔗    connect mode: draw or remove lines by tapping their two ends
 *   ⋯     Arrange (the web's ArrangeMenu: rows that fit this screen, one
 *         tight line, roomy — one undoable edit, then a fit), fit the whole
 *         flow, 100%, zoom in and out
 *
 * Pinch and double-tap zoom too; the buttons are for one hand and for a
 * screen reader. The bar is drawn outside the canvas's gesture area
 * (CanvasView), so a quick second tap on it never zooms the canvas.
 *
 * In connect mode ConnectBanner takes the bar's place and says what the next
 * tap does.
 */

import React, { useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import { useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ArrangeMode } from '@/features/flow-editor/model';
import { ActionMenu, Icon, IconButton, Text, type ActionMenuItem, type IconName } from '@/shared/ui';

import { ARRANGE_CHOICES } from './moves';
import type { CanvasMode } from './overlay';
import { ZOOM_STEP } from './viewport';

/** How much of the canvas's top the bar covers, for the camera's fit (with its gap). */
export const CONTROLS_INSET = 60;

const makeStyles = (theme: Theme) => ({
    bar: {
        position: 'absolute', top: theme.spacing[2], right: theme.spacing[2], flexDirection: 'row', alignItems: 'center', height: 44,
        paddingHorizontal: theme.spacing[1], borderRadius: theme.radii.pill, borderWidth: 1, borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgCard, boxShadow: theme.shadows.sm,
    } satisfies ViewStyle,
    tool: { width: 40, height: 40 } satisfies ViewStyle,
    zoom: { minWidth: 52, height: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: theme.spacing[1.5] } satisfies ViewStyle,
    pressed: { opacity: 0.6 } satisfies ViewStyle,
    divider: { width: 1, height: 20, backgroundColor: theme.colors.borderSubtle, marginHorizontal: theme.spacing[0.5] } satisfies ViewStyle,
    glyph: { color: theme.colors.textSecondary },
    off: { color: theme.colors.textMuted },
});

/** The zoom as a whole percentage, re-rendering only when that number changes. */
function useZoomPercent(scale: SharedValue<number>): number {
    const [pct, setPct] = useState(100);
    useAnimatedReaction(
        () => Math.round(scale.value * 100),
        (next, prev) => {
            if (next !== prev) scheduleOnRN(setPct, next);
        },
    );
    return pct;
}

export interface CanvasControlsProps {
    scale: SharedValue<number>;
    mode: CanvasMode;
    /** The AI is building: nothing on the canvas may be edited. */
    locked: boolean;
    onZoom: (factor: number) => void;
    onZoomTo: (scale: number) => void;
    /** Fit at a size a card can be read at, the flow's start in view. */
    onFitReadable: () => void;
    /** Fit the whole flow, however small that makes it. */
    onFit: () => void;
    onAdd: () => void;
    onMode: (mode: CanvasMode) => void;
    onArrange: (mode: ArrangeMode) => void;
}

function ZoomChip({ scale, onFitReadable }: Pick<CanvasControlsProps, 'scale' | 'onFitReadable'>) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const pct = useZoomPercent(scale);
    return (
        <Pressable
            onPress={onFitReadable}
            accessibilityRole="button"
            accessibilityLabel={`${pct}%`}
            accessibilityHint={t('mobile.flow.canvas.fit_readable', 'Fits the flow on screen at a size you can read')}
            hitSlop={4}
            style={({ pressed }) => [styles.zoom, pressed ? styles.pressed : null]}
            testID="canvas-zoom"
        >
            <Text variant="caption" weight="semibold" tone="secondary">{`${pct}%`}</Text>
        </Pressable>
    );
}

function menuItems(props: CanvasControlsProps, t: ReturnType<typeof useTranslation>): ActionMenuItem[] {
    const { locked, onArrange, onFit, onZoomTo, onZoom } = props;
    return [
        ...ARRANGE_CHOICES.map((c) => ({ id: c.mode, label: t(c.key, c.fallback), icon: 'LayoutGrid' as IconName, disabled: locked, onPress: () => onArrange(c.mode) })),
        { id: 'fit', label: t('automations.canvas.zoom_fit', 'Fit the whole flow on screen'), icon: 'Crosshair', onPress: onFit },
        { id: 'actual', label: t('automations.canvas.zoom_reset', 'Zoom to 100%'), icon: 'Search', onPress: () => onZoomTo(1) },
        { id: 'in', label: t('automations.canvas.zoom_in', 'Zoom in'), icon: 'Plus', onPress: () => onZoom(ZOOM_STEP) },
        { id: 'out', label: t('automations.canvas.zoom_out', 'Zoom out'), icon: 'Minus', onPress: () => onZoom(1 / ZOOM_STEP) },
    ];
}

export function CanvasControls(props: CanvasControlsProps) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const [menu, setMenu] = useState(false);
    const { mode, locked, onAdd, onMode } = props;
    const connecting = mode === 'connect';
    const colour = locked ? styles.off.color : styles.glyph.color;
    return (
        <>
            {connecting ? null : (
                <View style={styles.bar} testID="canvas-controls">
                    <ZoomChip scale={props.scale} onFitReadable={props.onFitReadable} />
                    <View style={styles.divider} />
                    <IconButton
                        style={styles.tool}
                        icon={<Icon name="Plus" size={20} color={colour} />}
                        accessibilityLabel={t('automations.ribbon.search_label', 'Add a step')}
                        onPress={onAdd}
                        disabled={locked}
                        testID="canvas-add"
                    />
                    <IconButton
                        style={styles.tool}
                        icon={<Icon name="Link" size={18} color={colour} />}
                        accessibilityLabel={t('mobile.flow.canvas.connect', 'Connect steps')}
                        onPress={() => onMode('connect')}
                        disabled={locked}
                        testID="canvas-connect"
                    />
                    <IconButton
                        style={styles.tool}
                        icon={<Icon name="Ellipsis" size={20} color={styles.glyph.color} />}
                        accessibilityLabel={t('mobile.flow.canvas.more', 'Arrange and zoom')}
                        onPress={() => setMenu(true)}
                        testID="canvas-more"
                    />
                </View>
            )}
            <ActionMenu
                visible={menu}
                onClose={() => setMenu(false)}
                title={t('mobile.flow.canvas.more', 'Arrange and zoom')}
                items={menuItems(props, t)}
                testID="canvas-arrange-menu"
            />
        </>
    );
}
