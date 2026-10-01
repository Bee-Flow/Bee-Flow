import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentType, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluate } from '@shared/expr/index.mjs';
import * as parse from '@shared/expr/parse.mjs';
import { WILD, createResolver, isPick } from '@shared/mapping/index.mjs';
import { VariablePickerProvider as ProviderJs } from '../mapping/VariablePickerContext';
import { colSegments, mapAttrs, type MapCtx } from '../output/mapAttrs';
import type { FieldHandle, InsertOpts } from './fieldHandle';
import { SOURCE_MIME } from './slotDnd';
import ValueSlot, { type ValueSlotProps } from './ValueSlot';

const VariablePickerProvider = ProviderJs as unknown as ComponentType<Record<string, unknown> & { children: ReactNode }>;

// A webhook with a customer and orders (each with order lines), and an
// earlier step that fetched messages: the preview fixture, in small.
const TRIGGER = {
    customer: { name: 'Anna de Vries', email: 'anna@voorbeeld.nl' },
    orders: [
        { id: 'A-100', total: 129.5, lines: [{ product: 'Bureaustoel', qty: 1 }, { product: 'Lamp', qty: 2 }] },
        { id: 'A-101', total: 49, lines: [{ product: 'Muismat', qty: 3 }, { product: 'Toetsenbord', qty: 1 }] },
    ],
    people: [{ Naam: 'Ada', 'E-mail': 'ada@x.nl' }, { Naam: 'Bo', 'E-mail': 'bo@x.nl' }],
};
const SAMPLE = { trigger: { output: TRIGGER }, steps: { fetch: { output: { subject: 'Levering' } } } };
const GROUPS = [
    { id: 'trg', label: 'Bestelling ontvangen', kind: 'trigger', basePath: 'trigger.output', sample: TRIGGER, fields: [] },
    { id: 'fetch', label: 'Berichten ophalen', kind: 'http_request', basePath: 'steps.fetch.output', sample: SAMPLE.steps.fetch.output, fields: [] },
];
const LABELS = new Map([['fetch', 'Berichten ophalen']]);

/** A slot that keeps its value, like a step's form does. */
function Harness({ initial = null, onValue, ...props }: Partial<ValueSlotProps> & { initial?: unknown; onValue: (v: unknown) => void }) {
    const [value, setValue] = useState<unknown>(initial);
    return (
        <ValueSlot
            label="Field"
            {...props}
            value={value}
            onChange={(v) => { setValue(v); onValue(v); }}
        />
    );
}

function renderSlot(props: Partial<ValueSlotProps> & { initial?: unknown } = {}) {
    const onValue = vi.fn();
    let handle: FieldHandle | null = null;
    render(
        <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={LABELS} stepTypeById={null}>
            <Harness onValue={onValue} onFocusField={(h) => { handle = h; }} {...props} />
        </VariablePickerProvider>,
    );
    // A field hands its handle to the drawer on focus; a click in "Comes in" then arrives through it.
    act(() => { screen.getByTestId('value-slot').focus(); screen.getByTestId('value-slot').dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    const pick = (path: string) => act(() => { (handle as FieldHandle | null)?.insert(path); });
    return { onValue, pick, last: () => onValue.mock.calls.at(-1)?.[0], getHandle: () => handle };
}

const chip = () => screen.getByTestId('value-chip');
const sentence = () => screen.getByTestId('pick-sentence');

describe('ValueSlot — one value', () => {
    beforeEach(cleanup);

    it('a picked value is a chip with its name and example, stored as a pick', () => {
        const { pick, last } = renderSlot({ field: 'to', schema: { type: 'string' }, label: 'To' });
        pick('trigger.output.customer.email');
        expect(last()).toEqual({ kind: 'pick', v: 1, from: { root: 'trigger', path: ['customer', 'email'] }, take: 'one', as: 'text' });
        expect(chip().textContent).toContain('Email of customer');
        expect(chip().textContent).toContain('anna@voorbeeld.nl');
        expect(screen.queryByTestId('pick-sentence')).toBeNull();
    });

    it('a second pick replaces the chip, with "Replaced · Undo"', async () => {
        const { pick, last } = renderSlot({ field: 'to', schema: { type: 'string' } });
        pick('trigger.output.customer.email');
        const first = last();
        pick('trigger.output.customer.name');
        expect(last()).toMatchObject({ from: { path: ['customer', 'name'] } });
        expect(screen.getByTestId('slot-replaced').textContent).toContain('Replaced');
        await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(last()).toEqual(first);
        expect(screen.queryByTestId('slot-replaced')).toBeNull();
    });

    it('typing gives a fixed value; a typed {{ }} is kept as written', async () => {
        const { last } = renderSlot();
        await userEvent.type(screen.getByRole('textbox', { name: 'Field' }), 'Hallo');
        expect(last()).toEqual({ kind: 'literal', value: 'Hallo' });
    });
});

describe('ValueSlot — a list', () => {
    beforeEach(cleanup);

    it('into text: all of them, said in one sentence, with live options', async () => {
        const { pick, last } = renderSlot({ field: 'body', schema: { type: 'string' }, label: 'Bericht' });
        pick('trigger.output.orders[*].lines[*].product');
        expect(last()).toMatchObject({ take: 'all', as: 'text', join: 'lines' });
        expect(chip().textContent).toContain('Product of all lines');
        expect(chip().textContent).toContain('· 4');
        expect(sentence().textContent).toContain('Comes as text: all 4, one per line.');
        await userEvent.click(within(sentence()).getByRole('button', { name: 'Change' }));
        const options = screen.getByTestId('pick-options');
        // Each choice shows what the field gets, never JSON.
        expect(options.textContent).toContain('Bureaustoel');
        expect(options.textContent).not.toMatch(/[[{]"/);
        await userEvent.click(within(options).getByRole('radio', { name: /Only the first/ }));
        expect(last()).toMatchObject({ take: 'first', as: 'text' });
        expect(sentence().textContent).toBe('Only the first of 4.Change');
    });

    it('into a number: the first, in amber', () => {
        const { pick, last } = renderSlot({ field: 'priority', schema: { type: 'number' } });
        pick('trigger.output.orders[*].total');
        expect(last()).toMatchObject({ take: 'first', as: 'number' });
        expect(sentence().getAttribute('data-tone')).toBe('amber');
    });

    it('a whole table into a list field takes the matching column; no match asks, in amber', async () => {
        const { pick, last } = renderSlot({ field: 'email', schema: { type: 'array', items: { type: 'string' } }, label: 'Ontvangers' });
        pick('trigger.output.people');
        expect(last()).toMatchObject({ from: { path: ['people', 'E-mail'] }, take: 'all', as: 'list' });
        expect(sentence().getAttribute('data-tone')).toBe('muted');
        expect(within(sentence()).getByRole('combobox')).toHaveProperty('value', 'E-mail');
        cleanup();
        const other = renderSlot({ field: 'cc', schema: { type: 'array', items: { type: 'string' } }, label: 'Extra' });
        other.pick('trigger.output.people');
        expect(sentence().getAttribute('data-tone')).toBe('amber');
        await userEvent.selectOptions(within(sentence()).getByRole('combobox'), 'Naam');
        expect(other.last()).toMatchObject({ from: { path: ['people', 'Naam'] }, take: 'all', as: 'list' });
    });

    // Confirmed bug: "Picking a list into ValueBuilder text that already holds typed words wipes that text".
    it('a list picked into typed text keeps the text', async () => {
        const { pick, last } = renderSlot({ field: 'body', schema: { type: 'string' }, initial: { kind: 'literal', value: 'Uw producten: ' } });
        pick('trigger.output.orders[*].lines[*].product');
        expect(last()).toMatchObject({ kind: 'compose', parts: ['Uw producten: ', { take: 'all', as: 'text' }] });
        expect(screen.getByDisplayValue(/Uw producten:/)).toBeTruthy();
        expect(screen.queryByTestId('slot-replaced')).toBeNull();
    });
});

describe('ValueSlot — the ways a value arrives', () => {
    beforeEach(cleanup);

    // Confirmed bugs: "The {} picker bypasses the list/kind chooser" (two of them).
    it('its own "Use data from a step" goes through the same defaults as a click', async () => {
        const groups = [{ ...GROUPS[0], fields: [{ key: 'orders', path: 'trigger.output.orders[*].total', sample: [129.5, 49] }] }];
        const onValue = vi.fn();
        render(
            <VariablePickerProvider groups={groups} previewSample={SAMPLE} stepLabelById={LABELS} stepTypeById={null}>
                <Harness onValue={onValue} label="Priority" schema={{ type: 'number' }} field="priority" />
            </VariablePickerProvider>,
        );
        await userEvent.click(screen.getByRole('button', { name: /Use data from a step/ }));
        await userEvent.click(await screen.findByText('Orders'));
        expect(onValue.mock.calls.at(-1)?.[0]).toMatchObject({ take: 'first', as: 'number' });
    });

    // Confirmed bug: "A plain-text drop is treated as a binding path".
    it('a drop of words is left to the browser; a dropped value is taken', () => {
        const { onValue } = renderSlot({ field: 'to', schema: { type: 'string' } });
        const slot = screen.getByTestId('value-slot');
        const drop = (data: Record<string, string>) => {
            const e = new Event('drop', { bubbles: true, cancelable: true });
            Object.assign(e, { dataTransfer: { types: Object.keys(data), getData: (t: string) => data[t] ?? '' } });
            act(() => { slot.dispatchEvent(e); });
            return e;
        };
        expect(drop({ 'text/plain': 'some words' }).defaultPrevented).toBe(false);
        expect(onValue).not.toHaveBeenCalled();
        const source = { root: 'trigger', path: ['customer', 'name'] };
        expect(drop({ [SOURCE_MIME]: JSON.stringify({ source }) }).defaultPrevented).toBe(true);
        expect(onValue.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'pick', from: source });
    });
});

describe('ValueSlot — stored values', () => {
    beforeEach(cleanup);

    it('a legacy ref shows as its chip and is not rewritten until it is changed', async () => {
        const { onValue, last } = renderSlot({ field: 'body', schema: { type: 'string' }, initial: { kind: 'ref', path: 'trigger.output.orders[*].lines[*].product' } });
        expect(chip().textContent).toContain('Product of all lines');
        expect(onValue).not.toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', { name: /^Change how/ }));
        // The options say the value is rewritten when one is chosen, and show what each gives.
        expect(screen.getByTestId('pick-options-note')).toBeTruthy();
        await userEvent.click(within(screen.getByTestId('pick-options')).getByRole('radio', { name: /with commas/ }));
        expect(last()).toMatchObject({ kind: 'pick', v: 1, take: 'all', as: 'text', join: 'comma' });
    });

    it('anything else is a grey Formula chip, edited as stored under Formula', async () => {
        renderSlot({ initial: { kind: 'template', value: 'Beste {{trigger.output.customer.name}}' } });
        expect(chip().getAttribute('data-state')).toBe('formula');
        expect(screen.getByTestId('value-slot').textContent).toContain('Beste ‹Incoming data › Customer › Name›');
        // …and what it gives on the sample, so it is never a value nobody can check.
        expect(screen.getByTestId('formula-preview').textContent).toMatch(/^Gives:Beste \S/);
        await userEvent.click(screen.getByRole('button', { name: 'Formula' }));
        expect(screen.getByTestId('slot-formula')).toBeTruthy();
        expect(screen.getByRole('group', { name: 'Value mode' })).toBeTruthy();
    });

    it('a pick whose step is gone is amber, with "Pick again"', () => {
        renderSlot({ initial: { kind: 'pick', v: 1, from: { root: 'steps', id: 'removed', path: ['email'] }, take: 'one', as: 'native' } });
        expect(chip().getAttribute('data-state')).toBe('stale');
        expect(chip().textContent).toContain('No longer available');
        expect(within(chip()).getByRole('button', { name: 'Pick again' })).toBeTruthy();
    });

    // Confirmed bug: "trigger.<field> without .output looks like a valid chip
    // but resolves to undefined". It reads nothing at run time, so it is amber.
    it('a stored trigger.<key> without .output is shown as gone, not as a working chip', () => {
        renderSlot({ initial: { kind: 'ref', path: 'trigger.subject' } });
        expect(chip().getAttribute('data-state')).toBe('stale');
    });

    it('a condition operand stores the legacy spelling', () => {
        const { pick, last } = renderSlot({ storage: 'legacy', expectKind: 'number' });
        pick('trigger.output.orders[*].total');
        expect(last()).toEqual({ kind: 'expr', value: 'first(trigger.output.orders[*].total)' });
        expect(sentence().textContent).toContain('Only the first of 2.');
    });

    it('a path field stores the path of the list and offers the lists found', async () => {
        const { last } = renderSlot({
            storage: 'path', allowTyping: false, expectArray: true,
            quickPicks: [{ path: 'trigger.output.orders' }, { path: 'trigger.output.people' }],
        });
        await userEvent.click(screen.getByRole('button', { name: /^Orders/ }));
        expect(last()).toBe('trigger.output.orders');
        expect(chip().textContent).toContain('Orders');
        expect(screen.queryByText(/trigger\.output/)).toBeNull();
    });
});

// Review M4b: a column clicked or dragged from a table view (TableTakeover's
// ColHeader) comes as a Source with a WILD segment, which a stored pick
// refuses. The click stored an invalid pick (a grey Formula that gives
// nothing at run time), the drop did nothing at all.
describe('ValueSlot — a column of a table view', () => {
    beforeEach(cleanup);

    const resolver = createResolver({ evaluate, parse });
    const EMAILS = ['ada@x.nl', 'bo@x.nl'];

    /** A table view's column header, wired the way OutputView wires it. */
    function ColumnHeader({ onPick }: { onPick: (path: string, opts: InsertOpts) => void }) {
        const map: MapCtx = { path: 'trigger.output.people', source: { root: 'trigger', path: ['people'] }, onPick };
        return <span data-testid="column" {...mapAttrs(map, [WILD, ...colSegments('E-mail')])}>E-mail</span>;
    }

    function renderWithColumn(props: Partial<ValueSlotProps> = {}) {
        const onValue = vi.fn();
        let handle: FieldHandle | null = null;
        render(
            <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={LABELS} stepTypeById={null}>
                <Harness label="Ontvangers" field="to" onValue={onValue} onFocusField={(h) => { handle = h; }} {...props} />
                <ColumnHeader onPick={(path, opts) => handle?.insert(path, opts)} />
            </VariablePickerProvider>,
        );
        act(() => { screen.getByTestId('value-slot').dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
        return { onValue, last: () => onValue.mock.calls.at(-1)?.[0] };
    }

    it('a click stores a valid pick that gives the column', async () => {
        const { last } = renderWithColumn({ schema: { type: 'array', items: { type: 'string' } } });
        await userEvent.click(screen.getByTestId('column'));
        expect(isPick(last())).toBe(true);
        expect(last()).toMatchObject({ from: { root: 'trigger', path: ['people', 'E-mail'] }, take: 'all', as: 'list' });
        expect(resolver.resolveValue(last(), SAMPLE, { silent: true })).toEqual(EMAILS);
        expect(chip().getAttribute('data-state')).toBe('ok');
    });

    it('a drop stores the same pick; a drag with only the path is taken too', () => {
        const { last, onValue } = renderWithColumn({ schema: { type: 'string' } });
        const data: Record<string, string> = {};
        const start = { stopPropagation: () => {}, dataTransfer: { setData: (k: string, v: string) => { data[k] = v; }, effectAllowed: '' } };
        const attrs = mapAttrs({ path: 'trigger.output.people', source: { root: 'trigger', path: ['people'] } }, [WILD, ...colSegments('E-mail')]);
        attrs.onDragStart?.(start as never);
        const drop = (payload: Record<string, string>) => {
            const e = new Event('drop', { bubbles: true, cancelable: true });
            Object.assign(e, { dataTransfer: { types: Object.keys(payload), getData: (t: string) => payload[t] ?? '' } });
            act(() => { screen.getByTestId('value-slot').dispatchEvent(e); });
            return e;
        };
        expect(drop(data).defaultPrevented).toBe(true);
        expect(isPick(last())).toBe(true);
        expect(last()).toMatchObject({ from: { path: ['people', 'E-mail'] }, take: 'all', as: 'text' });
        expect(resolver.resolveValue(last(), SAMPLE, { silent: true })).toBe(EMAILS.join(', '));
        onValue.mockClear();
        act(() => { screen.getByRole('button', { name: /^Remove/ }).click(); });
        expect(drop({ 'application/x-binding-path': 'trigger.output.people[*].Naam' }).defaultPrevented).toBe(true);
        expect(last()).toMatchObject({ kind: 'pick', from: { path: ['people', 'Naam'] } });
    });
});

describe('ValueSlot — review M4b', () => {
    beforeEach(cleanup);

    // A stored template is text with values (the old editor wrote them all);
    // a pick adds to it, it does not replace it.
    it('a value picked into a stored template is added to it', () => {
        const { pick, last } = renderSlot({ field: 'body', schema: { type: 'string' }, initial: { kind: 'template', value: 'Beste {{trigger.output.customer.name}}, ' } });
        pick('trigger.output.customer.email');
        expect(last()).toEqual({ kind: 'template', value: 'Beste {{trigger.output.customer.name}}, {{trigger.output.customer.email}}' });
        expect(screen.queryByTestId('slot-replaced')).toBeNull();
    });

    // The clicked path's [*] stay in the legacy spelling when the sample does not know the step.
    it('a legacy slot keeps the [*] of the clicked path when the sample says nothing', () => {
        const { getHandle, last } = renderSlot({ storage: 'legacy', expectKind: 'number' });
        act(() => { getHandle()?.insert('steps.g.output.messages[*].size', { shape: 'list' }); });
        expect(last()).toEqual({ kind: 'expr', value: 'first(steps.g.output.messages[*].size)' });
    });

    // Advanced › Formula of a pick showed its JSON; a keystroke then saved that JSON as text.
    it('Formula on a picked value shows its formula, never the stored JSON', async () => {
        const { pick } = renderSlot({ field: 'body', schema: { type: 'string' }, label: 'Bericht' });
        pick('trigger.output.orders[*].total');
        await userEvent.click(within(sentence()).getByRole('button', { name: 'Change' }));
        await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
        await userEvent.click(screen.getByRole('button', { name: /Write a formula instead/ }));
        const formula = screen.getByTestId('slot-formula');
        expect(formula.textContent).not.toContain('"kind"');
        expect(formula.textContent).toMatch(/join\(/);
    });

    it('Formula on a composed text shows it as a template; a bulleted list offers no Formula', async () => {
        const compose = { kind: 'compose', v: 1, parts: ['Hallo ', { from: { root: 'trigger', path: ['customer', 'name'] }, take: 'one', as: 'text' }] };
        renderSlot({ field: 'body', schema: { type: 'string' }, initial: compose });
        await userEvent.click(screen.getByRole('button', { name: /as a formula/ }));
        expect(screen.getByTestId('slot-formula').textContent).not.toContain('"kind"');
        expect(screen.getByTestId('slot-formula').textContent).toContain('Hallo');
        cleanup();
        const bullets = { kind: 'pick', v: 1, from: { root: 'trigger', path: ['orders', 'id'] }, take: 'all', as: 'text', join: 'bullets' };
        renderSlot({ field: 'body', schema: { type: 'string' }, initial: bullets });
        await userEvent.click(within(sentence()).getByRole('button', { name: 'Change' }));
        await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
        expect(screen.queryByRole('button', { name: /Write a formula instead/ })).toBeNull();
    });
});
