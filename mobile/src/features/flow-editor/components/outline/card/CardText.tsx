/**
 * A step card's words: the kicker with the step number, the name, and one
 * summary line. The line is often a prompt or a message written in markdown;
 * it shows as its plain words, since one clipped line has no room for
 * formatting and asterisks are noise.
 */

import React from 'react';
import { View } from 'react-native';

import { plainMarkdown } from '@/shared/markdown';
import { Text } from '@/shared/ui';

import type { CardModel } from '../cardModel';
import type { OutlineStyles } from '../outlineStyles';

/** The kicker with the step number, the name, and one summary line. */
export function CardText({ card, styles }: { card: CardModel; styles: OutlineStyles }) {
    const key = card.family ?? 'none';
    return (
        <View style={styles.body}>
            <Text variant="label" weight="semibold" numberOfLines={1} style={[styles.kicker, card.errorTone ? styles.kickerError : styles.kickerColor[key]]}>
                {card.kicker}
            </Text>
            <Text variant="subheading" numberOfLines={1} style={styles.name}>
                {card.name}
            </Text>
            {card.sub ? (
                <Text variant="caption" tone="tertiary" numberOfLines={1} style={card.subMuted ? styles.muted : undefined}>
                    {plainMarkdown(card.sub)}
                </Text>
            ) : null}
        </View>
    );
}
