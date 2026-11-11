import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import ActionRunOptions, { writtenVarNames } from './ActionRunOptions';
import type { AppAction } from './appDefinition';

function renderOptions(action: AppAction) {
    const commit = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={client}>
            <ActionRunOptions action={action} commitAction={commit} definition={{ screens: [], variables: [{ name: 'declared', type: 'text' }] } as never} />
        </QueryClientProvider>,
    );
    return commit;
}

const STEPS = [
    { kind: 'set_variable', name: 'status', value: { kind: 'static', value: 'go' } },
    { kind: 'condition', expr: 'true', then: [{ kind: 'ai_generate', prompt: 'x', resultVar: 'summary' }], else: [] },
];

describe('ActionRunOptions', () => {
    it('turning background on commits only background: true; off removes every option', async () => {
        const commit = renderOptions({ kind: 'sequence', steps: STEPS });
        await userEvent.click(screen.getByRole('checkbox', { name: 'Keep running when the page is closed' }));
        expect(commit).toHaveBeenLastCalledWith({ kind: 'sequence', steps: STEPS, background: true });
    });

    it('off removes background, lockKey and progressVar', async () => {
        const commit = renderOptions({ kind: 'sequence', steps: STEPS, background: true, lockKey: { kind: 'formula', expr: 'item.id' }, progressVar: 'status' });
        await userEvent.click(screen.getByRole('checkbox', { name: 'Keep running when the page is closed' }));
        expect(commit).toHaveBeenLastCalledWith({ kind: 'sequence', steps: STEPS });
    });

    it('running on the server commits only runOn: "server" and offers the lock and the progress text; off removes them', async () => {
        const commit = renderOptions({ kind: 'sequence', steps: STEPS });
        expect(screen.queryByRole('combobox', { name: 'Progress text' })).toBeNull();
        await userEvent.click(screen.getByRole('checkbox', { name: 'Run the whole action on the server' }));
        expect(commit).toHaveBeenLastCalledWith({ kind: 'sequence', steps: STEPS, runOn: 'server' });
    });

    it('with runOn on, the lock and progress fields show; turning it off removes them unless the action also runs in the background', async () => {
        const commit = renderOptions({ kind: 'sequence', steps: STEPS, runOn: 'server', progressVar: 'status' });
        expect(screen.getByRole('combobox', { name: 'Progress text' })).toBeTruthy();
        await userEvent.click(screen.getByRole('checkbox', { name: 'Run the whole action on the server' }));
        expect(commit).toHaveBeenLastCalledWith({ kind: 'sequence', steps: STEPS });
    });

    it('background and runOn are independent: switching one off keeps the options the other still uses', async () => {
        const both = { kind: 'sequence', steps: STEPS, background: true, runOn: 'server' as const, progressVar: 'status' };
        const commit = renderOptions(both);
        await userEvent.click(screen.getByRole('checkbox', { name: 'Keep running when the page is closed' }));
        expect(commit).toHaveBeenLastCalledWith({ kind: 'sequence', steps: STEPS, runOn: 'server', progressVar: 'status' });
        await userEvent.click(screen.getByRole('checkbox', { name: 'Run the whole action on the server' }));
        expect(commit).toHaveBeenLastCalledWith({ kind: 'sequence', steps: STEPS, background: true, progressVar: 'status' });
    });

    it('the progress text offers what the sequence writes and the declared variables', async () => {
        const commit = renderOptions({ kind: 'sequence', steps: STEPS, background: true });
        const select = screen.getByRole('combobox', { name: 'Progress text' });
        const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
        expect(options).toEqual(['', 'status', 'summary', 'declared']);
        await userEvent.selectOptions(select, 'status');
        expect(commit).toHaveBeenLastCalledWith({ kind: 'sequence', steps: STEPS, background: true, progressVar: 'status' });
    });

    it('writtenVarNames walks branches, loop bodies and handlers', () => {
        const names = writtenVarNames([
            { kind: 'loop', steps: [{ kind: 'set_variable', name: 'inLoop' }] },
            { kind: 'create_record', resultVar: 'rec', onError: { steps: [{ kind: 'set_variable', name: 'why' }] } },
        ]);
        expect([...names]).toEqual(['inLoop', 'rec', 'why']);
    });
});
