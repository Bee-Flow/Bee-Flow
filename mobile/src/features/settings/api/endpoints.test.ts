/**
 * The two public language endpoints the sign-in screens depend on, held to the
 * server's own route file: they answer without a session, and a locale the
 * server does not offer is a 404 — which the phone reads as "English", not as
 * a failure.
 */

import fs from 'node:fs';
import path from 'node:path';

import { api, ApiError } from '@/core/api/client';

import { getPublicLocaleStrings, listPublicLocales } from './endpoints';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const ROUTES = fs.readFileSync(
    path.resolve(__dirname, '../../../../../server/routes/admin/languageRoutes.js'),
    'utf8',
);

beforeEach(() => get.mockReset());

describe('the public language endpoints', () => {
    it('lists the locales without a session', async () => {
        get.mockResolvedValue([{ code: 'nl', name: 'Nederlands' }]);
        expect(await listPublicLocales()).toEqual([{ code: 'nl', name: 'Nederlands', isOrgDefault: undefined, enabled: undefined }]);
        expect(get).toHaveBeenCalledWith('/api/languages/public/locales', { signal: undefined });
    });

    it('reads a 404 as "no strings for that locale", and anything unreadable as a failure', async () => {
        get.mockRejectedValueOnce(new ApiError('Locale not available', { status: 404 }));
        expect(await getPublicLocaleStrings('nl')).toBeNull();

        get.mockResolvedValueOnce('<html>captive portal</html>');
        await expect(getPublicLocaleStrings('nl')).rejects.toThrow();

        get.mockRejectedValueOnce(new ApiError('HTTP 502', { status: 502 }));
        await expect(getPublicLocaleStrings('nl')).rejects.toThrow('HTTP 502');

        get.mockResolvedValueOnce({ 'login.password': 'Wachtwoord', broken: 1 });
        expect(await getPublicLocaleStrings('nl')).toEqual({ 'login.password': 'Wachtwoord' });
        expect(get).toHaveBeenLastCalledWith('/api/languages/public/strings/nl', { signal: undefined });
    });

    it('are still public on the server, with the 404 the phone relies on', () => {
        // No `requireAuth` on either line: the sign-in screens have no session to send.
        expect(ROUTES).toContain("router.get('/public/locales', async (req, res) => {");
        expect(ROUTES).toContain("router.get('/public/strings/:locale', async (req, res) => {");
        expect(ROUTES).toContain("return res.status(404).json({ error: 'Locale not available' });");
    });
});
