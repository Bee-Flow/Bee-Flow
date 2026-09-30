/**
 * The sitemap, cut into what the A–Z map renders: the rows this session may
 * reach, filtered by what was typed, one section per first letter. Pure, so
 * the rules below are unit-tested rather than trusted.
 */

import type { AccessSnapshot } from '@/core/access';

import { DESTINATIONS } from '../nav/destinations';
import { isReachable, matchesSearch } from '../nav/search';
import type { Destination } from '../nav/types';

export interface LetterSection {
    title: string;
    data: Destination[];
}

/** Every destination this session may reach that matches the search. */
export function visibleDestinations(
    access: AccessSnapshot,
    search: string,
    translate?: (key: string, fallback: string) => string,
): Destination[] {
    return DESTINATIONS.filter((d) => isReachable(d, access) && matchesSearch(d, search, translate));
}

/** The words a row is shown under: its label in the reader's language when the catalogue has it. */
export type LabelOf = (destination: Destination) => string;

const englishLabel: LabelOf = (d) => d.label;

/** A row's label as SitemapRow draws it: the web's key when it has one, else the English. */
export function translatedLabel(translate: (key: string, fallback: string) => string): LabelOf {
    return (d) => (d.i18nKey ? translate(d.i18nKey, d.label) : d.label);
}

/**
 * The letter a label files under: its first letter, capitalised in the
 * reader's language and without its accent — "Één" sits under E, where a
 * Dutch reader looks for it, rather than in a section of its own.
 */
function letterOf(label: string, locale: string): string {
    return label.charAt(0).toLocaleUpperCase(locale).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * The app's language as a tag Intl takes, with its collator. The server
 * accepts codes Intl does not ('pt_br', which an admin can add): the
 * underscore form is read as the tag it means, and anything Intl still
 * refuses sorts in English — a RangeError here would crash the render.
 */
function collation(locale: string): { tag: string; collator: Intl.Collator } {
    const tag = locale.replace(/_/g, '-');
    try {
        return { tag, collator: new Intl.Collator(tag, { sensitivity: 'base' }) };
    } catch {
        return { tag: 'en', collator: new Intl.Collator('en', { sensitivity: 'base' }) };
    }
}

/**
 * The complete map: alphabetical, one section per first letter — by the words
 * the reader SEES. Sorting and lettering by the English label while the rows
 * showed Dutch ones put "Taken" under T between English neighbours and
 * "Instellingen" under S. Pass `translatedLabel(t)` and the app's locale;
 * without them the map is English, as before.
 */
export function alphabetSections(allowed: Destination[], labelOf: LabelOf = englishLabel, locale = 'en'): LetterSection[] {
    const { tag, collator } = collation(locale);
    const labelled = allowed.map((d) => ({ d, label: labelOf(d) }));
    labelled.sort((a, b) => collator.compare(a.label, b.label));
    const byLetter = new Map<string, Destination[]>();
    for (const { d, label } of labelled) {
        const letter = letterOf(label, tag);
        byLetter.set(letter, [...(byLetter.get(letter) ?? []), d]);
    }
    return [...byLetter.entries()]
        .sort(([a], [b]) => collator.compare(a, b))
        .map(([title, data]) => ({ title, data }));
}
