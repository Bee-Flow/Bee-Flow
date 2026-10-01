import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StepRepeatSection from './StepRepeatSection';
import SettingsFormJs from '../../SettingsForm';
import { VariablePickerProvider as VariablePickerProviderJs } from '../../../mapping/VariablePickerContext';
import scopedStorage from '../../../../../../utils/scopedStorage';

const SettingsForm = SettingsFormJs as unknown as ComponentType<Record<string, unknown>>;
const VariablePickerProvider = VariablePickerProviderJs as unknown as ComponentType<Record<string, unknown> & { children: ReactNode }>;

const ORDERS = [{ email: 'a@b.nl', klant: 'Ada' }, { email: 'c@d.nl', klant: 'Bob' }];
const SAMPLE = { steps: { get: { output: { orders: ORDERS } } } };
const GROUPS = [{
    id: 'get', label: 'Get orders', kind: 'integration_action', basePath: 'steps.get.output', sample: SAMPLE.steps.get.output,
    fields: [{ key: 'orders', path: 'steps.get.output.orders', sample: ORDERS }],
}];
const LABELS = new Map([['get', 'Get orders']]);
const OVER = { root: 'steps', id: 'get', path: ['orders'] };

type Draft = Record<string, unknown>;

/** The section over a live draft, the way SettingsForm hands it `draft` and `set`. */
function Harness({ initial, stepType, spy }: { initial: Draft; stepType: string; spy: (d: Draft) => void }) {
    const [draft, setDraft] = useState<Draft>(initial);
    spy(draft);
    const set = (k: string, v: unknown) => setDraft(d => ({ ...d, [k]: v }));
    return (
        <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={LABELS}>
            <StepRepeatSection draft={draft} set={set} stepType={stepType} groups={GROUPS} />
        </VariablePickerProvider>
    );
}

function renderSection(initial: Draft, stepType = 'integration_action') {
    let latest: Draft = initial;
    render(<Harness initial={initial} stepType={stepType} spy={(d) => { latest = d; }} />);
    return { draft: () => latest, user: userEvent.setup() };
}

const toggle = () => screen.getByRole('checkbox', { name: /Run this step separately for each/ });

describe('StepRepeatSection — the one place a step is set to run per item', () => {
    beforeEach(cleanup);

    it('turns per item on over a chosen list, after saying what it does', async () => {
        const { draft, user } = renderSection({ inputs: { to: { kind: 'ref', path: 'steps.get.output.orders[*].email' } }, repeat: null, forEach: null });
        expect(toggle()).not.toBeChecked();
        await user.click(toggle());
        const choices = screen.getByTestId('repeat-list-choices');
        expect(within(choices).getByText('2 items')).toBeTruthy();
        await user.click(within(choices).getByText('Orders from Get orders'));
        // A preview first; nothing is written yet.
        expect(screen.getByTestId('repeat-preview').textContent).toContain('1 value will read the current item.');
        expect(draft().repeat).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Turn on' }));
        expect(draft().repeat).toEqual({ over: OVER, max: 100 });
        expect((draft().inputs as Record<string, unknown>).to).toEqual({ kind: 'pick', v: 1, from: { ...OVER, path: ['orders', 'email'] }, take: 'each', as: 'native' });
        expect(screen.getByRole('button', { name: /Orders from Get orders/ }).textContent).toContain('2×');
    });

    it('says so in amber when no value would read the item', async () => {
        const { user } = renderSection({ inputs: {}, repeat: null, forEach: null });
        await user.click(toggle());
        await user.click(screen.getByText('Orders from Get orders'));
        expect(screen.getByTestId('repeat-preview').textContent).toContain('every run would do the same thing');
        // Where to pick them: the group named after the list, on top of Comes in.
        expect(screen.getByTestId('repeat-preview').textContent).toContain('pick values from “Current order” at the top of Comes in');
    });

    it('regression: switching it off leaves no per-item run, and the values read the whole list', async () => {
        const { draft, user } = renderSection({
            inputs: { to: { kind: 'pick', v: 1, from: { ...OVER, path: ['orders', 'email'] }, take: 'each', as: 'text' } },
            repeat: { over: OVER, max: 100 }, forEach: null,
        });
        expect(toggle()).toBeChecked();
        await user.click(toggle());
        expect(draft().repeat).toBeNull();
        expect(draft().forEach ?? null).toBeNull();
        expect((draft().inputs as Record<string, { take: string; as: string }>).to).toMatchObject({ take: 'all', as: 'text' });
    });

    it('regression: renaming the item of the older setting carries its values along', async () => {
        const { draft, user } = renderSection({
            inputs: { to: { kind: 'ref', path: 'loop.item.email' } },
            forEach: { overRef: 'steps.get.output.orders', itemVar: 'item', maxIterations: 100 }, repeat: null,
        });
        const name = screen.getByRole('textbox', { name: 'Name each item' });
        await user.tripleClick(name);
        await user.keyboard('row');
        expect(draft().forEach).toEqual({ overRef: 'steps.get.output.orders', itemVar: 'row', maxIterations: 100 });
        expect((draft().inputs as Record<string, unknown>).to).toEqual({ kind: 'ref', path: 'loop.row.email' });
        // No binding syntax on screen.
        expect(screen.queryByText(/loop\./)).toBeNull();
    });

    it('the older setting switched off: its item refs read the whole list again', async () => {
        const { draft, user } = renderSection({
            inputs: { to: { kind: 'ref', path: 'loop.item.email' } },
            forEach: { overRef: 'steps.get.output.orders', itemVar: 'item', maxIterations: 100 }, repeat: null,
        });
        await user.click(toggle());
        expect(draft().forEach).toBeNull();
        expect((draft().inputs as Record<string, unknown>).to).toEqual({ kind: 'pick', v: 1, from: { ...OVER, path: ['orders', 'email'] }, take: 'all', as: 'native' });
    });
});

describe('the step header says it, and links to the setting', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    const catalog = {
        apps: [{
            id: 'mail', label: 'Mail',
            actions: [{
                name: 'mail_send', label: 'Send mail',
                inputSchema: { type: 'object', properties: { to: { type: 'string', title: 'To' } }, required: ['to'] },
            }],
        }],
    };

    function renderForm(step: Record<string, unknown>, onFocusField: ((h: unknown) => void) | null = null) {
        return render(
            <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={LABELS}>
                <SettingsForm
                    step={step} modelTiers={{}} stepIssues={{ errors: [], warnings: [] }}
                    saving={false} saveError={null} onPatch={vi.fn()} catalog={catalog} groups={GROUPS}
                    previewSample={SAMPLE} onFocusField={onFocusField}
                />
            </VariablePickerProvider>,
        );
    }

    it('one read-only sentence while it is on, in words, with a link that opens the setting', async () => {
        const user = userEvent.setup();
        renderForm({
            id: 'm1', type: 'integration_action', tool: 'mail_send', label: 'Mail',
            inputs: { to: { kind: 'pick', v: 1, from: { ...OVER, path: ['orders', 'email'] }, take: 'each', as: 'native' } },
            repeat: { over: OVER, max: 100 },
        });
        const notice = screen.getByTestId('repeat-notice');
        expect(notice.textContent).toContain('Runs separately for each item in Orders from Get orders (2×).');
        expect(notice.textContent).not.toMatch(/steps\.|loop\.|\[\*\]/);
        await user.click(within(notice).getByRole('button', { name: 'Change' }));
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(toggle()).toBeChecked();
    });

    it('says nothing when the step runs once', () => {
        renderForm({ id: 'm1', type: 'integration_action', tool: 'mail_send', label: 'Mail', inputs: {} });
        expect(screen.queryByTestId('repeat-notice')).toBeNull();
    });

    it('regression: a list picked into a field offers no "separate run per item" there any more', async () => {
        const handle: { current: { insert: (p: string) => void } | null } = { current: null };
        renderForm(
            { id: 'm1', type: 'integration_action', tool: 'mail_send', label: 'Mail', inputs: {} },
            (h) => { handle.current = h as { insert: (p: string) => void }; },
        );
        const user = userEvent.setup();
        const slot = within(screen.getByTestId('param-to')).getByTestId('value-slot');
        act(() => { slot.focus(); slot.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
        expect(handle.current).toBeTruthy();
        act(() => { handle.current!.insert('steps.get.output.orders'); });
        // The list's own choices are all still there; a run per item is not
        // (it lives under Advanced › Run this step separately for each…).
        await user.click(within(screen.getByTestId('pick-sentence')).getByRole('button', { name: 'Change' }));
        const options = () => screen.getByTestId('pick-options');
        const advanced = within(options()).queryByRole('button', { name: 'Advanced' });
        if (advanced) await user.click(advanced);
        expect(within(options()).queryByRole('button', { name: /separately for each item/ })).toBeNull();
        expect(within(options()).queryByRole('radio', { name: /One per run, for each item/ })).toBeNull();
        expect(screen.queryByTestId('repeat-notice')).toBeNull();
    });
});
