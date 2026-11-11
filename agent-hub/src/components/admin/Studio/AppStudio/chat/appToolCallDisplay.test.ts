import { describe, expect, it } from 'vitest';
import { VERBS, describeAppToolCall, appDetailPayload, landedTypeLabel, verbFor } from './appToolCallDisplay';
import TOOL_SCHEMAS_NAMES from './appToolNames.generated.json';

// Tools the server ships that have no verb yet: their row shows the humanised
// tool name. A verb is a user-facing string, so it needs an i18n key first.
// Remove a name here when it gets its verb (the test below fails until then).
// A registry tool (server builderTools/tools/) carries its own verb: appToolVerbs.generated.json.
const NO_VERB_YET = new Set<string>([]);

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
        const t = (key: string) => `⟦${key}⟧`;
        expect(describeAppToolCall({ name: 'app_finalize', ok: true }, t).title).toBe('⟦app_studio.builder.act.finalize⟧');
        expect(describeAppToolCall({ name: 'app_something_new', ok: true }).title).toBe('something new');
        expect(landedTypeLabel('chart', null)).toBe('Chart');
        expect(landedTypeLabel('table', null)).toBe('Table');
    });

    it('every app_* tool the server ships has a verb, bar the listed ones', () => {
        for (const name of TOOL_SCHEMAS_NAMES) {
            if (NO_VERB_YET.has(name)) expect(VERBS[name], `${name} has a verb now: drop it from NO_VERB_YET`).toBeUndefined();
            else expect(verbFor(name), `verb for ${name}`).toBeTruthy();
        }
        for (const name of NO_VERB_YET) expect(TOOL_SCHEMAS_NAMES, `${name} is no longer a server tool`).toContain(name);
    });

    it('a registry tool reads its verb from the generated list; the table wins for a base tool', () => {
        const registry = { app_zz_note: { key: 'zz_fixture.act_note', en: 'Wrote a note' } };
        expect(verbFor('app_zz_note', registry)).toEqual(registry.app_zz_note);
        expect(verbFor('app_zz_note')).toBeNull();
        expect(verbFor('app_set_meta', { app_set_meta: { key: 'x.y', en: 'Other' } })).toBe(VERBS.app_set_meta);
        expect(verbFor('app_zz_bad', { app_zz_bad: { key: 7, en: 'x' } as never })).toBeNull();
        expect(verbFor('constructor', {})).toBeNull();
        expect(describeAppToolCall({ name: 'app_inspect_catalog', ok: true }).title).toBe('Looked up the building blocks');
    });

    it('appDetailPayload parses the bounded JSON strings the server sends', () => {
        expect(appDetailPayload({ arguments: '{"a":1}', result: '{"ok":true}' })).toEqual({ args: { a: 1 }, result: { ok: true } });
        expect(appDetailPayload({ arguments: 'not json', result: undefined })).toEqual({ args: 'not json', result: undefined });
    });
});
