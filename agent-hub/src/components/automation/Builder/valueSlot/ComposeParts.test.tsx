import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposeBinding } from '@shared/mapping/index.mjs';
import ComposeParts from './ComposeParts';

const SAMPLE = { trigger: { output: { customer: { name: 'Anna' }, tags: ['vip', 'nieuw'] } } };
const GROUPS = [{ id: 't', label: 'Bestelling ontvangen', basePath: 'trigger.output' }];
const COMPOSE: ComposeBinding = {
    kind: 'compose',
    v: 1,
    parts: ['Hallo ', { from: { root: 'trigger', path: ['customer', 'name'] }, take: 'one', as: 'text' }, ', labels: ',
        { from: { root: 'trigger', path: ['tags'] }, take: 'all', as: 'text', join: 'comma' }],
};

function renderParts(compose: ComposeBinding = COMPOSE) {
    const onChange = vi.fn();
    render(<ComposeParts compose={compose} onChange={onChange} sample={SAMPLE} slot={{ as: 'text', multiLine: false }} groups={GROUPS} />);
    return { onChange };
}

describe('ComposeParts — text with values in a whole-value field', () => {
    beforeEach(cleanup);

    it('shows the text and each value by name, with its example', () => {
        renderParts();
        expect(screen.getByDisplayValue(/Hallo/)).toBeTruthy();
        const chips = screen.getAllByTestId('value-chip');
        expect(chips.map(c => c.textContent)).toEqual(['Name of customerAnna', 'Tags from Bestelling ontvangen· 2vip, nieuw']);
    });

    it('a value\'s options change only that value, and keep it text', async () => {
        const { onChange } = renderParts();
        await userEvent.click(screen.getByRole('button', { name: /^Change how Tags/ }));
        await userEvent.click(within(screen.getByTestId('pick-options')).getByRole('radio', { name: /one per line/ }));
        const next = onChange.mock.calls.at(-1)?.[0] as ComposeBinding;
        expect(next.parts[3]).toEqual({ from: { root: 'trigger', path: ['tags'] }, take: 'all', as: 'text', join: 'lines' });
        expect(next.parts.slice(0, 3)).toEqual(COMPOSE.parts.slice(0, 3));
    });

    it('removing the last value leaves the typed text as plain text', async () => {
        const { onChange } = renderParts({ kind: 'compose', v: 1, parts: ['Hallo ', COMPOSE.parts[1]] });
        await userEvent.click(screen.getByRole('button', { name: /^Remove / }));
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'literal', value: 'Hallo ' });
    });
});
