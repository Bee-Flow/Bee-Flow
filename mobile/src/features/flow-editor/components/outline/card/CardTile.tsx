/**
 * A step card's icon tile: its shape says the family a second time — a
 * diamond for a branch, a shield, a circle, a block.
 */

import React from 'react';
import { View } from 'react-native';

import { Icon } from '@/shared/ui';

import type { CardModel } from '../cardModel';
import type { OutlineStyles } from '../outlineStyles';

/** The icon tile: a diamond for a branch, a shield, a circle, a block. */
export function CardTile({ card, styles }: { card: CardModel; styles: OutlineStyles }) {
    const key = card.family ?? 'none';
    const diamond = card.family === 'branch';
    return (
        <View style={styles.tileBox}>
            <View style={[styles.tile, card.errorTone ? styles.tileError : styles.tileColor[key]]}>
                <Icon
                    name={card.icon}
                    size={16}
                    color={(card.errorTone ? styles.glyphError : styles.glyph[key]).color}
                    style={diamond ? styles.unrotate : undefined}
                />
            </View>
        </View>
    );
}
