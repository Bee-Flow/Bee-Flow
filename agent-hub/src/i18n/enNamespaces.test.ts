// @vitest-environment node
/**
 * The English dictionary is also published one namespace at a time
 * (src/i18n/en/<ns>.generated.mjs) so the public feature demos can load a few
 * dozen keys instead of the whole 3.9 MB catalogue (issue #252).
 */
import { describe, it, expect } from 'vitest';
import EN_DEFAULTS from './en-defaults';
import { loadEnNamespaces, knownEnNamespaces } from './enNamespaces';

describe('loadEnNamespaces', () => {
    it('returns only the keys of the requested namespaces', async () => {
        const cat = await loadEnNamespaces(['support', 'time']);
        const keys = Object.keys(cat);
        expect(keys.length).toBeGreaterThan(0);
        expect(keys.every((k) => k.startsWith('support.') || k.startsWith('time.'))).toBe(true);
    });

    it('agrees with the full dictionary for every key it returns', async () => {
        const cat = await loadEnNamespaces(['support']);
        for (const [k, v] of Object.entries(cat)) expect(EN_DEFAULTS[k as keyof typeof EN_DEFAULTS]).toBe(v);
        const want = Object.keys(EN_DEFAULTS).filter((k) => k.startsWith('support.'));
        expect(Object.keys(cat).sort()).toEqual(want.sort());
    });

    it('skips an unknown namespace instead of failing', async () => {
        expect(await loadEnNamespaces(['no_such_namespace'])).toEqual({});
    });

    it('knows every namespace, including the big learning-centre one that demos skip', () => {
        expect(knownEnNamespaces()).toContain('learn');
    });
});
