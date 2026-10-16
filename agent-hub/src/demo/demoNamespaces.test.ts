/**
 * Each public demo loads only the English namespaces it renders (issue #252).
 * A namespace missing from the list is harmless (t() falls back to the string
 * written at the call site) but a typo would silently load nothing, and a
 * demo that lists the 1.9 MB learning-centre namespace defeats the point.
 */
import { describe, it, expect } from 'vitest';
import { DEMO_FEATURE_IDS } from './registry';
import { DEMO_NAMESPACES, namespacesForDemo, namespacesForPath } from './demoNamespaces';
import { knownEnNamespaces } from '../i18n/enNamespaces';

describe('DEMO_NAMESPACES', () => {
    it('only lists namespaces that exist', () => {
        const known = new Set(knownEnNamespaces());
        for (const [id, list] of Object.entries(DEMO_NAMESPACES)) {
            for (const ns of list) expect(known.has(ns), `${id}: ${ns}`).toBe(true);
        }
    });

    it('only describes registered demos, and never the learning centre', () => {
        for (const [id, list] of Object.entries(DEMO_NAMESPACES)) {
            expect(DEMO_FEATURE_IDS).toContain(id);
            expect(list).not.toContain('learn');
        }
    });

    it('returns undefined for a demo without a list, meaning load everything', () => {
        expect(namespacesForDemo('not-a-demo')).toBeUndefined();
        expect(namespacesForDemo('support')).toContain('support');
    });
});

describe('namespacesForPath', () => {
    it('maps a demo address to its namespaces and anything else to undefined', () => {
        expect(namespacesForPath('/__demo__/support')).toEqual(namespacesForDemo('support'));
        expect(namespacesForPath('/__demo__/support/')).toEqual(namespacesForDemo('support'));
        expect(namespacesForPath('/__demo__/not-a-demo')).toBeUndefined();
        expect(namespacesForPath('/app/settings')).toBeUndefined();
        expect(namespacesForPath(undefined)).toBeUndefined();
    });
});
