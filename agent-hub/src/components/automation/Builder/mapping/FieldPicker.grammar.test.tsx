import type { ComponentType } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import FieldPickerJs from './FieldPicker';
import FieldKeyComboboxJs from './FieldKeyCombobox';

/**
 * The two field-name pickers build a path from what a person types or drops.
 * A field named in plain words must come out as a path the RUNTIME reads,
 * and a dropped path must give back the key it ends in, however it is quoted.
 */
const FieldPicker = FieldPickerJs as unknown as ComponentType<Record<string, unknown>>;
const FieldKeyCombobox = FieldKeyComboboxJs as unknown as ComponentType<Record<string, unknown>>;

afterEach(cleanup);

describe('FieldPicker: a typed name', () => {
    it('with a space or a hyphen is quoted, so the run reads it', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<FieldPicker options={[]} onChange={onChange} />);
        await user.click(screen.getByRole('button', { name: /Choose a field/ }));
        await user.type(screen.getByPlaceholderText('Search fields…'), 'Story Points');
        await user.click(screen.getByText('Use “Story Points”'));
        expect(onChange).toHaveBeenCalledWith({ kind: 'ref', path: 'item["Story Points"]' });
        expect(getPath({ item: { 'Story Points': 5 } }, 'item["Story Points"]')).toBe(5);
    });

    it('that is a path stays a path, in its canonical spelling', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<FieldPicker options={[]} onChange={onChange} />);
        await user.click(screen.getByRole('button', { name: /Choose a field/ }));
        await user.type(screen.getByPlaceholderText('Search fields…'), 'headers.content-type');
        await user.click(screen.getByText('Use “headers.content-type”'));
        expect(onChange).toHaveBeenCalledWith({ kind: 'ref', path: 'item.headers["content-type"]' });
    });

    it('labels a quoted path by its last key', () => {
        render(<FieldPicker options={[]} onChange={vi.fn()} value={{ kind: 'ref', path: 'item["first-name"]' }} />);
        expect(screen.getByRole('button', { name: /First name/i })).toBeTruthy();
    });
});

describe('FieldKeyCombobox: an inserted path', () => {
    it('keeps the key it ends in, quoted or not', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        let insert: ((p: string) => void) | null = null;
        render(<FieldKeyCombobox value="" onChange={onChange} options={[]} onFocusField={(f: { insert: (p: string) => void }) => { insert = f.insert; }} />);
        await user.click(screen.getByRole('textbox'));
        expect(insert).not.toBeNull();
        insert!('steps.s.output.items[*]["first-name"]');
        expect(onChange).toHaveBeenLastCalledWith('first-name');
        insert!('steps.s.output.items[*].email');
        expect(onChange).toHaveBeenLastCalledWith('email');
    });
});
