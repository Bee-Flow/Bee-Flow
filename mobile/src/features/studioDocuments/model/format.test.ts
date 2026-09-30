import { createRequestFor } from './create';
import { conditionText, docIcon, docTypeLabel, fileNameFor, kindLabel, kindTabLabel, operatorLabel, paramTypeLabel, sectionStateLabel } from './format';
import { editorTabs, saveStatus } from './tabs';

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    Object.entries(params ?? {}).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), fallback);

describe('labels', () => {
    it('names types, kinds and views in the web’s words', () => {
        expect(['invoice', 'quote', 'letter', 'report', 'presentation', 'security', 'document', 'x'].map((d) => docTypeLabel(t, d))).toEqual([
            'Invoice',
            'Quote',
            'Letter',
            'Report',
            'Presentation',
            'Security',
            'Document',
            'Document',
        ]);
        expect([kindLabel(t, 'document'), kindLabel(t, 'document', true), kindLabel(t, 'template'), kindLabel(t, 'section')]).toEqual([
            'Document',
            'Presentation',
            'Template',
            'Reusable section',
        ]);
        expect(['document', 'template', 'section'].map((k) => kindTabLabel(t, k as 'document'))).toEqual(['Documents', 'Templates', 'Reusable sections']);
        expect(paramTypeLabel(t, 'boolean')).toBe('Yes / no');
        expect(sectionStateLabel(t, 'unresolved')).toBe('Needs input');
        expect(docIcon({ docType: 'presentation' })).toBe('Presentation');
        expect(docIcon({ docType: 'invoice' })).toBe('FileText');
    });

    it('says a rule as a sentence', () => {
        expect(conditionText(t, null)).toBe('Always included');
        expect(conditionText(t, { parameter: 'seats', operator: 'greater_than', value: 5 })).toBe('seats greater than 5');
        expect(
            conditionText(t, { all: [{ parameter: 'remote', operator: 'is_set' }, { any: [{ parameter: 'a', operator: 'equals', value: 1 }, { parameter: 'b', operator: 'not_equals', value: 2 }] }] }),
        ).toBe('remote is set AND (a equals 1 OR b does not equal 2)');
        expect(operatorLabel(t, 'contains')).toBe('Contains');
        expect(operatorLabel(t, 'less_than')).toBe('Less than');
    });

    it('makes a safe file name', () => {
        expect(fileNameFor('Offerte — Café & Co', 'pdf')).toBe('Offerte-Cafe-Co.pdf');
        expect(fileNameFor('   ', 'pptx')).toBe('document.pptx');
    });
});

describe('the editor tabs', () => {
    it('are the web panels, without Sections and Design on a deck', () => {
        expect(editorTabs(t, false).map((tab) => tab.label)).toEqual(['Text', 'Parameters', 'Sections', 'Design', 'Customer preview', 'History']);
        expect(editorTabs(t, true).map((tab) => tab.id)).toEqual(['content', 'parameters', 'preview', 'history']);
    });

    it('show the autosave while it matters and the type otherwise', () => {
        expect(['idle', 'saving', 'saved', 'error'].map((s) => saveStatus(t, s as 'idle', 'Invoice'))).toEqual(['Invoice', 'Saving…', 'Saved', 'Not saved']);
    });
});

describe('createRequestFor', () => {
    const names = { page: 'Untitled document', deck: 'Untitled presentation' };
    const starter = (docType: string) => ({ id: `s-${docType}`, name: `${docType} starter`, docType, description: '', parameterCount: 3 });

    it('creates a blank page or deck in the current view', () => {
        expect(createRequestFor({ blank: 'page' }, { kind: 'template', locale: 'en' }, names)).toEqual({ name: 'Untitled document', kind: 'template', locale: 'en' });
        expect(createRequestFor({ blank: 'deck' }, { kind: 'document', locale: 'nl' }, names)).toEqual({
            name: 'Untitled presentation',
            kind: 'document',
            locale: 'nl',
            blankDeck: true,
        });
    });

    it('starts from a starter, and never makes a presentation a reusable section', () => {
        expect(createRequestFor({ starter: starter('invoice') }, { kind: 'section', locale: 'en' }, names)).toMatchObject({ kind: 'section', starterId: 's-invoice', name: 'invoice starter' });
        expect(createRequestFor({ starter: starter('presentation') }, { kind: 'section', locale: 'en' }, names)).toMatchObject({ kind: 'document' });
        expect(createRequestFor({ blank: 'deck' }, { kind: 'section', locale: 'en' }, names).kind).toBe('document');
    });
});
