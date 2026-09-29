// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { getIntegrationLogo } from './integrationLogos.jsx';
import { NEXTCLOUD_INTEGRATION_IDS } from '../config/integrationCatalog.js';

describe('getIntegrationLogo', () => {
    it('resolves a logo for the outlook-readonly catalog id', () => {
        expect(getIntegrationLogo('outlook-readonly')).not.toBeNull();
    });

    it('renders the identical Outlook brand component for the readonly variant', () => {
        expect(getIntegrationLogo('outlook-readonly')).toBe(getIntegrationLogo('outlook'));
    });
    // ── Drift guard ─────────────────────────────────────────────────────────
    //
    // The map is hand-written and the catalog is not, so the two drift the
    // moment a Nextcloud integration is added. That already happened: Tables,
    // Forms and Teams reached the catalog (and the automation Apps ribbon)
    // with no entry here, so those three rendered with no icon at all while
    // their eleven siblings showed the Nextcloud mark — visible to anyone
    // opening the ribbon, invisible to the suite.
    //
    // Scoped to the Nextcloud family on purpose: they all share one avatar,
    // so "has a logo" is a complete requirement for them. Other integrations
    // may legitimately fall back to the letter mark in INTEGRATION_META.
    it('has a logo for every Nextcloud integration in the catalog', () => {
        const missing = [...NEXTCLOUD_INTEGRATION_IDS].filter(id => !getIntegrationLogo(id));
        expect(missing).toEqual([]);
    });

    it('gives every Nextcloud sub-app the same official mark', () => {
        const files = getIntegrationLogo('nextcloud');
        for (const id of NEXTCLOUD_INTEGRATION_IDS) {
            expect(getIntegrationLogo(id)).toBe(files);
        }
    });
});
