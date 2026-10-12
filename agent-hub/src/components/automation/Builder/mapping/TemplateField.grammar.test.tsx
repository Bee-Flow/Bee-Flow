/**
 * A text field writes canonical `{{path}}` placeholders and reads them with
 * the runtime's quote-aware scan: keys with `}`, `]`, quotes or a dash insert
 * as one pill, preview the value the run writes, and survive a drop.
 */
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TemplateFieldJs from './TemplateField';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';
import { editor } from '../../../../test/refEditor';

type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const TemplateField = TemplateFieldJs as unknown as Loose;
const VariablePickerProvider = ProviderJs as unknown as Loose;

const labels = new Map([['s1', 'Sheet']]);
const ROOT = {
    trigger: { output: { headers: { 'content-type': 'application/json' } } },
    steps: { s1: { output: { odd: { 'a}}b': 'braces', 'Amount [EUR]': 1500, 'say "hi"': 'quoted' } } } },
};

type Handle = { insert: (path: string) => void };

function setup(value = '') {
    const onChange = vi.fn();
    let handle: Handle | null = null;
    render(
        <VariablePickerProvider groups={[]} previewSample={ROOT} stepLabelById={labels} stepTypeById={null}>
            <TemplateField label="Body" value={value} onChange={onChange} onFocusField={(h: Handle) => { handle = h; }} />
        </VariablePickerProvider>,
    );
    return { onChange, handle: () => handle as unknown as Handle };
}

afterEach(() => cleanup());

describe('TemplateField with awkward keys', () => {
    it.each([
        ['steps.s1.output.odd["a}}b"]', 'braces'],
        ['steps.s1.output.odd["Amount [EUR]"]', '1500'],
        ['steps.s1.output.odd["say \\"hi\\""]', 'quoted'],
    ])('%s inserts as one pill and previews its value', (path, shown) => {
        const { onChange, handle } = setup();
        act(() => { editor(document.body)?.focus(); });
        act(() => handle().insert(path));
        expect(onChange.mock.lastCall?.[0]).toBe(`{{${path}}}`);
        const el = editor(document.body) as HTMLElement;
        expect(el.querySelectorAll('[data-ref-pill]')).toHaveLength(1);
        expect(el.textContent).not.toContain('{{');
        expect(screen.getByText(shown)).toBeTruthy();
    });

    it('a dropped dotted path with a dash is written canonically', () => {
        const { onChange } = setup();
        const el = editor(document.body) as HTMLElement;
        const drop = createEvent.drop(el);
        Object.defineProperty(drop, 'dataTransfer', {
            value: { getData: (t: string) => (t === 'application/x-binding-path' ? 'trigger.output.headers.content-type' : ''), types: ['application/x-binding-path'] },
        });
        fireEvent(el, drop);
        expect(onChange.mock.lastCall?.[0]).toBe('{{trigger.output.headers["content-type"]}}');
        expect(screen.getByText('application/json')).toBeTruthy();
    });
});
