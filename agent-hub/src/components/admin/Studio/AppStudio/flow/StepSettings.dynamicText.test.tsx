import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import StepSettings from './StepSettings';
import { EditorChromeContext } from '../editor/EditorChromeContext';
import { stub } from '@/test/mocks';

/**
 * The step panel is drawn from the spec, so a formula field added to the spec gets a formula editor with a
 * label of its own. A switch case gets a second input for its formula, and the formula and the value never
 * stand together on one case.
 */

const STEP_SPECS_STUB = {
    toast: { fields: {
        message: { type: 'string', required: true, maxLen: 500 },
        tone: { type: 'enum', values: ['info', 'success'], default: 'info' },
        messageExpr: { type: 'formula', since: 3 },
    } },
    open_url: { fields: { url: { type: 'url', required: true }, newTab: { type: 'boolean', default: true }, urlExpr: { type: 'formula', since: 3 } } },
    switch: { fields: { expr: { type: 'formula', required: true }, cases: { type: 'switchCases', required: true }, default: { type: 'steps' } } },
};

vi.mock('../studioAppsApi', () => ({
    studioAppsApi: { getCatalog: vi.fn(async () => ({ components: {}, actions: { stepSpecs: STEP_SPECS_STUB } })) },
}));
vi.mock('@/utils/helpers', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, authFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) };
});
vi.mock('@/hooks/useAutomationApi', () => ({ default: () => ({ listAutomations: vi.fn(async () => ({ automations: [] })) }) }));

const DEFINITION = { schemaVersion: 3, meta: { name: 'T' }, homeScreenId: 'scr_a', screens: [{ id: 'scr_a', name: 'List', sections: [] }], actions: {} };

function renderStep(step: ComponentProps<typeof StepSettings>['step']) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onChange = vi.fn();
    render(
        <QueryClientProvider client={client}>
            <EditorChromeContext.Provider value={{ appId: 'app-1' }}>
                <StepSettings step={step} onChange={onChange} definition={stub<ComponentProps<typeof StepSettings>['definition']>(DEFINITION)} screens={DEFINITION.screens} />
            </EditorChromeContext.Provider>
        </QueryClientProvider>,
    );
    return { onChange, last: () => onChange.mock.calls.at(-1)?.[0] };
}

describe('StepSettings: formula fields of the dynamic-text additions', () => {
    it('shows a toast message formula with its own label, beside the literal message', async () => {
        renderStep({ kind: 'toast', message: 'plain', tone: 'info' });
        expect(await screen.findByLabelText('Message (formula)')).toBeTruthy();
        expect(screen.getByLabelText('Message')).toBeTruthy();
    });

    it('writes the formula into the step and leaves the rest of it alone', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({ kind: 'toast', message: 'plain', tone: 'info' });
        const box = await screen.findByLabelText('Message (formula)');
        await user.type(box, 'x');
        expect(last()).toMatchObject({ kind: 'toast', message: 'plain', tone: 'info', messageExpr: 'x' });
    });

    it('labels the open_url address formula and says which hosts it can open', async () => {
        renderStep({ kind: 'open_url', url: 'https://example.com', newTab: true });
        expect(await screen.findByLabelText('Address (formula)')).toBeTruthy();
        expect(screen.getByText(/Links from formulas/)).toBeTruthy();
    });
});

describe('StepSettings: a switch case picked by a formula', () => {
    const base = { kind: 'switch', expr: 'vars.n', cases: [{ value: 'a', steps: [] }, { value: 'b', steps: [] }], default: [] };

    it('offers a formula input per case', async () => {
        renderStep(base);
        expect(await screen.findByLabelText('Case 1 formula')).toBeTruthy();
        expect(screen.getByLabelText('Case 2 formula')).toBeTruthy();
    });

    it('setting a formula drops the value of that case only', async () => {
        const user = userEvent.setup();
        const { last } = renderStep(base);
        await user.type(await screen.findByLabelText('Case 2 formula'), 'q');
        expect(last().cases).toEqual([{ value: 'a', steps: [] }, { whenExpr: 'q', steps: [] }]);
    });

    it('clearing the formula removes the key, so the case is as it was', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({ ...base, cases: [{ whenExpr: 'z', steps: [] }] });
        await user.clear(await screen.findByLabelText('Case 1 formula'));
        expect(last().cases).toEqual([{ steps: [] }]);
    });
});
