// @vitest-environment node
/**
 * buildSummaryStamp — met welk sjabloon (en welke versie) is deze notitie
 * geschreven, en wanneer zeggen we niets.
 *
 * Run: cd agent-hub && npx vitest run src/pages/meeting-notes/lib/summaryStamp.test.js
 */

import { describe, it, expect } from 'vitest';
import { buildSummaryStamp, SUMMARY_STAMP } from './summaryStamp';

const TEMPLATES = {
    builtins: [
        { id: 'general', name: 'General meeting', nameKey: 'meeting_notes.template_general' },
        { id: 'standup', name: 'Stand-up', nameKey: 'meeting_notes.template_standup' },
    ],
    custom: [
        { id: 'tpl-9', name: 'Board summary', version: 9 },
    ],
};

describe('geen stempel = geen bewering', () => {
    it('een notitie van vóór deze kolommen toont niets — géén v1', () => {
        const stamp = buildSummaryStamp({ id: 'm-1' }, TEMPLATES);
        expect(stamp.state).toBe(SUMMARY_STAMP.NONE);
        expect(stamp.version).toBeNull();
        expect(stamp.name).toBeNull();
    });

    it('een leeg of onleesbaar id telt niet als sjabloon', () => {
        for (const raw of [null, undefined, '', '   ', 42, {}, 'builtin:']) {
            expect(buildSummaryStamp({ summaryTemplateId: raw }, TEMPLATES).state).toBe(SUMMARY_STAMP.NONE);
        }
    });

    it('een versie zonder sjabloon-id blijft onzichtbaar', () => {
        // Anders zou "(v4)" los op het scherm komen, zonder te zeggen waarvan.
        const stamp = buildSummaryStamp({ summaryTemplateVersion: 4 }, TEMPLATES);
        expect(stamp.state).toBe(SUMMARY_STAMP.NONE);
        expect(stamp.version).toBeNull();
    });
});

describe('de sjabloonlijst is er nog niet', () => {
    it('een stempel zonder lijst is LOADING, niet GONE', () => {
        // "Bestaat niet meer" zeggen over een sjabloon dat er gewoon is, is
        // erger dan even niets zeggen.
        const stamp = buildSummaryStamp({ summaryTemplateId: 'tpl-9', summaryTemplateVersion: 2 }, null);
        expect(stamp.state).toBe(SUMMARY_STAMP.LOADING);
    });

    it('een onleesbare lijst telt als niet-geladen, niet als lege lijst', () => {
        for (const bad of [{}, { custom: 'nope', builtins: 3 }, { custom: null }]) {
            expect(buildSummaryStamp({ summaryTemplateId: 'tpl-9' }, bad).state).toBe(SUMMARY_STAMP.LOADING);
            expect(buildSummaryStamp({ summaryTemplateId: 'builtin:standup' }, bad).state).toBe(SUMMARY_STAMP.LOADING);
        }
    });
});

describe('ingebouwde sjablonen', () => {
    it('leveren naam en sleutel, en geen versie', () => {
        const stamp = buildSummaryStamp({ summaryTemplateId: 'builtin:standup' }, TEMPLATES);
        expect(stamp.state).toBe(SUMMARY_STAMP.BUILTIN);
        expect(stamp.name).toBe('Stand-up');
        expect(stamp.nameKey).toBe('meeting_notes.template_standup');
        expect(stamp.version).toBeNull();
    });

    it('krijgen geen versie, ook niet als de notitie er toch een draagt', () => {
        // Ingebouwde sjablonen leven in code; er is niets om te versienummeren.
        const stamp = buildSummaryStamp({ summaryTemplateId: 'builtin:general', summaryTemplateVersion: 3 }, TEMPLATES);
        expect(stamp.version).toBeNull();
    });

    it('een sleutel die de server niet kent is GONE, geen verzonnen naam', () => {
        const stamp = buildSummaryStamp({ summaryTemplateId: 'builtin:verdwenen' }, TEMPLATES);
        expect(stamp.state).toBe(SUMMARY_STAMP.GONE);
        expect(stamp.name).toBeNull();
    });
});

describe('opgeslagen sjablonen', () => {
    it('leveren de naam van nu en de versie van toen', () => {
        // Dit is de hele reden dat de versie op de notitie staat: het sjabloon
        // is inmiddels v9, deze samenvatting is met v2 geschreven.
        const stamp = buildSummaryStamp({ summaryTemplateId: 'tpl-9', summaryTemplateVersion: 2 }, TEMPLATES);
        expect(stamp.state).toBe(SUMMARY_STAMP.CUSTOM);
        expect(stamp.name).toBe('Board summary');
        expect(stamp.version).toBe(2);
    });

    it('nemen NOOIT de versie van de sjabloonrij over', () => {
        const stamp = buildSummaryStamp({ summaryTemplateId: 'tpl-9' }, TEMPLATES);
        expect(stamp.state).toBe(SUMMARY_STAMP.CUSTOM);
        expect(stamp.version).toBeNull();
        expect(stamp.version).not.toBe(9);
    });

    it('weigeren een versie die geen positief geheel getal is', () => {
        for (const bad of ['2', 0, -1, 2.5, NaN, null]) {
            const stamp = buildSummaryStamp({ summaryTemplateId: 'tpl-9', summaryTemplateVersion: bad }, TEMPLATES);
            expect(stamp.state).toBe(SUMMARY_STAMP.CUSTOM);
            expect(stamp.version).toBeNull();
        }
    });

    it('een verwijderd of onzichtbaar sjabloon is GONE — versie bekend, naam niet', () => {
        const stamp = buildSummaryStamp({ summaryTemplateId: 'tpl-weg', summaryTemplateVersion: 5 }, TEMPLATES);
        expect(stamp.state).toBe(SUMMARY_STAMP.GONE);
        expect(stamp.name).toBeNull();
        expect(stamp.version).toBe(5);
    });

    it('een rij zonder bruikbare naam is GONE, niet een lege naam', () => {
        const templates = { builtins: [], custom: [{ id: 'tpl-9', name: '   ' }] };
        const stamp = buildSummaryStamp({ summaryTemplateId: 'tpl-9', summaryTemplateVersion: 5 }, templates);
        expect(stamp.state).toBe(SUMMARY_STAMP.GONE);
        expect(stamp.name).toBeNull();
    });
});
