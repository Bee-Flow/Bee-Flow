/**
 * One node on the canvas, and what a finger does to it:
 *
 *   tap              open the step's editor (in connect mode: pick it)
 *   hold             the step's menu — the outline card's menu
 *   hold, then drag  move it (a top-level node only; a loop body keeps
 *                    its order), committed as one undoable edit on release
 *
 * The hold is a Pan that only activates after a long press, raced against
 * the tap; the canvas's own pan wins any drag that starts without the hold.
 * While a node is dragged, its ghost follows the finger (DragOverlay) and
 * the node itself dims in place: the gesture stays on the node it began on.
 *
 * Memoised on what it draws — its box (`geom`), its card's words, the zoom
 * level and its state — so an edit elsewhere, or panning, never re-renders it.
 */

import * as Haptics from 'expo-haptics';
import React, { memo, useMemo } from 'react';
import { View, type AccessibilityActionEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';

import { useCanvasRuntime } from './CanvasRuntime';
import { boxAt, makeCanvasStyles } from './canvasStyles';
import { NodeFace } from './NodeFaces';
import type { SceneNode } from './scene';
import type { Lod, Rect } from './viewport';
import { cardLabel } from '../outline/card';
import type { CardModel } from '../outline/cardModel';

/** How long a finger rests before a hold begins. */
export const HOLD_MS = 380;
/** Under this far (screen px), a hold was a hold, not a drag. */
const MOVE_SLOP = 8;

export type NodeState = 'idle' | 'dim' | 'picked' | 'ghost';

export interface CanvasNodeProps {
    node: SceneNode;
    card: CardModel | null;
    /** The world view's top left. */
    frame: Rect;
    lod: Lod;
    state: NodeState;
}

const buzz = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
};

function useNodeGesture(key: string, draggable: boolean) {
    const { actions, drag, scale, canDrag } = useCanvasRuntime();
    const moving = draggable && canDrag;
    return useMemo(() => {
        const { tap, menu, moved, dragging } = actions;
        const hold = Gesture.Pan()
            .withTestId(`canvas-hold-${key}`)
            .activateAfterLongPress(HOLD_MS)
            .onStart(() => {
                drag.set({ key, dx: 0, dy: 0 });
                scheduleOnRN(buzz);
                if (moving) scheduleOnRN(dragging, key);
            })
            .onUpdate((e) => {
                if (moving) drag.set({ key, dx: e.translationX / scale.get(), dy: e.translationY / scale.get() });
            })
            .onEnd((e) => {
                const far = Math.sqrt(e.translationX * e.translationX + e.translationY * e.translationY) > MOVE_SLOP;
                if (!far) scheduleOnRN(menu, key);
                else if (moving) scheduleOnRN(moved, key, drag.get().dx, drag.get().dy);
            })
            .onFinalize(() => {
                // Only a hold that began lets go; the ghost keeps its offset until it is gone.
                if (drag.get().key !== key) return;
                drag.set({ ...drag.get(), key: '' });
                if (moving) scheduleOnRN(dragging, null);
            });
        const press = Gesture.Tap()
            .withTestId(`canvas-tap-${key}`)
            .maxDuration(HOLD_MS)
            .maxDistance(12)
            .onEnd((_e, success) => {
                if (success) scheduleOnRN(tap, key);
            });
        return Gesture.Race(hold, press);
    }, [key, moving, actions, drag, scale]);
}

function nodeWords(node: SceneNode, card: CardModel | null, t: ReturnType<typeof useTranslation>): string {
    if (node.kind === 'entry') return t('automations.canvas.loop_each_item', 'Each item');
    if (node.kind === 'note') return typeof node.node.text === 'string' && node.node.text ? node.node.text : t('automations.note_node.note', 'Note');
    return card ? cardLabel(card, t) : node.nodeId;
}

function CanvasNodeView({ node, card, frame, lod, state }: CanvasNodeProps) {
    const styles = useThemedStyles(makeCanvasStyles);
    const t = useTranslation();
    const { actions } = useCanvasRuntime();
    const gesture = useNodeGesture(node.key, node.draggable);
    const onAction = (e: AccessibilityActionEvent) => {
        if (e.nativeEvent.actionName === 'activate') actions.tap(node.key);
        else if (e.nativeEvent.actionName === 'longpress') actions.menu(node.key);
    };
    return (
        <GestureDetector gesture={gesture}>
            <View
                style={[styles.abs, boxAt(frame, node), state === 'dim' || state === 'ghost' ? styles.dimmed : null, state === 'picked' ? styles.picked : null]}
                accessible
                accessibilityRole="button"
                accessibilityLabel={nodeWords(node, card, t)}
                accessibilityHint={t('mobile.flow.canvas.node_hint', 'Opens this step; hold for its actions, or hold and drag to move it')}
                accessibilityActions={[{ name: 'activate' }, { name: 'longpress' }]}
                onAccessibilityAction={onAction}
                testID={`canvas-node-${node.key}`}
            >
                <NodeFace node={node} card={card} lod={lod} />
            </View>
        </GestureDetector>
    );
}

const shallowSame = (a: object | null, b: object | null): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    const ka = Object.keys(a) as (keyof typeof a)[];
    return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/** Same box, same words, same zoom level, same state: nothing to redraw. */
export function sameNodeProps(a: CanvasNodeProps, b: CanvasNodeProps): boolean {
    return a.node.geom === b.node.geom
        && a.node.key === b.node.key
        && a.node.node === b.node.node
        && a.frame.x === b.frame.x
        && a.frame.y === b.frame.y
        && a.lod === b.lod
        && a.state === b.state
        && shallowSame(a.card, b.card);
}

export const CanvasNode = memo(CanvasNodeView, sameNodeProps);
