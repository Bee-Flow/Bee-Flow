/**
 * The app's own words.
 *
 * The bug these exist for: the same account rendered "Waar werken we aan?" in a
 * browser and "Ask Bee Flow anything" on the phone, because mobile had no i18n
 * at all. The cases below are the ways a fix for that quietly fails — picking a
 * locale the server cannot serve, and a half-translated catalogue rendering
 * blanks instead of English.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
    ensureHydrated,
    parseCatalogue,
    renderedLocale,
    resolveLocale,
    setCatalogue,
    setStoredLocale,
    storedLocale,
    translate,
    _reset,
} from './store';

const AVAILABLE = ['en', 'nl', 'de'];

beforeEach(async () => {
    _reset();
    await AsyncStorage.clear();
});

describe('resolveLocale', () => {
    it('prefers what this person chose', () => {
        expect(
            resolveLocale({ stored: 'de', orgDefault: 'nl', device: 'en', available: AVAILABLE }),
        ).toBe('de');
    });

    it('falls to the organisation default — the case that makes a Dutch workspace Dutch', () => {
        // Nobody on this phone ever chose. The web would render the org's
        // language; so must this.
        expect(
            resolveLocale({ stored: null, orgDefault: 'nl', device: 'en', available: AVAILABLE }),
        ).toBe('nl');
    });

    it('falls to the device only when the account says nothing', () => {
        expect(
            resolveLocale({ stored: null, orgDefault: null, device: 'de', available: AVAILABLE }),
        ).toBe('de');
    });

    it('never picks a locale the server cannot serve', () => {
        // Offering a language the server has no strings for is offering a 404 —
        // the mistake the Language screen's own comment warns about.
        expect(
            resolveLocale({ stored: 'fr', orgDefault: null, device: 'es', available: AVAILABLE }),
        ).toBe('en');
        expect(
            resolveLocale({ stored: 'fr', orgDefault: 'nl', device: 'es', available: AVAILABLE }),
        ).toBe('nl');
    });

    it('ends at English when the server offers nothing at all', () => {
        expect(
            resolveLocale({ stored: 'nl', orgDefault: 'nl', device: 'nl', available: [] }),
        ).toBe('en');
    });
});

describe('translate', () => {
    it('renders English until a catalogue arrives', () => {
        // Every unconverted screen and every cold start depends on this.
        expect(translate('settings.appearance', 'Appearance')).toBe('Appearance');
    });

    it('renders the translation once it does', () => {
        setCatalogue('nl', { 'settings.appearance': 'Weergave' });
        expect(translate('settings.appearance', 'Appearance')).toBe('Weergave');
    });

    it('falls back per key, not per catalogue', () => {
        // A partly translated locale must not blank the untranslated half.
        setCatalogue('nl', { 'settings.appearance': 'Weergave' });
        expect(translate('settings.security', 'Security')).toBe('Security');
    });
});

describe('translate with placeholders', () => {
    it('fills a placeholder in the translation', () => {
        // The catalogue is the WEB's, and it already contains sentences of this
        // shape (`sidebar.recent_show_all` is "All {section}"). Without this the
        // phone renders the braces.
        setCatalogue('nl', { 'sidebar.recent_show_all': 'Alle {section}' });
        expect(translate('sidebar.recent_show_all', 'All {section}', { section: 'chats' })).toBe(
            'Alle chats',
        );
    });

    it('fills it in the English fallback too', () => {
        // Which is the case that actually ships today: most keys are not in the
        // dictionaries yet, so the fallback is what a user reads.
        expect(translate('mobile.x', 'Runs every {n} days', { n: 3 })).toBe('Runs every 3 days');
    });

    it('replaces every occurrence', () => {
        expect(translate('mobile.x', '{who} asked {who}', { who: 'Jan' })).toBe('Jan asked Jan');
    });

    it('leaves a placeholder nobody supplied alone', () => {
        // Better a visible {n} than a sentence silently missing its number.
        expect(translate('mobile.x', 'Runs every {n} days', { other: 'x' })).toBe(
            'Runs every {n} days',
        );
    });

    it('does not re-scan a substituted value', () => {
        // A person named "{admin}" must not be able to rewrite the sentence
        // around them.
        expect(translate('mobile.x', 'Hello {name}', { name: '{name} {name}' })).toBe(
            'Hello {name} {name}',
        );
    });

    it('renders a number as a number', () => {
        expect(translate('mobile.x', '{n} left', { n: 0 })).toBe('0 left');
    });
});

describe('parseCatalogue', () => {
    it('treats an unusable catalogue as no catalogue', () => {
        expect(parseCatalogue(null)).toEqual({});
        expect(parseCatalogue('not json')).toEqual({});
        expect(parseCatalogue('[1,2,3]')).toEqual({});
    });

    it('drops non-string values rather than rendering them', () => {
        expect(parseCatalogue('{"a":"ok","b":42,"c":null}')).toEqual({ a: 'ok' });
    });
});

describe('the stored choice', () => {
    /** setCatalogue persists without awaiting; let those writes land. */
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it('is what the Language screen saves, and what resolution reads', async () => {
        await setStoredLocale('de');
        expect(await storedLocale()).toBe('de');
    });

    it('clears with null, so the locale resolves again', async () => {
        await setStoredLocale('de');
        await setStoredLocale(null);
        expect(await storedLocale()).toBeNull();
    });

    it('is not written by installing a catalogue', async () => {
        // The bug: setCatalogue saved the RESOLVED locale under the choice's
        // key, so "follow my phone" read its own last answer back as a choice.
        setCatalogue('nl', { 'settings.appearance': 'Weergave' });
        await settle();
        expect(await storedLocale()).toBeNull();
    });

    it('still reads a choice saved under the old key, and clears it', async () => {
        // The Language screen used to write `beeflow.locale`, which nothing read.
        await AsyncStorage.setItem('beeflow.locale', 'nl');
        expect(await storedLocale()).toBe('nl');
        await setStoredLocale(null);
        expect(await storedLocale()).toBeNull();
    });
});

describe('ensureHydrated', () => {
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it('paints the cached catalogue in a launch that never mounted the root — the background poll', async () => {
        setCatalogue('nl', { 'mobile.notifications.more_waiting_plural': '{count} updates wachten nog.' });
        await settle();
        _reset();
        expect(translate('mobile.notifications.more_waiting_plural', 'x')).toBe('x');
        await ensureHydrated();
        expect(translate('mobile.notifications.more_waiting_plural', 'x')).toBe('{count} updates wachten nog.');
    });

    it('does nothing once hydrated, so a fresh catalogue is never replaced by an older copy', async () => {
        setCatalogue('nl', { a: 'oud' });
        await settle();
        _reset();
        await ensureHydrated();
        setCatalogue('nl', { a: 'nieuw' });
        await AsyncStorage.setItem('beeflow.i18n.strings.nl', JSON.stringify({ a: 'oud' }));
        await ensureHydrated();
        expect(translate('a', 'x')).toBe('nieuw');
    });
});

describe('renderedLocale', () => {
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it('is null on a device that never rendered a catalogue, not the store’s English default', async () => {
        // Before sign-in it stands in for the organisation's default; reading
        // 'en' here would outrank the phone's own language on a fresh install.
        expect(await renderedLocale()).toBeNull();
    });

    it('is the locale last installed, whoever installed it', async () => {
        setCatalogue('nl', { a: 'b' });
        await settle();
        expect(await renderedLocale()).toBe('nl');
        setCatalogue('en', {});
        await settle();
        expect(await renderedLocale()).toBe('en');
    });

    it('is not the stored choice', async () => {
        await setStoredLocale('de');
        expect(await renderedLocale()).toBeNull();
    });
});
