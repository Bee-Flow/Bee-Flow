/**
 * One step on the outline — the web's StepNodeBase card, full width: a 4px
 * bar in the step's family colour, the icon tile (its shape says the family
 * a second time), the kicker with the step number, the name and one summary
 * line; on the right the run badge or result chip, the pin and the issue
 * count. The border belongs to the run status, never to the family. The face
 * is outline/card/, shared with the canvas.
 *
 * Tap opens the step; long-press or ⋯ opens its menu.
 */

import React from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Icon, IconButton } from '@/shared/ui';

import { CardBadges, CardBar, cardChromeStyles, cardLabel, CardText, CardTile } from './card';
import { cardModel, type CardModel } from './cardModel';
import { useOutline } from './OutlineContext';
import { indentFor, makeOutlineStyles, type OutlineStyles } from './outlineStyles';

function Side({ card, onMenu, styles }: { card: CardModel; onMenu: () => void; styles: OutlineStyles }) {
    const t = useTranslation();
    return (
        <View style={styles.side}>
            <CardBadges card={card} styles={styles} />
            <IconButton
                icon={<Icon name="Ellipsis" size={18} color={styles.menuGlyph.color} />}
                accessibilityLabel={t('mobile.flow.card.menu', 'More actions for {name}', { name: card.name })}
                onPress={onMenu}
            />
        </View>
    );
}

export function StepCard({ address, depth }: { address: string; depth: number }) {
    const styles = useThemedStyles(makeOutlineStyles);
    const t = useTranslation();
    const { definition, card: ctx, onOpen, onMenu } = useOutline();
    const card = cardModel(definition, address, ctx);
    if (!card) return null;
    return (
        <View style={indentFor(styles, depth)}>
            <Pressable
                onPress={() => onOpen(address)}
                onLongPress={() => onMenu(address)}
                accessibilityRole="button"
                accessibilityLabel={cardLabel(card, t)}
                accessibilityHint={t('mobile.flow.card.open_hint', 'Opens this step; hold for more actions')}
                style={({ pressed }) => [...cardChromeStyles(card, styles), pressed ? styles.pressed : null]}
                testID={`step-card-${address}`}
            >
                <CardBar card={card} styles={styles} />
                <CardTile card={card} styles={styles} />
                <CardText card={card} styles={styles} />
                <Side card={card} onMenu={() => onMenu(address)} styles={styles} />
            </Pressable>
        </View>
    );
}
