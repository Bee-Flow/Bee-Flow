// @vitest-environment node
/**
 * The area meta every usage surface reads: one entry per area of the shared
 * vocabulary, a fixed chart slot per series area assigned in AREA order (no
 * slot used twice, none cycled), the neutral ink for the rest, and a ledger
 * source named by its area.
 */
import { describe, expect, it } from 'vitest';
import { AREA_IDS, SOURCES } from '@/shared/usageAreas.generated.mjs';
import { getSourceDetails as adminSourceDetails } from '@/components/admin/monitoring/shared';
import { getSourceDetails as settingsSourceDetails } from '@/pages/settings/usage/widgets';
import { AREA_NEUTRAL, AREA_ORDER, SERIES_AREAS, areaMeta, seriesAreaOf, usageSourceDetails } from './usageAreaMeta';

describe('areaMeta', () => {
    it('knows every area of the vocabulary, in its order', () => {
        expect(AREA_ORDER).toEqual(AREA_IDS);
        for (const id of AREA_IDS) {
            const m = areaMeta(id);
            expect(m.id).toBe(id);
            expect(m.labelKey).toBe(`adoption.area_${id}`);
            expect(m.label).not.toBe('');
        }
    });

    it('gives the series areas the eight chart slots in AREA order and every other area the neutral ink', () => {
        expect(SERIES_AREAS.length).toBe(8);
        expect(SERIES_AREAS.map(id => AREA_ORDER.indexOf(id))).toEqual([...SERIES_AREAS.map(id => AREA_ORDER.indexOf(id))].sort((a, b) => a - b));
        expect(SERIES_AREAS.map(id => areaMeta(id).color)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(n => `var(--chart-${n})`));
        for (const id of AREA_ORDER.filter(a => !SERIES_AREAS.includes(a))) {
            expect(areaMeta(id).color).toBe(AREA_NEUTRAL);
            expect(seriesAreaOf(id)).toBe('other');
        }
        expect(areaMeta('other').seriesIndex).toBeNull();
    });

    it('reads an unknown area as other, and translates through t', () => {
        expect(areaMeta('nope').id).toBe('other');
        expect(areaMeta('agents', (k, fb) => `${k}|${fb}`).label).toBe('adoption.area_agents|Agents');
    });
});

describe('usageSourceDetails', () => {
    it('names every known source by its area', () => {
        for (const [source, { area }] of Object.entries(SOURCES)) {
            const d = usageSourceDetails(source);
            expect(d.area).toBe(area);
            if (area !== 'other') expect(d.label).toBe(areaMeta(area).label);
        }
        expect(usageSourceDetails('studio_app_ai').label).toBe('Apps');
        expect(usageSourceDetails('cowork').label).toBe('Cowork');
    });

    it('keeps the raw name of a source it does not know, and reads the old literals as their area', () => {
        expect(usageSourceDetails('brand_new_thing')).toMatchObject({ label: 'brand_new_thing', area: 'other' });
        expect(usageSourceDetails('direct').label).toBe('Direct chat');
        expect(usageSourceDetails(null).label).toBe('Other');
    });

    it('is what both dashboards\' getSourceDetails answer', () => {
        expect(settingsSourceDetails('meeting_summary')).toEqual(usageSourceDetails('meeting_summary'));
        expect(adminSourceDetails('meeting_summary')).toEqual(usageSourceDetails('meeting_summary'));
        expect(settingsSourceDetails('agent_stream').label).toBe('Agents');
    });
});
