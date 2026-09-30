import { allowedByOrg, CONNECTORS, connectorLabel, INTEGRATION_CATALOG, orderCategories } from './catalog';
import { keyBadges } from './keyBadges';

describe('allowedByOrg', () => {
    it('reads null as "no restriction", never as "allow nothing"', () => {
        expect(allowedByOrg(INTEGRATION_CATALOG, null)).toBe(INTEGRATION_CATALOG);
        expect(allowedByOrg(INTEGRATION_CATALOG, undefined)).toBe(INTEGRATION_CATALOG);
    });

    it('narrows to the listed ids', () => {
        expect(allowedByOrg(INTEGRATION_CATALOG, ['gmail']).map((e) => e.id)).toEqual(['gmail']);
        expect(allowedByOrg(INTEGRATION_CATALOG, [])).toEqual([]);
    });
});

describe('connectorLabel', () => {
    it('names a connector by its provider slug, as a notification gives it', () => {
        expect(connectorLabel('google')).toBe('Google Workspace');
        expect(connectorLabel('Microsoft')).toBe('Microsoft 365');
    });

    it('has no name for a slug that is not a connector here', () => {
        expect(connectorLabel('nextcloud')).toBeNull();
        expect(connectorLabel(null)).toBeNull();
    });
});

describe('orderCategories', () => {
    it('keeps the known order and appends unknown categories rather than dropping them', () => {
        expect(orderCategories(['Social', 'Mystery', 'Google Workspace'])).toEqual([
            'Google Workspace',
            'Social',
            'Mystery',
        ]);
    });
});

describe('the catalogue', () => {
    it('has unique ids and unique connector providers', () => {
        const ids = INTEGRATION_CATALOG.map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
        const providers = CONNECTORS.map((c) => c.provider);
        expect(new Set(providers).size).toBe(providers.length);
    });
});

describe('keyBadges', () => {
    it('reports presence only, all absent without settings', () => {
        expect(keyBadges(null).every((b) => !b.present)).toBe(true);
        const badges = keyBadges({
            enabledApps: null,
            orgEnabledIntegrations: null,
            isGoogleUser: false,
            isMicrosoftUser: false,
            hasFirefliesKey: true,
            hasYouTrackConfig: false,
            hasGammaKey: false,
            hasSignRequestConfig: false,
            hasAfasConfig: false,
            hasNmbrsConfig: false,
            hasVplanConfig: false,
            hasLinkedInConfig: false,
            hasWithingsConfig: false,
            hasN8nConfig: false,
            simpleMode: false,
            userEuModeEnabled: false,
            orgEuModeForced: false,
            hasEuModelsConfigured: false,
            disableSearchOnUpload: false,
        });
        expect(badges.filter((b) => b.present).map((b) => b.label)).toEqual(['Fireflies']);
    });
});
