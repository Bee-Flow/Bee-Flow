import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import TemplateFieldJs from './TemplateField';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';

// Both are JS components: TypeScript reads every prop without a default as
// required, so the test types them loosely instead of passing dummies.
type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const TemplateField = TemplateFieldJs as unknown as Loose;
const VariablePickerProvider = ProviderJs as unknown as Loose;

/**
 * What the example line under a template slot says about a LIST (BFSF-458).
 *
 * The runtime (server/automation/bind.js interpolateTemplate) writes a list of
 * plain values as "a, b" in a text slot, as JSON in a data slot (a JSON request
 * body, listAs 'json'), and, where it renders with `listAsMarkdown`, as bullets. The field used to warn on every
 * list that it "will be sent as text" and send the author to an Edit data step
 * to join it, even in a JSON body where the result is already valid JSON.
 */

const SAMPLE = {
    steps: {
        kw: { output: { variants: ['alpha tips', 'beta guide'], rows: [{ id: 1 }, { id: 2 }] } },
    },
};

function renderField(value: string, props: Record<string, unknown> = {}) {
    render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <TemplateField value={value} onChange={() => {}} previewSample={SAMPLE} {...props} />
        </VariablePickerProvider>,
    );
}

const exampleText = () => document.querySelector('.font-mono')?.textContent || '';

describe('TemplateField: a list in the example', () => {
    afterEach(() => cleanup());

    it('in a JSON body the list goes in as JSON, stated plainly and not as a warning', () => {
        renderField('{"keywords": {{steps.kw.output.variants}}}', { listAs: 'json' });
        expect(exampleText()).toBe('{"keywords": ["alpha tips","beta guide"]}');
        const line = screen.getByText(/The list goes in as JSON/);
        expect(line.textContent).toContain('["alpha tips","beta guide"]');
        expect(screen.queryByText(/Edit data/)).toBeNull();
        expect(screen.queryByText(/sent as text/)).toBeNull();
    });

    it('in a text slot a list of plain values previews as "alpha tips, beta guide", as the run writes it, with no note', () => {
        renderField('Keywords: {{steps.kw.output.variants}}');
        expect(exampleText()).toBe('Keywords: alpha tips, beta guide');
        expect(screen.queryByText(/goes in as JSON/)).toBeNull();
        expect(screen.queryByText(/Edit data/)).toBeNull();
    });

    it('a record previews as "key: value" in the key order the step returned, JSON in a data slot', () => {
        const previewSample = { steps: { kw: { output: { row: { sku: 'A1', qty: 2, price: 9.95 } } } } };
        renderField('Row: {{steps.kw.output.row}}', { previewSample });
        expect(exampleText()).toBe('Row: sku: A1, qty: 2, price: 9.95');
        cleanup();
        renderField('{{steps.kw.output.row}}', { previewSample, listAs: 'json' });
        expect(exampleText()).toBe('{"sku":"A1","qty":2,"price":9.95}');
    });

    it('nothing (null) previews as empty text, not "null"', () => {
        renderField('[{{steps.kw.output.gone}}]', { previewSample: { steps: { kw: { output: { gone: null } } } } });
        expect(exampleText()).toBe('[]');
    });

    it('where the runtime renders markdown, a list of values previews as bullets, with no note', () => {
        renderField('Found:{{steps.kw.output.variants}}', { listAs: 'markdown' });
        expect(exampleText()).toBe('Found:\n\n- alpha tips\n- beta guide\n');
        expect(screen.queryByText(/goes in as JSON/)).toBeNull();
    });

    it('a table in markdown is one bullet per row, as the runtime writes it', () => {
        renderField('Rows: {{steps.kw.output.rows}}', { listAs: 'markdown' });
        expect(exampleText()).toBe('Rows: \n\n- id: 1\n- id: 2\n');
    });

    it('a table in a text slot reads one row per line, with nothing to warn about', () => {
        renderField('Rows: {{steps.kw.output.rows}}');
        expect(exampleText()).toBe('Rows: id: 1\nid: 2');
        expect(screen.queryByText(/goes in as JSON/)).toBeNull();
    });

    it('a single value gets no note at all', () => {
        renderField('{"n": {{steps.kw.output.rows}}}', { listAs: 'json', previewSample: { steps: { kw: { output: { rows: 3 } } } } });
        expect(screen.queryByText(/goes in as JSON/)).toBeNull();
    });
});

describe('TemplateField: a list, table or group dragged into a text', () => {
    afterEach(() => cleanup());

    /** Insert the way the Comes-in tree does: through the handle onFocusField publishes. */
    function setupInsert(props: Record<string, unknown> = {}) {
        const changes: string[] = [];
        const forEachCalls: unknown[] = [];
        const handle: { current: { insert: (p: string) => void } | null } = { current: null };
        render(
            <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
                <TemplateField
                    value=""
                    onChange={(v: string) => changes.push(v)}
                    previewSample={SAMPLE}
                    onFocusField={(h: { insert: (p: string) => void }) => { handle.current = h; }}
                    onRequestForEach={(fe: unknown) => forEachCalls.push(fe)}
                    {...props}
                />
            </VariablePickerProvider>,
        );
        fireEvent.focus(screen.getAllByRole('textbox')[0]);
        const insert = (path: string) => act(() => { handle.current?.insert(path); });
        return { changes, forEachCalls, insert };
    }

    it('goes in without a question, and More stays closed', () => {
        const { changes, insert } = setupInsert();
        insert('steps.kw.output.rows');
        expect(changes.at(-1)).toBe('{{steps.kw.output.rows}}');
        expect(screen.getByTestId('template-fit-more')).toBeTruthy();
        expect(screen.queryByRole('group', { name: 'More ways to use this value' })).toBeNull();
    });

    it('More turns the table into one column, in the same place', () => {
        const { changes, insert } = setupInsert();
        insert('steps.kw.output.rows');
        fireEvent.click(screen.getByRole('button', { name: 'More ways to use this value' }));
        fireEvent.click(screen.getByText('Only “Id”, from every row'));
        expect(changes.at(-1)).toBe('{{steps.kw.output.rows[*].id}}');
    });

    it('a separate run for each row sets the step\'s forEach and puts the row in the text', () => {
        const { changes, forEachCalls, insert } = setupInsert();
        insert('steps.kw.output.rows');
        fireEvent.click(screen.getByRole('button', { name: 'More ways to use this value' }));
        fireEvent.click(screen.getByText('A separate run for each row'));
        expect(forEachCalls.at(-1)).toEqual(expect.objectContaining({ overRef: 'steps.kw.output.rows' }));
        expect(changes.at(-1)).toMatch(/^\{\{loop\.[A-Za-z_]+\}\}$/);
    });

    it('a single value gets no More', () => {
        const { insert } = setupInsert({ previewSample: { steps: { kw: { output: { name: 'Ada' } } } } });
        insert('steps.kw.output.name');
        expect(screen.queryByTestId('template-fit-more')).toBeNull();
    });

    it('a data slot (listAs json) gets no More: the value goes in as JSON on purpose', () => {
        const { insert } = setupInsert({ listAs: 'json' });
        insert('steps.kw.output.rows');
        expect(screen.queryByTestId('template-fit-more')).toBeNull();
    });
});
