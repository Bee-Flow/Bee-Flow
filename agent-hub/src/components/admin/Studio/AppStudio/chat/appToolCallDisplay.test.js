import { describe, expect, it } from 'vitest';
import { VERBS, describeAppToolCall, appDetailPayload, landedTypeLabel } from './appToolCallDisplay';
import { TOOL_SCHEMAS_NAMES } from './appToolNames.fixture';

describe('describeAppToolCall', () => {
    it('names a batch by count and lists what landed, typed, in order', () => {
        const row = describeAppToolCall({ name: 'app_add_components', ok: true, added: [{ id: 'c1', type: 'page_header', label: 'Facturen' }, { id: 'c2', type: 'stat', label: 'Totaal' }, { id: 'c3', type: 'data_grid', label: null }] });
        expect(row.status).toBe('ok');
        expect(row.title).toBe('Added 3 components');
        expect(row.added.map((a) => a.title)).toEqual(['Facturen', 'Totaal', 'Data grid']);
        expect(row.detail).toBe('Facturen · Totaal · Data grid');
        expect(describeAppToolCall({ name: 'app_add_components', ok: true, added: [{ id: 'c1', type: 'heading' }] }).title).toBe('Added 1 component');
    });

    it('a refusal keeps the error and hint on the row', () => {
        const row = describeAppToolCall({ name: 'app_add_components', ok: false, error: 'Unknown parentId "sec_x".', hint: 'Use a real id.', summary: 'Unknown parentId "sec_x".' });
        expect(row.status).toBe('failed');
        expect(row.title).toBe('Not applied');
        expect(row.detail).toBe('Unknown parentId "sec_x".');
        expect(row.hint).toBe('Use a real id.');
    });

    it('single landings name the thing; other tools use their verb; translation goes through t()', () => {
        expect(describeAppToolCall({ name: 'app_add_screen', ok: true, added: [{ id: 's1', type: 'screen', label: 'Detail' }] }).detail).toBe('Detail');
        expect(describeAppToolCall({ name: 'app_link_datatable', ok: true, added: [{ id: 't1', type: 'table', label: 'Facturen' }], summary: 'Linked "Facturen"' }).title).toBe('Linked a table');
        const t = (key) => `⟦${key}⟧`;
        expect(describeAppToolCall({ name: 'app_finalize', ok: true }, t).title).toBe('⟦app_studio.builder.act.finalize⟧');
        expect(describeAppToolCall({ name: 'app_something_new', ok: true }).title).toBe('something new');
        expect(landedTypeLabel('chart')).toBe('Chart');
        expect(landedTypeLabel('table')).toBe('Table');
    });

    it('every app_* tool the server ships has a verb', () => {
        for (const name of TOOL_SCHEMAS_NAMES) expect(VERBS[name], `verb for ${name}`).toBeTruthy();
    });

    it('appDetailPayload parses the bounded JSON strings the server sends', () => {
        expect(appDetailPayload({ arguments: '{"a":1}', result: '{"ok":true}' })).toEqual({ args: { a: 1 }, result: { ok: true } });
        expect(appDetailPayload({ arguments: 'not json', result: undefined })).toEqual({ args: 'not json', result: undefined });
    });
});
