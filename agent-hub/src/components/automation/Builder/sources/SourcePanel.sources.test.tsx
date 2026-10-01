import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SourcePanel from './SourcePanel';
import { computeRepeatItemGroup, computeUpstreamGroups, overlayGroupWithReal } from '../mapping/upstream';

/**
 * The source panel over groups the core describes (M3): nested data opens
 * like folders at any depth, a list opens to its columns before any run, a
 * JSON string opens to what its text holds, and a key the last run lacked is
 * dimmed. Every pick hands over a path the run resolves and its Source.
 */
const ORDER = {
    Klant: { Naam: 'Jan', Adres: { Postcode: '1234 AB' } },
    Orderregels: [{ Product: 'Stoel', 'Unit price': 40 }, { Product: 'Tafel', 'Unit price': 120 }],
    body: '{"id": 7, "status": "paid"}',
};
const DEFINITION = {
    trigger: { id: 't', kind: 'manual' },
    steps: [
        { id: 'order', type: 'set', fields: Object.fromEntries(Object.entries(ORDER).map(([k, v]) => [k, { kind: 'literal', value: v }])) },
        { id: 'next', type: 'code' },
    ],
    edges: [{ from: 't', to: 'order' }, { from: 'order', to: 'next' }],
};
const groups = () => computeUpstreamGroups(DEFINITION, 'next', null).filter(g => g.id === 'order');

const renderPanel = (gs = groups()) => {
    const onPick = vi.fn();
    render(<SourcePanel groups={gs} previewSample={null} onPick={onPick} />);
    return { onPick };
};
const rowOf = (text: string) => screen.getByText(text).closest('[data-testid="source-node"]') as HTMLElement;
const openRow = async (text: string) => { await userEvent.click(within(rowOf(text)).getAllByRole('button')[0] as HTMLElement); };

describe('SourcePanel over core SourceNodes', () => {
    beforeEach(cleanup);

    it('opens nested objects like folders, at any depth', async () => {
        const { onPick } = renderPanel();
        await openRow('Klant');
        await openRow('Adres');
        await userEvent.click(screen.getByText('Postcode'));
        // The value's Source and its name's parts travel with it, so the field
        // can word and shape it without walking for it again.
        expect(onPick).toHaveBeenCalledWith('steps.order.output.Klant.Adres.Postcode', expect.objectContaining({
            raw: false,
            source: { root: 'steps', id: 'order', path: ['Klant', 'Adres', 'Postcode'] },
            labelParts: [
                { key: 'Klant', text: 'Klant' }, { key: 'Adres', text: 'Adres' }, { key: 'Postcode', text: 'Postcode' },
            ],
        }));
    });

    it('opens a list to its columns before any run, with escaped paths', async () => {
        const { onPick } = renderPanel();
        await openRow('Orderregels');
        await userEvent.click(screen.getByText('Unit price'));
        expect(onPick).toHaveBeenCalledWith('steps.order.output.Orderregels[*]["Unit price"]', expect.objectContaining({ raw: false }));
    });

    it('opens a JSON string to what the text holds, and does not offer those as paths', async () => {
        const { onPick } = renderPanel();
        expect(within(rowOf('Body')).getByTestId('source-from-text').textContent).toBe('read from text');
        await openRow('Body');
        const status = rowOf('Status');
        expect(status.getAttribute('draggable')).toBe('false');
        await userEvent.click(status);
        expect(onPick).not.toHaveBeenCalled();
    });

    it('dims a key the last run did not produce, and says so', async () => {
        const [g] = groups();
        renderPanel([overlayGroupWithReal(g, { Klant: { Naam: 'Piet' }, Orderregels: [], body: '{}' })]);
        expect(rowOf('Klant').getAttribute('data-unconfirmed')).toBeNull();
        await openRow('Klant');
        // Adres was in the static sample only: still offered, marked.
        expect(rowOf('Adres').getAttribute('data-unconfirmed')).toBe('true');
        expect(rowOf('Adres').getAttribute('title')).toContain('Not in the last run');
    });

    it('row titles are labels and values, never paths', async () => {
        renderPanel();
        await openRow('Klant');
        const title = rowOf('Naam').getAttribute('title') || '';
        expect(title).toContain('Klant › Naam');
        expect(title).not.toContain('steps.');
    });

    it('a step that runs once per item: its current item on top, named after the list, its values picked per item', async () => {
        const def = { ...DEFINITION, steps: [DEFINITION.steps[0], { id: 'next', type: 'code', repeat: { over: { root: 'steps', id: 'order', path: ['Orderregels'] } } }] };
        const sample = { steps: { order: { output: ORDER } } };
        const item = computeRepeatItemGroup(def, 'next', null, sample);
        expect(item).toBeTruthy();
        const onPick = vi.fn();
        render(<SourcePanel groups={[...groups(), item!]} previewSample={sample} onPick={onPick} />);
        const [first] = screen.getAllByTestId('input-group');
        expect(first.textContent).toContain('Current orderregel');
        // One item's value, not the whole column.
        expect(within(first).getByText('“Stoel”')).toBeTruthy();
        await userEvent.click(within(first).getByText('Product'));
        expect(onPick).toHaveBeenCalledWith('steps.order.output.Orderregels[*].Product', expect.objectContaining({
            take: 'each',
            source: { root: 'steps', id: 'order', path: ['Orderregels', 'Product'] },
        }));
    });
});
