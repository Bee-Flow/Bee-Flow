// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { appendPhase, MAX_TRAIL_STEPS } from './phaseTrail';

/**
 * Het spoor van de fase-events, en de twee manieren waarop het stil onwaar
 * wordt:
 *
 *   • een 'end' zonder 'start' zou een stap opleveren waarvan we het begin
 *     nooit gezien hebben;
 *   • een herhaalde 'start' van dezelfde lopende fase (privacy_scan zendt er
 *     één per gescand venster) zou één scan als zes stappen tonen.
 *
 * Allebei maken ze het spoor VOLLER dan de werkelijkheid, en dat is de
 * richting die er hier toe doet.
 */

const start = (stage, detail) => ({ stage, status: 'start', detail });
const end = (stage, durationMs) => ({ stage, status: 'end', durationMs });

describe('een stap opnemen', () => {
    it('een start maakt een open rij', () => {
        const t = appendPhase(undefined, start('kb_search'), 1000);
        expect(t).toEqual([{ stage: 'kb_search', detail: null, startedAt: 1000, endedAt: null, durationMs: null }]);
    });

    it('een end sluit hem, met de duur die de SERVER mat', () => {
        // De server meet zijn eigen duur; die is nauwkeuriger dan het verschil
        // van twee kloktikken hier.
        let t = appendPhase(undefined, start('kb_search'), 1000);
        t = appendPhase(t, end('kb_search', 137), 1500);
        expect(t[0]).toMatchObject({ endedAt: 1500, durationMs: 137 });
    });

    it('zonder duur van de server valt hij terug op onze eigen klok', () => {
        let t = appendPhase(undefined, start('kb_search'), 1000);
        t = appendPhase(t, { stage: 'kb_search', status: 'end' }, 1500);
        expect(t[0].durationMs).toBe(500);
    });

    it('BIJT — een end zonder start maakt GEEN rij', () => {
        // Een afsluiting die bij niets hoort is geen stap die gebeurd is.
        expect(appendPhase(undefined, end('guardrails', 20), 1000)).toBeUndefined();
        const existing = [{ stage: 'kb_search', detail: null, startedAt: 1, endedAt: 2, durationMs: 1 }];
        expect(appendPhase(existing, end('guardrails', 20), 1000)).toBe(existing);
    });

    it('BIJT — een end op een AL GESLOTEN stap opent hem niet opnieuw', () => {
        let t = appendPhase(undefined, start('kb_search'), 1000);
        t = appendPhase(t, end('kb_search', 137), 1500);
        const after = appendPhase(t, end('kb_search', 999), 2000);
        expect(after).toBe(t);
        expect(t[0].durationMs).toBe(137);
    });
});

describe('dezelfde fase twee keer', () => {
    it('BIJT — een herhaalde start van een LOPENDE fase is één stap', () => {
        // `startPrivacyScanPhase` zendt per venster opnieuw een start met
        // detail '2/6'. Naïef opstapelen toont één scan als zes stappen — een
        // spoor met meer werk erin dan er gedaan is.
        let t = appendPhase(undefined, start('privacy_scan_large', '1/6'), 1000);
        t = appendPhase(t, start('privacy_scan_large', '2/6'), 1100);
        t = appendPhase(t, start('privacy_scan_large', '3/6'), 1200);
        expect(t).toHaveLength(1);
        expect(t[0].detail).toBe('3/6');
        expect(t[0].startedAt).toBe(1000);
    });

    it('een fase die AF was en opnieuw begint krijgt wel een eigen rij', () => {
        let t = appendPhase(undefined, start('kb_search'), 1000);
        t = appendPhase(t, end('kb_search', 10), 1010);
        t = appendPhase(t, start('kb_search'), 2000);
        expect(t).toHaveLength(2);
        expect(t[1].startedAt).toBe(2000);
    });

    it('en het tweede end sluit de tweede rij, niet de eerste opnieuw', () => {
        let t = appendPhase(undefined, start('kb_search'), 1000);
        t = appendPhase(t, end('kb_search', 10), 1010);
        t = appendPhase(t, start('kb_search'), 2000);
        t = appendPhase(t, end('kb_search', 20), 2020);
        expect(t.map(r => r.durationMs)).toEqual([10, 20]);
    });
});

describe('fases die over elkaar heen schuiven', () => {
    it('guardrails sluit ná privacy_scan, en dat einde landt gewoon', () => {
        // Op het agentpad loopt guardrails OM privacy_scan heen. De live regel
        // laat dit einde vallen (currentPhase is dan al iets anders); het spoor
        // mag dat niet doen, anders verdwijnt de duur van een echte stap.
        let t = appendPhase(undefined, start('guardrails'), 1000);
        t = appendPhase(t, start('privacy_scan'), 1010);
        t = appendPhase(t, end('privacy_scan', 40), 1050);
        t = appendPhase(t, end('guardrails', 60), 1060);
        expect(t.map(r => [r.stage, r.durationMs])).toEqual([
            ['guardrails', 60],
            ['privacy_scan', 40],
        ]);
    });
});

describe('rommel en grenzen', () => {
    it('een event zonder stage verandert niets', () => {
        const t = [{ stage: 'kb_search', detail: null, startedAt: 1, endedAt: null, durationMs: null }];
        for (const data of [null, undefined, {}, { stage: '   ' }, { stage: 5 }]) {
            expect(appendPhase(t, data, 2)).toBe(t);
        }
    });

    it('boven de bovengrens komen er geen stappen bij, maar sluiten mag nog', () => {
        let t = [];
        for (let i = 0; i < MAX_TRAIL_STEPS; i++) t = appendPhase(t, start(`s${i}`), 1000 + i);
        expect(t).toHaveLength(MAX_TRAIL_STEPS);
        const capped = appendPhase(t, start('one_too_many'), 9000);
        expect(capped).toBe(t);
        const closed = appendPhase(t, end('s0', 5), 9999);
        expect(closed[0].durationMs).toBe(5);
    });
});
