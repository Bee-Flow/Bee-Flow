/**
 * The family bar on a step card's leading edge (the web's StepNodeBase). The
 * card's border belongs to the run status, never to the family; the family
 * speaks through this bar, the icon tile and the kicker.
 */

import React from 'react';
import { View } from 'react-native';

import type { CardModel } from '../cardModel';
import type { OutlineStyles } from '../outlineStyles';

/** The family bar on the leading edge. */
export function CardBar({ card, styles }: { card: CardModel; styles: OutlineStyles }) {
    return <View style={[styles.bar, card.errorTone ? styles.barError : styles.barColor[card.family ?? 'none']]} />;
}
