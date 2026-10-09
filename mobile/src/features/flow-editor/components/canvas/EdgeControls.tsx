/**
 * A line's controls, centred on it: its chip (its branch, when its port does
 * not already say it) and its "+", which inserts a step ON that line — or, in
 * connect mode, its "×", which removes a real connection (a loop body's lines
 * are its order, so they have none).
 */

import React, { memo } from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

import { useCanvasRuntime } from './CanvasRuntime';
import { centred, makeCanvasStyles } from './canvasStyles';
import { chipTone, chipWords, showsChip } from './chips';
import { HIT, type CanvasMode } from './overlay';
import { PlusButton } from './PlusButton';
import type { SceneEdge } from './sceneEdges';
import type { Rect } from './viewport';

/** The width of the row a line's chip and button share, centred on the line. */
const CLUSTER_W = 260;
const CLUSTER_H = 32;

function EdgeControlsView({ edge, frame, mode, editable }: { edge: SceneEdge; frame: Rect; mode: CanvasMode; editable: boolean }) {
    const styles = useThemedStyles(makeCanvasStyles);
    const t = useTranslation();
    const { actions } = useCanvasRuntime();
    const chip = showsChip(edge) && edge.kind ? edge.kind : null;
    const remove = mode === 'connect' && edge.removable && editable;
    const insert = mode === 'edit' && editable;
    if (!chip && !remove && !insert) return null;
    const tone = chip ? chipTone(chip) : 'default';
    return (
        <View pointerEvents="box-none" style={[styles.cluster, centred(frame, edge.chipAt, CLUSTER_W, CLUSTER_H)]}>
            {chip ? (
                <View style={[styles.chip, styles.chipTone[tone]]}>
                    <Text variant="label" weight="semibold" numberOfLines={1} style={styles.chipWords[tone]}>
                        {chipWords(chip, t)}
                    </Text>
                </View>
            ) : null}
            {insert ? <PlusButton target={edge.insert} label={t('automations.edges.insert_a_step_here', 'Insert a step here')} testID={`canvas-insert-${edge.id}`} /> : null}
            {remove ? (
                <Pressable
                    onPress={() => actions.removeEdge(edge)}
                    hitSlop={HIT}
                    accessibilityRole="button"
                    accessibilityLabel={t('automations.edges.remove_this_connection', 'Remove this connection')}
                    style={styles.remove}
                >
                    <Icon name="X" size={15} color={styles.removeGlyph.color} />
                </Pressable>
            ) : null}
        </View>
    );
}

export const EdgeControls = memo(
    EdgeControlsView,
    (a, b) => a.edge.chipAt.x === b.edge.chipAt.x && a.edge.chipAt.y === b.edge.chipAt.y && a.edge.kind === b.edge.kind
        && a.edge.labelledAtPort === b.edge.labelledAtPort && a.edge.id === b.edge.id && a.mode === b.mode && a.editable === b.editable
        && a.frame.x === b.frame.x && a.frame.y === b.frame.y,
);
