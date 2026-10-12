/**
 * A loop's "N steps inside" (open it here on the canvas) and an open loop's close.
 */

import React from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

import { useCanvasRuntime } from './CanvasRuntime';
import { boxAt, dotAt, makeCanvasStyles } from './canvasStyles';
import { HIT } from './overlay';
import type { SceneNode } from './scene';
import type { Rect } from './viewport';

function loopCount(node: SceneNode, t: ReturnType<typeof useTranslation>): string {
    const n = node.bodyCount;
    return n === 1 ? t('automations.canvas.loop_body_inside', '{n} step inside', { n }) : t('automations.canvas.loop_body_inside_plural', '{n} steps inside', { n });
}

/** Open a loop here ("3 steps inside", hanging off the card) or close it (the header's chevron). */
export function LoopToggle({ node, frame }: { node: SceneNode; frame: Rect }) {
    const styles = useThemedStyles(makeCanvasStyles);
    const t = useTranslation();
    const { actions } = useCanvasRuntime();
    const open = node.kind === 'container';
    const at = open
        ? dotAt(frame, node.x + node.width - 22, node.y + 23, 32)
        : boxAt(frame, { x: node.x + 12, y: node.y + node.height - 12, width: node.width - 24, height: 24 });
    return (
        <View pointerEvents="box-none" style={[styles.abs, at, open ? null : styles.loopChipRow]}>
            <Pressable
                onPress={() => actions.toggleLoop(node.key)}
                hitSlop={HIT}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                accessibilityLabel={open ? t('automations.canvas.loop_collapse', 'Collapse — back to a single card') : t('automations.canvas.loop_expand', 'Expand — show the steps that run per item here on the canvas')}
                style={open ? styles.toggle : styles.loopChip}
            >
                <Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={14} color={styles.loopGlyph.color} />
                {open ? null : (
                    <Text variant="label" weight="semibold" style={styles.loopWords}>
                        {loopCount(node, t)}
                    </Text>
                )}
            </Pressable>
        </View>
    );
}
