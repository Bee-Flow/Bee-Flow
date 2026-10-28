/**
 * Every registered demo, in English and in Dutch, must keep its SAMPLE DATA in
 * the language of the page that frames it (?lang=). The UI chrome follows the
 * app's own i18n; this pins the fixtures:
 *
 *   - no copy that was written for the other language leaks into the state;
 *   - an English demo carries no Dutch words (a small heuristic list);
 *   - no locale-tied person or organisation names (Dutch surname particles,
 *     legal-form suffixes): fixture people are neutral names.
 *
 * Fixture modules read the language at import time, so each language gets a
 * fresh module graph (vi.resetModules).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

type Lang = 'en' | 'nl';

// Words that are Dutch and not English. Quoted passages are removed first: a
// fixture may legitimately quote a Dutch phrase when it is ABOUT Dutch writing.
const DUTCH_WORDS = /\b(het|een|niet|wordt|geen|kunt|graag|bijlage|klant|klanten|polis|schade|factuur|afdeling|vriendelijke|groet|medewerkers|werkplek|leveranciers|eisen|verwerking|verwerkersovereenkomst|aanbesteding|antwoord|contractvragen|beantwoordt|kennisbank)\b/i;
const LOCALE_TIED_NAMES = /\b(?:de|van|ten|ter)\s+[A-Z][a-z]+|\bB\.V\.|\bN\.V\.|Assurantie/;

const FEATURES = ['agents', 'app-studio', 'automations', 'compliance', 'knowledge', 'meeting-notes', 'monitoring', 'notebooks', 'privacy-shield', 'skills', 'support'] as const;

function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
    return out;
}

const unquoted = (text: string) => text.replace(/"[^"]*"|“[^”]*”/g, ' ');

/** Fresh module graph for one language; returns the rejected copy that pick() saw. */
async function load(lang: Lang) {
    window.history.replaceState({}, '', `/__demo__/x?lang=${lang}`);
    vi.resetModules();
    const rejected: string[] = [];
    const chosen = new Set<string>();
    const { observePicks } = await import('./lang');
    observePicks((picked, other) => {
        strings(picked).forEach((s) => chosen.add(s));
        strings(other).filter((s) => s.length >= 6).forEach((s) => rejected.push(s));
    });
    // Copy that both languages share (a quoted salutation, a code) is not a leak.
    return { get rejected() { return [...new Set(rejected)].filter((s) => !chosen.has(s)); } };
}

afterEach(() => {
    window.history.replaceState({}, '', '/');
});

describe.each(['en', 'nl'] as const)('demo sample data in %s', (lang) => {
    it.each(FEATURES)('%s: no copy of the other language, no locale-tied names', async (id) => {
        const loaded = await load(lang);
        const { DEMO_FEATURES } = await import('./registry');
        const feature = (DEMO_FEATURES as Record<string, { loadFixtures: () => Promise<{ createState: () => object }> }>)[id];
        const state = (await feature.loadFixtures()).createState();
        const all = strings(state);
        const blob = all.join('\n');

        // Short copy must not appear as a whole value; long copy not even inside one.
        const values = new Set(all);
        for (const text of loaded.rejected) {
            const leaked = values.has(text) || (text.length >= 40 && blob.includes(text));
            expect(leaked, `${id}/${lang} carries copy of the other language: ${text.slice(0, 60)}`).toBe(false);
        }
        for (const text of all) {
            // Names are short strings; running prose may legitimately say "de" or "van".
            if (text.length < 40) expect(text, `${id}/${lang}`).not.toMatch(LOCALE_TIED_NAMES);
            if (lang === 'en') {
                expect(unquoted(text), `${id}/en has a Dutch word`).not.toMatch(DUTCH_WORDS);
            }
        }
    });
});

describe.each(['en', 'nl'] as const)('rendered demo in %s', (lang) => {
    it.each(FEATURES)('%s renders its sample data in the page language', async (id) => {
        const loaded = await load(lang);
        const { render, waitFor, cleanup } = await import('@testing-library/react');
        const React = await import('react');
        const { default: DemoHost } = await import('./DemoHost');
        const { DEMO_FEATURES } = await import('./registry');
        const expected = (DEMO_FEATURES as Record<string, { expectText: string }>)[id].expectText;
        try {
            render(React.createElement(DemoHost, { feature: id }));
            await waitFor(() => expect(document.body.textContent).toContain(expected), { timeout: 30_000 });
            await new Promise((r) => setTimeout(r, 300));
            const text = document.body.textContent || '';
            for (const other of loaded.rejected) {
                if (other.length < 40) continue;
                expect(text.includes(other), `${id}/${lang} shows copy of the other language: ${other.slice(0, 60)}`).toBe(false);
            }
            if (lang === 'en') expect(unquoted(text)).not.toMatch(DUTCH_WORDS);
        } finally {
            cleanup();
        }
    }, 45_000);
});
