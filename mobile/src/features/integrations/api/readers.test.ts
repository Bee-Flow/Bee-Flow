import { readAuthUrl, readGithubConnect, readIntegrationStatus, readUserSettings } from './readers';

describe('readIntegrationStatus', () => {
    it('reads whichever of the five shapes a provider sends', () => {
        expect(readIntegrationStatus({ connected: true, username: 'octo' })).toEqual({
            connected: true,
            configured: undefined,
            needsReauth: undefined,
            email: null,
            name: null,
            username: 'octo',
        });
        expect(readIntegrationStatus({ configured: false })?.configured).toBe(false);
        expect(readIntegrationStatus(null)).toBeNull();
    });
});

describe('readUserSettings', () => {
    it('keeps a null allow-list as "no explicit list", never as "nothing allowed"', () => {
        const settings = readUserSettings({ enabledApps: null, orgEnabledIntegrations: ['gmail'], hasGammaKey: true });
        expect(settings?.enabledApps).toBeNull();
        expect(settings?.orgEnabledIntegrations).toEqual(['gmail']);
        expect(settings?.hasGammaKey).toBe(true);
        expect(settings?.hasFirefliesKey).toBe(false);
    });

    it('reads a missing allow-list as null too', () => {
        expect(readUserSettings({})?.enabledApps).toBeNull();
    });
});

describe('the connect readers', () => {
    it('reads the OAuth URL, or null when there is none', () => {
        expect(readAuthUrl({ url: 'https://accounts.example/auth' })).toBe('https://accounts.example/auth');
        expect(readAuthUrl({})).toBeNull();
        expect(readAuthUrl(null)).toBeNull();
    });

    it('reads the GitHub handle', () => {
        expect(readGithubConnect({ username: 'octo' })).toEqual({ username: 'octo' });
        expect(readGithubConnect(null)).toBeNull();
    });
});
