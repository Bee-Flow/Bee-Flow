// @vitest-environment node
/**
 * The Automations mail fixtures (condition / fan-out / flatten) carry their
 * sample subjects, file names and bodies per demo language (demo/lang.ts):
 * English by default, Dutch under ?lang=nl, and never a mix.
 *
 * Fixture modules read the language at import time, so each language gets a
 * fresh module graph.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

type Json = Record<string, any>;
type Lang = 'en' | 'nl';

async function load(lang: Lang) {
    vi.stubGlobal('window', { location: { pathname: '/__demo__/automations', search: `?lang=${lang}` } });
    vi.resetModules();
    const condition = await import('./automationsMailCondition');
    const fanout = await import('./automationsMailFanout');
    const flatten = await import('./automationsMailFlatten');
    return {
        conditionMails: (condition.MAIL_CONDITION_STEP_RESULTS.mc_read_many.output as Json).messages as Json[],
        fanoutMails: ((fanout.MAIL_FANOUT_STEP_RESULTS.mf_read.output as Json).results as Json[]).map(r => r.output as Json),
        fanoutPdfText: JSON.stringify(fanout.MAIL_FANOUT_STEP_RESULTS.mf_read_attachment.output),
        fanoutQuery: (fanout.MAIL_FANOUT_STEP_RESULTS.mf_search.output as Json).query as string,
        fanoutCatalog: JSON.stringify(fanout.MAIL_FANOUT_CATALOG_APP),
        flattenMails: (flatten.MAIL_FLATTEN_STEP_RESULTS.mf_read_many.output as Json).messages as Json[],
        flattenQuery: (flatten.MAIL_FLATTEN_STEP_RESULTS.mf_find.input as Json).query as string,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('automations mail fixtures, English', () => {
    it('has English subjects, file names, queries and bodies', async () => {
        const d = await load('en');
        expect(d.conditionMails.map(m => m.subject)).toEqual([
            'Your Fabrikam invoice F-2026-0917', 'Cleaning quote Q4', 'New rates and terms 2027', 'Your Fabrikam invoice F-2026-0630',
        ]);
        expect(d.conditionMails[0].attachments.map((a: Json) => a.filename)).toEqual(['Invoice_F-2026-0917.pdf', 'Specification_F-2026-0917.docx', 'Fabrikam_logo.png']);
        expect(d.conditionMails[0].body).toMatch(/^Dear customer,/);
        expect(new Set(d.fanoutMails.map(m => m.subject))).toEqual(new Set(['Your Fabrikam invoice']));
        expect(d.fanoutMails[0].body).toMatch(/^Dear customer,/);
        expect(d.fanoutMails[0].attachments.some((a: Json) => a.filename === 'Invoice_F-2026-0917.pdf')).toBe(true);
        expect(d.fanoutPdfText).toContain('INVOICE F-2026-0917');
        expect(d.fanoutPdfText).toContain('Total incl. tax');
        expect(d.fanoutQuery).toBe('from:fabrikam.example invoice');
        expect(d.fanoutCatalog).toContain('January invoice');
        expect(d.flattenMails[1].subject).toBe('Your Fabrikam invoice F-2026-1003');
        expect(d.flattenMails[1].body).toMatch(/^Dear customer,/);
        expect(d.flattenQuery).toBe('has:attachment invoice newer_than:30d');
    });
});

describe('automations mail fixtures, Dutch', () => {
    it('has Dutch subjects, file names, queries and bodies', async () => {
        const d = await load('nl');
        expect(d.conditionMails.map(m => m.subject)).toEqual([
            'Je Fabrikam factuur F-2026-0917', 'Offerte schoonmaak Q4', 'Nieuwe tarieven en voorwaarden 2027', 'Je Fabrikam factuur F-2026-0630',
        ]);
        expect(d.conditionMails[0].attachments.map((a: Json) => a.filename)).toEqual(['Factuur_F-2026-0917.pdf', 'Specificatie_F-2026-0917.docx', 'Fabrikam_logo.png']);
        expect(d.conditionMails[0].body).toMatch(/^Beste klant,/);
        expect(new Set(d.fanoutMails.map(m => m.subject))).toEqual(new Set(['Je Fabrikam factuur']));
        expect(d.fanoutMails[0].body).toMatch(/^Beste klant,/);
        expect(d.fanoutMails[0].attachments.some((a: Json) => a.filename === 'Factuur_F-2026-0917.pdf')).toBe(true);
        expect(d.fanoutPdfText).toContain('FACTUUR F-2026-0917');
        expect(d.fanoutQuery).toBe('from:fabrikam.example factuur');
        expect(d.fanoutCatalog).toContain('Factuur januari');
        expect(d.flattenMails[1].subject).toBe('Je Fabrikam factuur F-2026-1003');
        expect(d.flattenMails[1].body).toMatch(/^Beste klant,/);
        expect(d.flattenQuery).toBe('has:attachment factuur newer_than:30d');
    });
});
