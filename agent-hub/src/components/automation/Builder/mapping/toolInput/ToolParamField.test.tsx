import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QueryTestWrapper from '../../ndv/QueryTestWrapper';
import { VariablePickerProvider } from '../VariablePickerContext';
import ToolParamField from './ToolParamField';

const { usage } = vi.hoisted(() => ({ usage: { rows: [] as Array<{ value: string; count: number }> } }));
vi.mock('../../../../../api/queries/automation/ndv', () => ({
    useUsageValuesQuery: () => ({ data: usage.rows }),
}));

const wrap = (ui: ReactNode) => render(
    <QueryTestWrapper><VariablePickerProvider groups={[]} previewSample={null} stepLabelById={null} stepTypeById={null}>{ui}</VariablePickerProvider></QueryTestWrapper>,
);

const base = {
    fieldKey: 'folder', required: true, value: null, visual: true, allowRaw: true, autoMapped: false,
};

describe('ToolParamField — a setting in "What this step does" (round 4)', () => {
    beforeEach(() => { cleanup(); usage.rows = []; });

    it('draws a short enum as buttons, "recommended" on the default', async () => {
        const onChange = vi.fn();
        wrap(<ToolParamField {...base} fieldKey="filter" required={false} onChange={onChange}
            prop={{ type: 'string', title: 'Which files?', enum: ['all', 'files_only', 'pdf'], default: 'all' }} />);
        const group = screen.getByRole('radiogroup', { name: 'Which files?' });
        expect(group.textContent).toContain('All· recommended');
        await userEvent.click(screen.getByRole('radio', { name: /Files only/ }));
        expect(onChange).toHaveBeenCalledWith({ kind: 'literal', value: 'files_only' });
    });

    it('offers a suggestion for an empty required setting, applied only on a click', async () => {
        const onChange = vi.fn();
        wrap(<ToolParamField {...base} onChange={onChange} prop={{ type: 'string', title: 'Which folder?' }}
            suggestion={{ binding: { kind: 'literal', value: '/' }, label: 'Root folder /', source: 'default' }} />);
        const chip = screen.getByTestId('param-suggestion');
        expect(chip.textContent).toBe('Suggestion: Root folder /');
        expect(onChange).not.toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', { name: /Root folder/ }));
        expect(onChange).toHaveBeenCalledWith({ kind: 'literal', value: '/' });
    });

    it('lists the values this organisation uses most', async () => {
        usage.rows = [{ value: 'Invoices', count: 9 }, { value: 'Photos', count: 2 }];
        const onChange = vi.fn();
        wrap(<ToolParamField {...base} onChange={onChange} tool="nc_list" prop={{ type: 'string', title: 'Which folder?' }} />);
        expect(screen.getByTestId('param-frequent').textContent).toContain('Frequently used:');
        await userEvent.click(screen.getByRole('button', { name: 'Invoices' }));
        expect(onChange).toHaveBeenCalledWith({ kind: 'literal', value: 'Invoices' });
    });

    it('rings the setting the last run failed on and says why', () => {
        wrap(<ToolParamField {...base} onChange={vi.fn()} prop={{ type: 'string', title: 'Which folder?' }}
            value={{ kind: 'literal', value: '/Invoices' }} problem="No access to /Invoices" />);
        expect(screen.getByTestId('param-folder').getAttribute('data-problem')).toBe('true');
        expect(screen.getByTestId('param-problem').textContent).toBe('No access to /Invoices');
    });
});

describe('ToolParamField — the value slot and its name', () => {
    beforeEach(() => { cleanup(); usage.rows = []; });

    // Final review: an empty "Subject line" showed "Use data from a step", a
    // "Formula" link and a red dashed "still empty · expects: text · pick ▸ 10 fit".
    it('an empty required setting is calm: the field, one muted line, and a ⋯', async () => {
        const onChange = vi.fn();
        wrap(<ToolParamField {...base} fieldKey="subject" onChange={onChange} prop={{ type: 'string', title: 'Subject line' }}
            suggestion={{ binding: { kind: 'literal', value: 'Order' }, label: 'Order', source: 'default' }} />);
        const field = screen.getByTestId('param-subject');
        expect(screen.getByRole('textbox', { name: 'Subject line' }).getAttribute('placeholder')).toBe('Type a value, or pick one from Comes in');
        expect(screen.getByTestId('binding-empty-required').textContent).toBe('Required before this step can run.');
        expect(field.textContent).not.toMatch(/still empty|expects|pick ▸|fit|Use data from a step|Formula/);
        expect(screen.getAllByTestId('param-suggestion')).toHaveLength(1);
        await userEvent.click(screen.getByRole('button', { name: 'More ways to fill Subject line' }));
        expect(screen.getByRole('menuitem', { name: 'Use data from a step' })).toBeTruthy();
        await userEvent.click(screen.getByRole('menuitem', { name: 'Formula' }));
        expect(screen.getByTestId('slot-formula')).toBeTruthy();
    });

    it('names a setting in words, never by its raw key', () => {
        wrap(<ToolParamField {...base} fieldKey="to" required onChange={vi.fn()} prop={{ type: 'string' }} />);
        expect(screen.getByText('To')).toBeTruthy();
        cleanup();
        wrap(<ToolParamField {...base} fieldKey="cc" required={false} onChange={vi.fn()} prop={{ type: 'array', description: 'Extra recipients' }} />);
        expect(screen.getByText('Extra recipients')).toBeTruthy();
        expect(screen.queryByText('cc')).toBeNull();
    });

    it('draws the value slot: a picked value is a chip, typed text a field', () => {
        wrap(<ToolParamField {...base} fieldKey="subject" onChange={vi.fn()} prop={{ type: 'string', title: 'Subject' }}
            value={{ kind: 'pick', v: 1, from: { root: 'trigger', path: ['subject'] }, take: 'one', as: 'text' }} />);
        expect(screen.getByTestId('value-chip').textContent).toContain('Subject');
        expect(screen.queryByRole('group', { name: 'Value mode' })).toBeNull();
    });
});
