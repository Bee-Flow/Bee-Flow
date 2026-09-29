import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppInputSelect, { optionsFromRows } from './AppInputSelect';
import AppForm from './AppForm';
import { RuntimeProvider, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * Options from a table (spec: input_select.optionsFrom).
 *
 * The choices people pick from are rows somebody maintains — a materials list
 * with 65 entries — not a list an author retypes into every select. Until this
 * the only way to offer them was a free-text box with "type it exactly as in
 * the list" as its placeholder.
 */

const MATERIALS = [
    { id: 'm1', naam: 'Aluminium 5083' },
    { id: 'm2', naam: 'RVS 304 2B' },
    { id: 'm3', naam: 'Aluminium 5083' },   // a duplicate name — offered once
    { id: 'm4', naam: '' },                  // no usable value — skipped
    null,
];

function renderSelect(props = {}) {
    const node = {
        id: 'cmp_s', type: 'input_select',
        props: { name: 'materiaal', label: 'Materiaal', options: [], ...props },
        style: { span: 12 },
    };
    const formNode = {
        id: 'cmp_form', type: 'form', visible: true,
        props: { name: 'line', submitLabel: 'Save', showReset: false },
        style: { span: 12, gap: 3, padding: 0 },
        children: [node],
    };
    return render(
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run' }}>
            <AppForm node={formNode}><AppInputSelect node={node} /></AppForm>
        </RuntimeProvider>,
    );
}

describe('optionsFromRows', () => {
    it('turns rows into options by key, skipping empties and duplicates', () => {
        expect(optionsFromRows(MATERIALS, 'naam', 'naam')).toEqual([
            { value: 'Aluminium 5083', label: 'Aluminium 5083' },
            { value: 'RVS 304 2B', label: 'RVS 304 2B' },
        ]);
    });

    it('labels fall back to the value, and a non-list is no options', () => {
        expect(optionsFromRows([{ id: 7 }], 'id', 'missing')).toEqual([{ value: '7', label: '7' }]);
        expect(optionsFromRows(null, 'id')).toEqual([]);
        expect(optionsFromRows('rows', 'id')).toEqual([]);
    });
});

describe('AppInputSelect — optionsFrom', () => {
    it('renders the table rows as options, after the fixed ones', () => {
        const { container } = renderSelect({
            options: [{ value: '', label: '(geen)' }],
            optionsFrom: { kind: 'static', value: MATERIALS },
            optionValueKey: 'naam', optionLabelKey: 'naam',
        });
        const labels = [...container.querySelectorAll('option')].map((o) => o.textContent);
        // Placeholder, then the fixed "(geen)", then the table.
        expect(labels).toEqual(['Choose…', '(geen)', 'Aluminium 5083', 'RVS 304 2B']);
    });

    it('a select without optionsFrom renders exactly the fixed options', () => {
        const { container } = renderSelect({ options: [{ value: 'a', label: 'A' }] });
        const labels = [...container.querySelectorAll('option')].map((o) => o.textContent);
        expect(labels).toEqual(['Choose…', 'A']);
    });
});
