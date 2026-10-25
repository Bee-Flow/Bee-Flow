import { describe, expect, it } from 'vitest';
import { readingLocale } from './useTranslation';

/**
 * Which language is the person READING?
 *
 * `locale` answers a different question: it is a preference (the browser's
 * language, or a choice stored per origin — the Nextcloud-embedded app has its
 * own localStorage). On a deployment without a catalogue for it, t() renders
 * the English defaults and the screen is English while `locale` still says
 * 'nl'. A Playbook is BUILT in the user's language — its table columns, the
 * builders' briefs, the app's labels — so it has to follow the screen.
 */
describe('readingLocale — the language on screen, not the preference', () => {
    it('a preference without a catalogue reads English', () => {
        expect(readingLocale('nl', {})).toBe('en');
        expect(readingLocale('nl', null)).toBe('en');
        expect(readingLocale('de', undefined)).toBe('en');
    });

    it('a loaded catalogue is the language on screen', () => {
        expect(readingLocale('nl', { 'playbooks.new.title': 'Nieuw playbook' })).toBe('nl');
    });

    it('anchors make it exact: a catalogue that does not cover THIS screen reads English', () => {
        const anchors = ['playbooks.new.title', 'playbooks.new.describe_label'];
        // Loaded, sizeable, and none of it is the screen in question — every
        // t() there falls through to English, so the screen IS English.
        // (Measured 2026-09-16: an all-English playbook dialog built a Dutch
        // demo because "some catalogue is loaded" counted as Dutch.)
        expect(readingLocale('nl', { 'chat.send': 'Versturen', 'studio.tab.apps': 'Apps' }, anchors)).toBe('en');
        // One of the two translated is not enough — half a screen is not a language.
        expect(readingLocale('nl', { 'playbooks.new.title': 'Nieuw playbook' }, anchors)).toBe('en');
        // All of them: the screen really is Dutch.
        expect(readingLocale('nl', { 'playbooks.new.title': 'Nieuw playbook', 'playbooks.new.describe_label': 'Wat?' }, anchors)).toBe('nl');
        // An empty value is not a translation.
        expect(readingLocale('nl', { 'playbooks.new.title': '', 'playbooks.new.describe_label': 'Wat?' }, anchors)).toBe('en');
        // No anchors: the old, weaker question — "is a catalogue loaded".
        expect(readingLocale('nl', { 'chat.send': 'Versturen' })).toBe('nl');
    });

    it('English asks for nothing and stays English', () => {
        expect(readingLocale('en', {})).toBe('en');
        expect(readingLocale('', { a: 'b' })).toBe('en');
    });
});
