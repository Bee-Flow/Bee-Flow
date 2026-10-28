/**
 * How a sitemap row is written down: its words travel as data, `{ i18nKey, en }`,
 * and become the flat `Destination` the rest of the app reads.
 *
 * A row has two phrases (its label and its hint) and each carries its catalogue
 * key with the English that renders until the catalogue has it. The key is the
 * web's own where the web says the same thing (`sidebar.agents`,
 * `studio.tab.knowledge_desc`: an administrator's translation then shows up on
 * the phone for free) and `mobile.sitemap.<id>.label` / `.hint` where it does
 * not. Search and the A–Z sort ask the same keys the row renders under (see
 * `matchesSearch` and `translatedLabel`), so they match what the reader sees.
 */

import type { Destination } from './types';

/** A phrase as data: where the catalogue keeps it, and the English it falls back to. */
export interface Words {
    i18nKey: string;
    en: string;
}

/** A row as it is written in nav/destinations/: the flat shape with its two phrases as `Words`. */
export type DestinationSpec = Omit<Destination, 'label' | 'hint' | 'i18nKey' | 'hintKey'> & {
    label: Words;
    hint: Words;
};

/**
 * The flat row. `label` and `hint` stay the English strings (the global search
 * and the organisation's place search read them as such), with `i18nKey` and
 * `hintKey` beside them: every row has both.
 */
export function destination({ label, hint, ...rest }: DestinationSpec): Destination {
    return { ...rest, label: label.en, i18nKey: label.i18nKey, hint: hint.en, hintKey: hint.i18nKey };
}
