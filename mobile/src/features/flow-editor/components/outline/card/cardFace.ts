/**
 * The step card's frame and its spoken label — the parts of the web's
 * StepNodeBase anatomy that are not drawn: which corners and border a card
 * wears (its family and run status), and what a screen reader says for it.
 */

import { statusTone } from '@/features/flow-editor/model';

import type { CardModel } from '../cardModel';
import type { OutlineStyles } from '../outlineStyles';

/** The card's frame: its corners by family, its border by run status. */
export function cardChromeStyles(card: CardModel, styles: OutlineStyles) {
    const tone = statusTone(card.status ?? (card.pinned ? 'pinned' : null));
    return [
        styles.card,
        card.family === 'trigger' ? styles.triggerEdge : null,
        card.family === 'end' ? styles.endEdge : null,
        card.family === 'loop' && !tone ? styles.loopBorder : null,
        tone ? styles.statusBorder[tone] : null,
        card.status === 'skipped' ? styles.skipped : null,
        card.disabled ? styles.disabledCard : null,
    ];
}

/** What a screen reader says for a card: kind and number, name, summary, findings. */
export function cardLabel(card: CardModel, t: (key: string, fallback: string, params?: Record<string, string | number>) => string): string {
    const issues = card.errors
        ? t('mobile.flow.card.errors', '{n} problems to fix', { n: card.errors })
        : card.warnings ? t('mobile.flow.card.warnings', '{n} warnings', { n: card.warnings }) : '';
    return [card.kicker, card.name, card.sub, issues].filter(Boolean).join(', ');
}
