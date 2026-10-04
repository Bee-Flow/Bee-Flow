/**
 * A step card's chips: the run badge or result, the pin, the issue count.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { STATUS_BADGE, statusTone, type StatusTone } from '@/features/flow-editor/model';
import { Badge, type BadgeTone } from '@/shared/ui';

import type { CardModel } from '../cardModel';
import type { OutlineStyles } from '../outlineStyles';

const BADGE_TONE: Record<StatusTone, BadgeTone> = { success: 'success', error: 'error', ai: 'ai', warning: 'warning', pinned: 'pinned' };

/** The run badge or result chip, the pin, the issue count. */
export function CardBadges({ card, styles }: { card: CardModel; styles: OutlineStyles }) {
    const t = useTranslation();
    const badge = card.status && Object.prototype.hasOwnProperty.call(STATUS_BADGE, card.status) ? STATUS_BADGE[card.status] : undefined;
    const tone = statusTone(card.status);
    return (
        <View style={styles.chips}>
            {badge && tone ? <Badge label={t(badge.key, badge.en)} tone={BADGE_TONE[tone]} /> : null}
            {!badge && card.result ? <Badge label={card.result} tone="neutral" /> : null}
            {/* A pinned step with no run row wears a `pinned` run stub (run/runStatus.ts): one pin chip, not two. */}
            {card.pinned && card.status !== 'pinned' ? <Badge label={t('automations.card.badge_pinned', 'pinned')} tone="pinned" icon="Pin" /> : null}
            {card.errors ? <Badge label={String(card.errors)} tone="error" icon="CircleAlert" /> : null}
            {!card.errors && card.warnings ? <Badge label={String(card.warnings)} tone="warning" icon="TriangleAlert" /> : null}
        </View>
    );
}
