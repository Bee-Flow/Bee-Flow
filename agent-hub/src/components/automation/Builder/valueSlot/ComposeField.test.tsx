import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MappingSource, PickPart } from '@shared/mapping/index.mjs';
import { VariablePickerProvider as ProviderJs } from '../mapping/VariablePickerContext';
import ComposeField from './ComposeField';
import type { ComposeFieldProps, FocusHandle } from './ComposeField';
import { PILL_SELECTOR, serializeHost } from './slotDom';
import { createSlotRegistry, SlotRegistryContext } from './useSlotRegistry';

const VariablePickerProvider = ProviderJs as unknown as React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;

/**
 * ComposeField: a text with values in it. What the author sees is text with
 * named pills; what is stored is a compose (where the run takes one), so a
 * list reaches the run as readable text; a legacy template is only
 * rewritten when the author changes it.
 */

const SAMPLE = {
    trigger: {
        output: {
            customer: { name: 'Anna de Vries', email: 'anna@voorbeeld.nl' },
            orders: [
                { id: 'A-100', lines: [{ product: 'Bureaustoel', qty: 1 }, { product: 'Lamp', qty: 2 }] },
                { id: 'A-101', lines: [{ product: 'Muismat', qty: 3 }] },
            ],
        },
    },
    steps: { fetch: { output: { subjects: ['Levering vertraagd', 'Factuur 2026-118'] } } },
    vars: {},
};
const STEP_LABELS = new Map([['fetch', 'Berichten ophalen']]);
const STEP_TYPES = new Map([['fetch', 'http_request']]);

const NAME: MappingSource = { root: 'trigger', path: ['customer', 'name'] };
const PRODUCTS: MappingSource = { root: 'trigger', path: ['orders', 'lines', 'product'] };
const PRODUCTS_PART: PickPart = { from: PRODUCTS, take: 'all', as: 'text', join: 'lines', label: 'Product' };

function renderField(props: Partial<ComposeFieldProps> = {}) {
    const onChange = vi.fn();
    const onFocusField = vi.fn();
    const utils = render(
        <VariablePickerProvider groups={[]} previewSample={SAMPLE} stepLabelById={STEP_LABELS} stepTypeById={STEP_TYPES}>
            <ComposeField stepType="notification" field="body" onChange={onChange} onFocusField={onFocusField} {...props} />
        </VariablePickerProvider>,
    );
    const host = utils.container.querySelector('[data-compose-editor]') as HTMLElement;
    return { ...utils, host, onChange, onFocusField };
}

/** Focus the field and return the handle the step drawer would keep. */
function focusHandle(host: HTMLElement, onFocusField: ReturnType<typeof vi.fn>): FocusHandle {
    fireEvent.focus(host);
    return onFocusField.mock.calls[onFocusField.mock.calls.length - 1][0];
}

function caretAt(node: Node, offset: number) {
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
}

/** Type into the editor as a person would: the text node changes, the caret stays at its end. */
function typeText(host: HTMLElement, text: string) {
    const last = host.lastChild && host.lastChild.nodeType === 3 ? host.lastChild : host.appendChild(document.createTextNode(''));
    last.nodeValue = (last.nodeValue || '') + text;
    caretAt(last, last.nodeValue.length);
    // A native input event: what the browser sends after a keystroke.
    host.dispatchEvent(new Event('input', { bubbles: true }));
}

const lastValue = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];

afterEach(() => cleanup());

describe('ComposeField: an AI-built compose', () => {
    const body = { kind: 'compose', v: 1, parts: ['Beste ', { from: NAME, take: 'one', as: 'text', label: 'Name' }, ',\nUw producten:\n', PRODUCTS_PART] };

    it('shows named pills with the list count, never a path or [object Object]', () => {
        const { host, onChange } = renderField({ value: body });
        const pills = host.querySelectorAll(PILL_SELECTOR);
        expect(pills).toHaveLength(2);
        expect(pills[0].textContent).toBe('Name of customer');
        expect(pills[1].textContent).toContain('Product of all lines');
        expect(pills[1].textContent).toContain('≡ 3');
        expect(host.textContent).not.toMatch(/object Object|trigger|\{\{|\[\*\]/);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('the example renders the list as readable text', () => {
        renderField({ value: body });
        expect(screen.getByTestId('compose-example').textContent).toContain('Uw producten:\nBureaustoel\nLamp\nMuismat');
    });

    it('typing keeps the pills and their bindings (no binding is lost on edit)', () => {
        const { host, onChange } = renderField({ value: body });
        typeText(host, '\nGroet');
        expect(lastValue(onChange)).toEqual({ ...body, parts: [...body.parts, '\nGroet'] });
    });
});

describe('ComposeField: inserting values', () => {
    it('a value from the source panel goes at the caret, typed text kept, as a labelled part', () => {
        const { host, onChange, onFocusField } = renderField({ value: '' });
        typeText(host, 'Beste , tot ziens');
        const text = host.firstChild as Text;
        caretAt(text, 'Beste '.length);
        fireEvent.keyUp(host);
        const handle = focusHandle(host, onFocusField);
        handle.insert('trigger.output.customer.name', { source: NAME });
        expect(lastValue(onChange)).toEqual({
            kind: 'compose', v: 1,
            parts: ['Beste ', { from: NAME, take: 'one', as: 'text', label: 'Name' }, ', tot ziens'],
        });
    });

    it('a list goes in as all of it, one per line, and its pill says how many', () => {
        const { host, onChange, onFocusField } = renderField({ value: 'Producten: ' });
        const handle = focusHandle(host, onFocusField);
        handle.insert('trigger.output.orders[*].lines[*].product', { source: PRODUCTS });
        expect(lastValue(onChange)).toEqual({ kind: 'compose', v: 1, parts: ['Producten: ', PRODUCTS_PART] });
        expect(host.querySelector(PILL_SELECTOR)?.textContent).toContain('≡ 3');
    });

    it('Backspace after a pill removes the whole pill', () => {
        const { host, onChange } = renderField({ value: { kind: 'compose', v: 1, parts: ['Hi ', { from: NAME, take: 'one', as: 'text' }] } });
        const pill = host.querySelector(PILL_SELECTOR)!;
        caretAt(pill.nextSibling!, 0);
        fireEvent.keyDown(host, { key: 'Backspace' });
        expect(host.querySelector(PILL_SELECTOR)).toBeNull();
        expect(lastValue(onChange)).toBe('Hi ');
    });

    it('a plain-text drop is not taken for a value (the browser moves the words)', () => {
        const { host, onChange } = renderField({ value: 'Hallo' });
        const data = new Map([['text/plain', 'some words']]);
        const dataTransfer = { types: ['text/plain'], getData: (k: string) => data.get(k) || '' };
        const prevented = !fireEvent.drop(host, { dataTransfer });
        expect(prevented).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('a dropped Source goes in as a pill', () => {
        const { host, onChange } = renderField({ value: 'Hallo ' });
        const data = new Map([['application/x-beeflow-source', JSON.stringify(NAME)]]);
        const dataTransfer = { types: ['application/x-beeflow-source'], getData: (k: string) => data.get(k) || '' };
        fireEvent.drop(host, { dataTransfer });
        expect(lastValue(onChange)).toMatchObject({ kind: 'compose', parts: ['Hallo ', { from: NAME, take: 'one' }] });
    });
});

describe('ComposeField: a list pill opens PickOptions', () => {
    it('choosing "with commas" changes how the list is used, and nothing else', async () => {
        const user = userEvent.setup();
        const value = { kind: 'compose', v: 1, parts: ['Producten: ', PRODUCTS_PART] };
        const { host, onChange } = renderField({ value });
        await user.click(host.querySelector(PILL_SELECTOR)!);
        const options = screen.getByTestId('pick-options');
        expect(options.textContent).toContain('Bureaustoel, Lamp, Muismat');
        await user.click(options.querySelector('[data-option="all_comma"]')!);
        expect(lastValue(onChange)).toEqual({ kind: 'compose', v: 1, parts: ['Producten: ', { ...PRODUCTS_PART, join: 'comma' }] });
        expect(screen.queryByTestId('pick-options')).toBeNull();
    });

    it('regression: a list re-picked into a text is asked about, not put in as JSON', async () => {
        const user = userEvent.setup();
        // A legacy text with a list in it: clicking that value asks how the
        // list is used before anything is written, and the answer is a compose.
        const { host, onChange } = renderField({ value: 'Producten: {{trigger.output.orders[*].lines[*].product}}' });
        await user.click(host.querySelector(PILL_SELECTOR)!);
        await user.click(screen.getByTestId('pick-options').querySelector('[data-option="all_bullets"]')!);
        expect(lastValue(onChange)).toEqual({ kind: 'compose', v: 1, parts: ['Producten: ', { ...PRODUCTS_PART, join: 'bullets' }] });
    });
});

describe('ComposeField: legacy templates', () => {
    it('a template is shown as pills and not rewritten until it is changed', () => {
        const text = 'Beste {{trigger.output.customer.name}}, uw producten: {{trigger.output.orders[*].lines[*].product}}';
        const { host, onChange } = renderField({ value: text });
        expect(host.querySelectorAll(PILL_SELECTOR)).toHaveLength(2);
        expect(host.textContent).not.toMatch(/\{\{|trigger/);
        expect(onChange).not.toHaveBeenCalled();
        // The run puts the list in as JSON until the text is changed: said so.
        expect(screen.getByText(/Change anything in this text/)).toBeTruthy();
        typeText(host, '!');
        expect(lastValue(onChange)).toMatchObject({
            kind: 'compose',
            parts: ['Beste ', { from: NAME, take: 'one' }, ', uw producten: ', { from: PRODUCTS, take: 'all', join: 'lines' }, '!'],
        });
    });

    it('a placeholder that reads no value is a Formula pill, and the text stays a template', () => {
        const text = 'Sleutel {{secrets.apiKey}} voor {{trigger.output.customer.name}}';
        const { host, onChange } = renderField({ value: text });
        const pills = host.querySelectorAll(PILL_SELECTOR);
        expect(pills[0].textContent).toBe('Formula');
        typeText(host, '.');
        expect(lastValue(onChange)).toBe(`${text}.`);
    });

    it('a text that takes plain text only stays a template, and a pick goes in as its placeholder', () => {
        const { host, onChange, onFocusField } = renderField({ stepType: 'approval', field: 'approval.details', value: 'Klant: ' });
        focusHandle(host, onFocusField).insert('trigger.output.customer.name', { source: NAME });
        expect(lastValue(onChange)).toBe('Klant: {{trigger.output.customer.name}}');
        expect(host.querySelector(PILL_SELECTOR)?.textContent).toBe('Name of customer');
    });

    it('an AI step prompt shows its inputs and values as pills and stays a template', () => {
        const text = 'Vat {{emails}} samen voor {{trigger.output.customer.name}}';
        const { host, onChange } = renderField({ stepType: 'ai_step', field: 'prompt', value: text });
        const pills = host.querySelectorAll(PILL_SELECTOR);
        expect(Array.from(pills).map(p => p.textContent)).toEqual(['Emails', 'Name of customer']);
        typeText(host, ' kort');
        expect(lastValue(onChange)).toBe(`${text} kort`);
        expect(serializeHost(host)).toEqual(['Vat ', { raw: '{{emails}}' }, ' samen voor ', { raw: '{{trigger.output.customer.name}}' }, ' kort']);
    });

    it('a value from a step that is gone is amber', () => {
        const { host } = renderField({ value: 'Over {{steps.gone.output.subject}}' });
        expect(host.querySelector(PILL_SELECTOR)?.textContent).toMatch(/^No longer available/);
    });
});

describe('ComposeField: what the example says about a list in a template', () => {
    // Ported from TemplateField (BFSF-458): the run puts a list in a `{{ }}`
    // template as JSON; the note says so honestly per field.
    const KW = { steps: { kw: { output: { variants: ['alpha tips', 'beta guide'], rows: [{ id: 1 }, { id: 2 }] } } } };

    it('in a JSON body the list goes in as JSON, stated plainly and not as a warning', () => {
        renderField({ stepType: 'http_request', field: 'body', listAs: 'json', previewSample: KW, value: '{"keywords": {{steps.kw.output.variants}}}' });
        expect(screen.getByTestId('compose-example').textContent).toContain('{"keywords": ["alpha tips","beta guide"]}');
        expect(screen.getByText(/The list goes in as JSON/)).toBeTruthy();
        expect(screen.queryByText(/Edit data/)).toBeNull();
    });

    it('where the text stays a template, the note names join() in a Formula field (a column for records)', () => {
        renderField({ stepType: 'approval', field: 'approval.details', previewSample: KW, value: 'Rows: {{steps.kw.output.rows}}' });
        const note = screen.getByText(/goes in as JSON text/);
        expect(note.textContent).toContain('join(steps.kw.output.rows[*].id, ", ")');
    });

    it('where the run renders markdown, a list of values previews as bullets, with no note', () => {
        renderField({ stepType: 'slide', field: 'content', listAs: 'markdown', previewSample: KW, value: 'Found:{{steps.kw.output.variants}}' });
        expect(screen.getByTestId('compose-example').textContent).toContain('Found:\n\n- alpha tips\n- beta guide\n');
        expect(screen.queryByText(/goes in as JSON/)).toBeNull();
    });
});

describe('regression: a clicked pill is the value it shows', () => {
    it('pasted `{{ }}` text before a pill (not a pill until blur) does not shift which value opens', async () => {
        const user = userEvent.setup();
        const value = { kind: 'compose', v: 1, parts: ['Producten: ', PRODUCTS_PART] };
        const { host, onChange } = renderField({ value });
        caretAt(host.firstChild!, 0);
        fireEvent.paste(host, { clipboardData: { getData: () => 'Ref {{trigger.output.customer.name}} ' } });
        expect(host.querySelectorAll(PILL_SELECTOR)).toHaveLength(1);
        await user.click(host.querySelector(PILL_SELECTOR)!);
        const options = screen.getByTestId('pick-options');
        expect(options.textContent).toContain('Bureaustoel');
        expect(options.textContent).not.toContain('Anna');
        await user.click(options.querySelector('[data-option="all_comma"]')!);
        // The list pill changed; the pasted placeholder is lifted, not swapped in.
        expect(lastValue(onChange)).toEqual({
            kind: 'compose', v: 1,
            parts: ['Ref ', { from: NAME, take: 'one', as: 'text', label: 'Name' }, ' Producten: ', { ...PRODUCTS_PART, join: 'comma' }],
        });
    });
});

describe('regression: a formula typed next to a list is not saved as a text that loses the list', () => {
    it('keeps the saved value and says which formula is in the way, until it is removed', () => {
        const value = { kind: 'compose', v: 1, parts: ['Orders: ', PRODUCTS_PART] };
        const { host, onChange } = renderField({ value });
        act(() => typeText(host, ' {{secrets.token}}'));
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByTestId('compose-unsaved').textContent).toContain('{{secrets.token}}');
        // Removing the formula saves again, the list as it was.
        const last = host.lastChild as Text;
        last.nodeValue = ' ';
        caretAt(last, 1);
        act(() => { host.dispatchEvent(new Event('input', { bubbles: true })); });
        expect(lastValue(onChange)).toEqual({ kind: 'compose', v: 1, parts: ['Orders: ', PRODUCTS_PART, ' '] });
        expect(screen.queryByTestId('compose-unsaved')).toBeNull();
    });
});

describe('regression: fields that share a site register on their own', () => {
    it('two rows of one site each take the value meant for them', () => {
        const registry = createSlotRegistry();
        const first = vi.fn();
        const second = vi.fn();
        const { container } = render(
            <VariablePickerProvider groups={[]} previewSample={SAMPLE} stepLabelById={STEP_LABELS} stepTypeById={STEP_TYPES}>
                <SlotRegistryContext.Provider value={registry}>
                    <ComposeField stepType="presentation" field="slides" slotKey="0" value="" onChange={first} />
                    <ComposeField stepType="presentation" field="slides" slotKey="1" value="" onChange={second} />
                </SlotRegistryContext.Provider>
            </VariablePickerProvider>,
        );
        const [row1, row2] = Array.from(container.querySelectorAll('[data-compose-editor]')) as HTMLElement[];
        expect(registry.emptySlots()).toHaveLength(2);
        fireEvent.focus(row1);
        expect(registry.deliver({ source: NAME })).toBe(true);
        expect(first).toHaveBeenCalled();
        expect(second).not.toHaveBeenCalled();
        fireEvent.focus(row2);
        registry.deliver({ source: NAME });
        expect(second).toHaveBeenCalled();
    });
});
