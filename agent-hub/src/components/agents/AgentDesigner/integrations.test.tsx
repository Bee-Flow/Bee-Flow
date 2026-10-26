// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { filterAvailableIntegrations } from './integrationAvailability';
import { INTEGRATION_CATALOG } from './integrations';
import { INTEGRATION_CATALOG as CANONICAL } from '@/config/integrationCatalog';

/**
 * The app catalogue of the agent surfaces is DERIVED.
 *
 * This suite exists to keep the fork from coming back: it fails as soon as someone
 * starts a separate list here again, and it fails in the way the previous fork
 * stayed silent — an app that exists on one side and not on the other.
 */

describe('de agent-catalogus is de canonieke catalogus', () => {
    it('mist geen enkele app uit de canonieke lijst', () => {
        const ours = new Set(INTEGRATION_CATALOG.map(i => i.id));
        const missing = CANONICAL.map(i => i.id).filter(id => !ours.has(id));
        expect(missing).toEqual([]);
        expect(INTEGRATION_CATALOG).toHaveLength(CANONICAL.length);
    });

    it('kent Nextcloud — de apps die de oude vork jarenlang verzweeg', () => {
        const ids = INTEGRATION_CATALOG.map(i => i.id);
        expect(ids).toContain('nextcloud');
        expect(ids).toContain('nextcloud-talk');
        expect(ids).toContain('nextcloud-tables');
        // En de andere weeskinderen van diezelfde lijst.
        expect(ids).toContain('github');
        expect(ids).toContain('signrequest');
    });

    it('geeft elke app een naam, een omschrijving en een icoon', () => {
        for (const item of INTEGRATION_CATALOG) {
            expect(typeof item.label).toBe('string');
            expect(item.label.length).toBeGreaterThan(0);
            expect(typeof item.description).toBe('string');
            expect(item.iconSvg).toBeTruthy();
        }
    });
});

describe('`group` is een poort, geen rubriek', () => {
    const byId = new Map(INTEGRATION_CATALOG.map(i => [i.id, i]));

    it('zet precies de Google-OAuth-apps op "google"', () => {
        const google = INTEGRATION_CATALOG.filter(i => i.group === 'google').map(i => i.id).sort();
        expect(google).toEqual([
            'gmail', 'google-calendar', 'google-contacts', 'google-docs', 'google-drive',
            'google-groups', 'google-keep', 'google-sheets', 'google-slides',
        ]);
    });

    it('houdt Google Maps BUITEN die poort — hij draait op een serversleutel, niet op je login', () => {
        // Uit de rubriek afleiden zou hem verbergen voor iedereen die niet met
        // Google inlogde, terwijl juist die mensen hem kunnen gebruiken.
        expect(byId.get('maps')!.category).toBe('Google Workspace');
        expect(byId.get('maps')!.group).not.toBe('google');

        const forNonGoogleUser = filterAvailableIntegrations(INTEGRATION_CATALOG, { isGoogleUser: false })
            .map(i => i.id);
        expect(forNonGoogleUser).toContain('maps');
        expect(forNonGoogleUser).not.toContain('gmail');
    });
});
