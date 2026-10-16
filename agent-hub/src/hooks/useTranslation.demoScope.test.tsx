/**
 * A public feature demo (/__demo__/<id>) loads only the English namespaces it
 * renders, not the whole catalogue (issue #252). Anywhere else
 * ensureI18nDefaults() still loads everything.
 *
 * The test setup already filled the shared module's catalogue, so each case
 * imports a fresh copy of the hook module (vi.resetModules) and reads it
 * through the provider-less t().
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => window.history.replaceState({}, '', '/'));

async function freshT(path: string) {
    window.history.replaceState({}, '', path);
    vi.resetModules();
    const mod = await import('./useTranslation');
    await mod.ensureI18nDefaults();
    return renderHook(() => mod.useTranslation()).result.current.t;
}

describe('ensureI18nDefaults on a demo address', () => {
    it('resolves keys of the demo namespaces and not the others', async () => {
        const t = await freshT('/__demo__/monitoring');
        expect(t('chat.send', 'FALLBACK')).not.toBe('FALLBACK');
        expect(t('learn.nothing_real_but_scoped_out', 'FALLBACK')).toBe('FALLBACK');
        expect(t('compliance.nav_overview', 'FALLBACK')).toBe('FALLBACK');
    });

    it('loads everything away from a demo', async () => {
        const t = await freshT('/app');
        expect(t('chat.send', 'FALLBACK')).not.toBe('FALLBACK');
        expect(t('compliance.nav_overview', 'FALLBACK')).not.toBe('FALLBACK');
    });
});
