/**
 * The sentences around "Needs attention" — the one line that says whether the
 * list is the whole picture (model/attention.attentionLine), with the sources
 * that did not answer named by their Studio section. Shared by the hub's
 * card and the full list, so both say it the same way.
 */

import type { TranslateFn } from '@/core/i18n';

import type { StudioAttention } from './api';
import { attentionLine, attentionSections } from './attention';
import { studioSection } from './registry';

function names(keys: readonly string[], t: TranslateFn): string {
    return attentionSections(keys)
        .map((id) => {
            const s = studioSection(id);
            return t(s.labelKey, s.labelFallback);
        })
        .join(', ');
}

/** The one line under the heading, with the unanswered sources named; null when there is none. */
export function attentionLineText(attention: StudioAttention, t: TranslateFn): string | null {
    const line = attentionLine(attention);
    if (!line) return null;
    const broken = names(attention.unavailable, t);
    const which = broken ? ` ${t('studio.attention.unavailable_named', 'Not checked: {sections}.', { sections: broken })}` : '';
    switch (line) {
        case 'empty':
            return t('studio.attention.empty', 'Nothing needs attention.');
        case 'empty_capped':
            return t('studio.attention.empty_capped', 'Nothing was found in the part that was checked — this is not the whole organisation.');
        case 'empty_unchecked':
            return `${t('studio.attention.empty_unchecked', 'Some checks could not run, so this is not the whole picture — not a clean bill of health.')}${which}`;
        case 'partial_capped':
            return t('studio.attention.partial_capped', 'This covers the part that was checked, not the whole organisation.');
        case 'partial':
            return `${t('studio.attention.partial', 'Some checks could not run, so this list may be incomplete.')}${which}`;
    }
}
