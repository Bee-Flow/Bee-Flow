import { cleanup, render, screen } from '@testing-library/react';
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
 * The runtime (server/automation/bind.js interpolateTemplate) puts a list in
 * as JSON — which is exactly right in a JSON request body — and, where it
 * renders with `listAsMarkdown`, as bullets. The field used to warn on every
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

    it('in a text slot the note names a route that works: join() in a Formula field', () => {
        renderField('Keywords: {{steps.kw.output.variants}}');
        const note = screen.getByText(/goes in as JSON text/);
        expect(note.textContent).toContain('Edit data');
        expect(note.textContent).toContain('join(steps.kw.output.variants, ", ")');
    });

    it('where the runtime renders markdown, a list of values previews as bullets, with no note', () => {
        renderField('Found:{{steps.kw.output.variants}}', { listAs: 'markdown' });
        expect(exampleText()).toBe('Found:\n\n- alpha tips\n- beta guide\n');
        expect(screen.queryByText(/goes in as JSON/)).toBeNull();
    });

    it('a list of records keeps its JSON in markdown too, and gets the note', () => {
        renderField('Rows: {{steps.kw.output.rows}}', { listAs: 'markdown' });
        expect(exampleText()).toBe('Rows: [{"id":1},{"id":2}]');
        expect(screen.getByText(/goes in as JSON text/)).toBeTruthy();
    });

    it('for a list of records the note joins a column, since join() of records gives [object Object]', () => {
        renderField('Rows: {{steps.kw.output.rows}}');
        const note = screen.getByText(/goes in as JSON text/);
        expect(note.textContent).toContain('join(steps.kw.output.rows[*].id, ", ")');
        expect(note.textContent).not.toContain('join(steps.kw.output.rows, ');
    });

    it('a single value gets no note at all', () => {
        renderField('{"n": {{steps.kw.output.rows}}}', { listAs: 'json', previewSample: { steps: { kw: { output: { rows: 3 } } } } });
        expect(screen.queryByText(/goes in as JSON/)).toBeNull();
    });
});
