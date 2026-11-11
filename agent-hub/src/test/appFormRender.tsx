// Render one App Studio input inside the real AppForm, as a run-mode app does, and read what the form submits.
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import AppForm from '@/components/admin/Studio/AppStudio/runtime/components/AppForm';
import { DEFAULT_RUNTIME, RuntimeProvider, buildScope } from '@/components/admin/Studio/AppStudio/runtime/RuntimeContext';

interface InputNode {
    id: string;
    type: string;
    props: Record<string, unknown>;
    [key: string]: unknown;
}

/** A node of `type` named `name` with the given props, as the canonicalizer would store it. */
export const inputNode = (type: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}): InputNode => ({
    id: `cmp_${type}`, type, visible: true, style: { span: 12 }, props: { name: 'field', label: 'Field', ...props }, ...extra,
});

/** `input` inside a form whose submit and whose field changes run actions; `runAction` records them. */
export function renderInForm(node: InputNode, input: ReactElement, vars: Record<string, unknown> = {}) {
    const runAction = vi.fn();
    const form = {
        id: 'cmp_form', type: 'form', visible: true, onSubmit: 'act_submit',
        props: { name: 'f', submitLabel: 'Send', showReset: false }, style: { span: 12, gap: 3, padding: 0 },
        children: [node],
    };
    const value = { ...DEFAULT_RUNTIME, mode: 'run' as const, runAction, scope: buildScope({ vars, now: '2026-01-01T00:00:00.000Z' }) };
    const view = render(<RuntimeProvider value={value}><AppForm node={form as never}>{input}</AppForm></RuntimeProvider>);
    const user = userEvent.setup();
    const submit = async () => { await user.click(view.getByRole('button', { name: 'Send' })); };
    /** The form values of the last run of `actionId` (the submit action by default). */
    const lastValues = (actionId = 'act_submit') => {
        const calls = runAction.mock.calls.filter((call) => call[0] === actionId);
        return calls.length ? (calls[calls.length - 1][1] as { formValues: Record<string, unknown> }).formValues : undefined;
    };
    return { ...view, user, submit, lastValues, runAction };
}
