/**
 * A step's icon tile in its family's colour and shape — the web's type tile
 * (flow/nodeTypeColors.js typeTile, ported as model/familyStyle): a branch is
 * a diamond, the shield a shield, a form page a circle, an end card a solid
 * block, the rest rounded. The shape says the family a second time for anyone
 * who cannot rely on colour. Decorative: the header beside it names the step.
 *
 * The glyph is the step card's (outline/stepIcons: the author's symbol, else
 * the web node component's icon for the type), so the editor's header wears
 * the icon of the card that was tapped to open it.
 */

import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { stepFamily, typeTile, type AnyNode, type TileShape } from '@/features/flow-editor/model';
import { Icon } from '@/shared/ui';

import { stepIconName } from '../outline/stepIcons';

function shapeStyle(shape: TileShape, size: number): ViewStyle {
    switch (shape) {
        case 'circle':
            return { borderRadius: size / 2 };
        case 'diamond':
            return { borderRadius: 4, transform: [{ rotate: '45deg' }], width: size * 0.78, height: size * 0.78 };
        case 'shield':
            return { borderTopLeftRadius: 6, borderTopRightRadius: 6, borderBottomLeftRadius: size / 2, borderBottomRightRadius: size / 2 };
        case 'block':
            return { borderRadius: 4 };
        default:
            return { borderRadius: 8 };
    }
}

export function FamilyTile({ step, size = 28, error = false }: { step: FlowNode; size?: number; error?: boolean }) {
    const theme = useTheme();
    const tile = typeTile(theme, stepFamily(step.type), { type: step.type ?? null, error });
    const glyph = stepIconName(step as AnyNode);
    const box: ViewStyle = { width: size, height: size, backgroundColor: tile.background, ...shapeStyle(tile.shape, size) };
    // The diamond is a rotated square; its glyph is counter-rotated to stay upright.
    const upright: ViewStyle = tile.shape === 'diamond' ? { transform: [{ rotate: '-45deg' }] } : {};
    return (
        <View style={styles.frame} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={[styles.tile, box]}>
                <View style={upright}>
                    <Icon name={glyph} size={Math.round(size * 0.55)} color={tile.color} />
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    frame: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    tile: { alignItems: 'center', justifyContent: 'center' },
});
