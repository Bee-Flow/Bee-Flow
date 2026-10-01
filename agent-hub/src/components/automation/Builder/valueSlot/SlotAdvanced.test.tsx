import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editorValue, editorWithValue, typeInEditor } from '../../../../test/refEditor';
import SlotAdvanced, { type SlotAdvancedProps } from './SlotAdvanced';

const base: SlotAdvancedProps = {
    editing: false,
    onEditingChange: () => {},
    value: null,
    onChange: () => {},
    storage: 'binding',
    slot: { as: 'text', multiLine: false },
};

describe('SlotAdvanced — Formula, out of the way', () => {
    beforeEach(cleanup);

    // The way in is the slot's ⋯ (SlotMenu); closed, this draws nothing at all.
    it('draws nothing until the slot opens it, then the editor for a formula', () => {
        const formula = { kind: 'expr', value: 'upper(trigger.output.name)' };
        const { container, rerender } = render(<SlotAdvanced {...base} label="Subject" value={formula} />);
        expect(container.innerHTML).toBe('');
        rerender(<SlotAdvanced {...base} label="Subject" editing value={formula} />);
        expect(screen.getByRole('group', { name: 'Value mode' })).toBeTruthy();
    });

    it('edits the binding exactly as stored, and goes back on request', async () => {
        const onChange = vi.fn();
        const onEditingChange = vi.fn();
        render(<SlotAdvanced {...base} editing value={{ kind: 'expr', value: 'upper(trigger.output.name)' }} onChange={onChange} onEditingChange={onEditingChange} />);
        const host = editorWithValue(document.body, 'upper(trigger.output.name)');
        typeInEditor(host, 'lower(trigger.output.name)');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'expr', value: 'lower(trigger.output.name)' });
        await userEvent.click(screen.getByRole('button', { name: 'Back to the simple editor' }));
        expect(onEditingChange).toHaveBeenCalledWith(false);
    });

    it('a path field edits its path as a formula and gets a string back', () => {
        const onChange = vi.fn();
        render(<SlotAdvanced {...base} storage="path" editing value="steps.s1.output.items" onChange={onChange} />);
        const host = editorWithValue(document.body, 'steps.s1.output.items');
        typeInEditor(host, 'steps.s1.output.rows["Order date"]');
        expect(onChange).toHaveBeenLastCalledWith('steps.s1.output.rows["Order date"]');
        expect(editorValue(host)).toBe('steps.s1.output.rows["Order date"]');
    });

    // Review M4b: Text mode turned the path into a `{{ }}` template, stored
    // as a path the runtime cannot walk.
    it('a path field has no Text mode, even when empty', () => {
        render(<SlotAdvanced {...base} storage="path" editing value="" />);
        expect(screen.queryByRole('group', { name: 'Value mode' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Text' })).toBeNull();
    });

    it('a picked value is edited as its formula; one without a formula has no editor', () => {
        const pick = { kind: 'pick', v: 1, from: { root: 'trigger', path: ['name'] }, take: 'one', as: 'text' };
        render(<SlotAdvanced {...base} editing value={pick} />);
        expect(editorWithValue(document.body, 'trigger.output.name')).toBeTruthy();
        cleanup();
        render(<SlotAdvanced {...base} editing value={{ ...pick, take: 'each' }} />);
        expect(screen.queryByTestId('slot-formula')).toBeNull();
    });
});
