import { describe, expect, it } from 'vitest';

import { INTEGRATION_CATALOG } from './integrationCatalog';
import { canonicalIntegrationId, listHasIntegration } from './integrationIdAliases';

describe('integration id aliases', () => {
    it('maps the legacy Google Maps id onto the catalogue id', () => {
        expect(canonicalIntegrationId('google-maps')).toBe('maps');
        expect(canonicalIntegrationId('maps')).toBe('maps');
        expect(canonicalIntegrationId('n8n')).toBe('n8n');
    });

    it('finds an integration under either id', () => {
        expect(listHasIntegration(['n8n', 'maps'], 'maps')).toBe(true);
        expect(listHasIntegration(['n8n', 'google-maps'], 'maps')).toBe(true);
        expect(listHasIntegration(['n8n', 'maps'], 'google-maps')).toBe(true);
        expect(listHasIntegration(['n8n'], 'maps')).toBe(false);
        expect(listHasIntegration(null, 'maps')).toBe(false);
    });

    it('every canonical id is a catalogue id', () => {
        const ids = new Set(INTEGRATION_CATALOG.map((e) => e.id));
        expect(ids.has(canonicalIntegrationId('google-maps'))).toBe(true);
        expect(ids.has('google-maps')).toBe(false);
    });
});
