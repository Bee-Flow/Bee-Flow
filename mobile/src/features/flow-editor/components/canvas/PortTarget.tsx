/**
 * Connect mode: a target on every port a line can leave from.
 */

import React from 'react';
import { Pressable } from 'react-native';

import { useTranslation } from '@/core/i18n';

import { useCanvasRuntime } from './CanvasRuntime';
import { dotAt, type CanvasStyles } from './canvasStyles';
import { HIT } from './overlay';
import type { PortSpec } from './ports';
import type { SceneNode } from './scene';
import type { Rect } from './viewport';
import { rowWords } from '../outline/rowWords';

/** Connect mode: where a line can leave from. */
export interface PortTargetProps {
    node: SceneNode;
    /** The node's name, for the screen reader. */
    name: string;
    port: PortSpec;
    frame: Rect;
    picked: boolean;
    styles: CanvasStyles;
}

export function PortTarget({ node, name, port, frame, picked, styles }: PortTargetProps) {
    const t = useTranslation();
    const { actions } = useCanvasRuntime();
    const portName = port.text ? rowWords(port.text, t) : null;
    return (
        <Pressable
            onPress={() => actions.pickPort(node.key, port)}
            hitSlop={HIT}
            accessibilityRole="button"
            accessibilityState={{ selected: picked }}
            accessibilityLabel={portName
                ? t('mobile.flow.canvas.port_named', 'Draw a line from {port} of {name}', { port: portName, name })
                : t('mobile.flow.canvas.port', 'Draw a line from {name}', { name })}
            style={[styles.abs, dotAt(frame, node.x + node.width, node.y + port.dy, 28), styles.target, picked ? styles.targetPicked : null]}
            testID={`canvas-port-${node.key}-${port.id}`}
        />
    );
}
