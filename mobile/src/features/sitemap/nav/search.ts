/**
 * Filtering the sitemap: by what a person typed, and by what they may reach.
 */

import { evaluateGate, type AccessSnapshot } from '@/core/access';

import type { Destination } from './types';

/**
 * Substring match over a destination's words — in the user's language AND in
 * English, always both.
 *
 * The haystack used to be English literals only. That was invisible while
 * nothing but the More tab used it, and would have become the central defect
 * the moment the header magnifier started answering "where is X": this
 * product's primary users work in Dutch, so the one instrument built to end the
 * hunting would have returned nothing for every word they actually typed.
 *
 * Both languages, never one, for two reasons. A Dutch user who has picked up
 * the English product noun — everybody says "dashboard" — still finds it. And
 * an untranslated key falls back to its English literal, so a half-translated
 * catalogue degrades to today's behaviour instead of to silence.
 */
export function matchesSearch(
    destination: Destination,
    query: string,
    /** Omit for English-only matching; pass `t` from useTranslation for both. */
    translate?: (key: string, fallback: string) => string,
): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;

    const words = [destination.label, destination.hint, ...(destination.keywords ?? [])];
    if (translate && destination.i18nKey) {
        words.push(translate(destination.i18nKey, destination.label));
    }
    if (translate && destination.hintKey) {
        words.push(translate(destination.hintKey, destination.hint));
    }
    return words.join(' ').toLowerCase().includes(needle);
}

/**
 * Offer only what the gate lets through.
 *
 * Every destination without a `gate` stays — see types.ts for why erring
 * towards visible is the right default here. A gated row is decided by
 * core/access, the same verdict the drawer and Studio reach, so the map cannot
 * offer a door the navigation keeps shut. A LOCKED verdict still counts as
 * reachable: the row exists to say what the thing is.
 */
export function isReachable(destination: Destination, access: AccessSnapshot): boolean {
    if (!destination.gate) return true;
    return evaluateGate(destination.gate, access).visible;
}
