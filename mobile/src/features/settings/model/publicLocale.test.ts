/**
 * Which language the sign-in screens speak before there is a session: the
 * person's choice, else what this phone last rendered (the account's language
 * the last time), else the phone's own — among what the server offers — and
 * nothing at all when the server's answer is not an answer.
 */

import { loadPublicCatalogue, wantsPublicCatalogue, type PublicCatalogueSources } from './publicLocale';

const OFFERED = [{ code: 'en' }, { code: 'nl' }, { code: 'de' }, { code: 'fr' }];
const DUTCH = { 'login.password': 'Wachtwoord' };

function sources(overrides: Partial<PublicCatalogueSources> = {}) {
    const fetchStrings = jest.fn(async (locale: string) => (locale === 'nl' ? DUTCH : { 'login.password': `(${locale})` }));
    return {
        fetchStrings,
        src: {
            stored: null,
            lastRendered: null,
            device: 'en',
            listLocales: async () => OFFERED,
            fetchStrings,
            ...overrides,
        } satisfies PublicCatalogueSources,
    };
}

describe('loadPublicCatalogue', () => {
    it('speaks the phone’s language on a fresh install — the Dutch colleague’s first sign-in', async () => {
        const { src, fetchStrings } = sources({ device: 'nl' });
        expect(await loadPublicCatalogue(src)).toEqual({ locale: 'nl', strings: DUTCH });
        expect(fetchStrings).toHaveBeenCalledWith('nl');
    });

    it('puts the person’s own choice first', async () => {
        const { src } = sources({ stored: 'de', lastRendered: 'nl', device: 'fr' });
        expect(await loadPublicCatalogue(src)).toEqual({ locale: 'de', strings: { 'login.password': '(de)' } });
    });

    it('keeps the language the account last rendered over the phone’s, so a sign-out does not flip it', async () => {
        // The organisation's default is not served without a session; the
        // locale last rendered here is what it resolved to.
        const { src } = sources({ lastRendered: 'nl', device: 'fr' });
        expect((await loadPublicCatalogue(src))?.locale).toBe('nl');
    });

    it('is English, fetched from nowhere, when that is what resolves', async () => {
        const { src, fetchStrings } = sources({ device: 'es' });
        expect(await loadPublicCatalogue(src)).toEqual({ locale: 'en', strings: {} });
        expect(fetchStrings).not.toHaveBeenCalled();
    });

    it('never asks for a locale the server does not offer', async () => {
        const { src, fetchStrings } = sources({ stored: 'es', lastRendered: 'pt', device: 'nl' });
        expect((await loadPublicCatalogue(src))?.locale).toBe('nl');
        expect(fetchStrings).toHaveBeenCalledTimes(1);
        expect(fetchStrings).toHaveBeenCalledWith('nl');
    });

    it('stays English when the server has no strings for the locale after all (its 404)', async () => {
        const { src } = sources({ device: 'nl', fetchStrings: async () => null });
        expect(await loadPublicCatalogue(src)).toEqual({ locale: 'en', strings: {} });
    });

    it('has no answer when the list is empty — a captive portal, not a server with no languages', async () => {
        const { src, fetchStrings } = sources({ device: 'nl', listLocales: async () => [] });
        expect(await loadPublicCatalogue(src)).toBeNull();
        expect(fetchStrings).not.toHaveBeenCalled();
    });

    it('lets a failed fetch fail, for the caller to leave the cached catalogue alone', async () => {
        const { src } = sources({
            device: 'nl',
            fetchStrings: async () => {
                throw new Error('offline');
            },
        });
        await expect(loadPublicCatalogue(src)).rejects.toThrow('offline');
    });
});

describe('wantsPublicCatalogue', () => {
    it('covers every step before a full session', () => {
        for (const kind of [
            'signed-out',
            'mfa-required',
            'mfa-setup-required',
            'email-verification-required',
            'encryption-setup-required',
            'encryption-pin-required',
            'pending-approval',
        ] as const) {
            expect({ kind, wants: wantsPublicCatalogue(kind) }).toEqual({ kind, wants: true });
        }
    });

    it('leaves the signed-in catalogue, the lock screen and the stages with no server to ask alone', () => {
        for (const kind of ['signed-in', 'locked', 'loading', 'needs-server', 'unreachable'] as const) {
            expect({ kind, wants: wantsPublicCatalogue(kind) }).toEqual({ kind, wants: false });
        }
    });
});
