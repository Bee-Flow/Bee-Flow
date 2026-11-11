import { describe, expect, it, vi } from 'vitest';
import { partNames, renderScreen } from '@/test/appScreenRender';
import { stepFieldNames, stepHolding } from './wizardSteps';

const input = (id: string, name: string, required = false) => ({ id, type: 'input_text', visible: true, props: { name, label: name, required }, style: { span: 12 } });
const body = (id: string, nodes: unknown[]) => ({ id, type: 'container', visible: true, props: {}, style: { span: 12 }, children: nodes });

const wizard = {
    id: 'cmp_wiz', type: 'wizard', visible: true, style: { span: 12, gap: 3, padding: 0 },
    props: { steps: [{ title: 'You' }, { title: 'Address', description: 'Where we deliver.' }] },
    children: [body('cmp_s1', [input('cmp_name', 'name', true)]), body('cmp_s2', [input('cmp_city', 'city')])],
};
const form = { id: 'cmp_form', type: 'form', visible: true, onSubmit: 'act_send', props: { name: 'order', submitLabel: 'Send' }, style: { span: 12, gap: 3, padding: 0 }, children: [wizard] };
const ACTIONS = { act_send: { kind: 'toast', message: 'Sent' } };

describe('AppWizard', () => {
    it('shows the first step, marks it current and draws every declared part', () => {
        const { getByRole, getByText, container, queryByLabelText } = renderScreen([form], {}, ACTIONS);
        expect(getByRole('group', { name: 'You' })).toBeTruthy();
        expect(getByText('You').closest('li')?.getAttribute('aria-current')).toBe('step');
        expect(queryByLabelText('city')).toBeNull();
        const { rendered, declared } = partNames('wizard', container);
        expect(rendered).toEqual(declared);
    });

    it('Next checks the step with the form rules, moves on, and the form sends every step', async () => {
        const runAction = vi.fn();
        const { getByRole, getByLabelText, findByText, user } = renderScreen([form], { runAction }, ACTIONS);
        await user.click(getByRole('button', { name: 'Next' }));
        expect(await findByText('This field is required.')).toBeTruthy();
        expect(getByRole('group', { name: 'You' })).toBeTruthy();
        await user.type(getByLabelText(/name/), 'Ann');
        await user.click(getByRole('button', { name: 'Next' }));
        const panel = getByRole('group', { name: 'Address' });
        expect(document.activeElement).toBe(panel);
        expect(getByRole('button', { name: 'Back' })).not.toHaveProperty('disabled', true);
        expect(() => getByRole('button', { name: 'Next' })).toThrow();
        await user.type(getByLabelText(/city/), 'Delft');
        await user.click(getByRole('button', { name: 'Send' }));
        expect(runAction).toHaveBeenCalledWith('act_send', expect.objectContaining({ formValues: { name: 'Ann', city: 'Delft' } }));
    });

    it('on the canvas it shows the step that holds the selected node', () => {
        const { getByRole } = renderScreen([form], { mode: 'edit', selectedNodeId: 'cmp_city' }, ACTIONS);
        expect(getByRole('group', { name: 'Address' })).toBeTruthy();
    });

    it('finds the fields of a step and the step of a node', () => {
        expect(stepFieldNames(wizard.children[0] as never)).toEqual(['name']);
        expect(stepHolding(wizard.children as never, 'cmp_city')).toBe(1);
        expect(stepHolding(wizard.children as never, null)).toBe(-1);
    });
});
