import { act, fireEvent, screen } from '@testing-library/react-native';
import React, { createRef } from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { TagInput, addTag, type TagInputHandle } from './TagInput';

const lower = (v: string) => v.trim().toLowerCase();
const domain = (v: string) => (/^[a-z0-9-]+(\.[a-z]{2,})+$/.test(v) ? null : 'Not a domain');

describe('addTag', () => {
    it('adds a normalised value', () => {
        expect(addTag(['a.nl'], ' B.NL ', lower, domain)).toEqual({ next: ['a.nl', 'b.nl'] });
    });

    it('keeps the list as is for a duplicate or an empty value', () => {
        expect(addTag(['a.nl'], 'A.nl', lower)).toEqual({ next: ['a.nl'] });
        expect(addTag(['a.nl'], '   ', lower)).toEqual({ error: null });
    });

    it('refuses a value the validator rejects', () => {
        expect(addTag([], 'nope', lower, domain)).toEqual({ error: 'Not a domain' });
    });
});

describe('TagInput', () => {
    it('adds on submit', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<TagInput testID="tags" values={[]} onChange={onChange} normalize={lower} />);
        await fireEvent.changeText(screen.getByTestId('tags'), 'Acme.nl');
        await fireEvent(screen.getByTestId('tags'), 'submitEditing');
        expect(onChange).toHaveBeenLastCalledWith(['acme.nl']);
    });

    it('removes a value on tap', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<TagInput testID="tags" values={['acme.nl', 'b.nl']} onChange={onChange} />);
        await fireEvent.press(screen.getByText('acme.nl'));
        expect(onChange).toHaveBeenLastCalledWith(['b.nl']);
    });

    it('shows the validator’s sentence and adds nothing', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<TagInput testID="tags" values={[]} onChange={onChange} validate={domain} />);
        await fireEvent.changeText(screen.getByTestId('tags'), 'nope');
        await fireEvent(screen.getByTestId('tags'), 'submitEditing');
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByText('Not a domain')).toBeTruthy();
    });

    it('adds with the + beside the field, which is off until something is typed', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<TagInput testID="tags" values={[]} onChange={onChange} normalize={lower} />);
        expect(screen.getByTestId('tags-add')).toBeDisabled();
        await fireEvent.changeText(screen.getByTestId('tags'), 'Acme.nl');
        expect(screen.getByLabelText('Add')).toBeEnabled();
        await fireEvent.press(screen.getByTestId('tags-add'));
        expect(onChange).toHaveBeenLastCalledWith(['acme.nl']);
        expect(screen.getByTestId('tags').props.value).toBe('');
    });

    it('adds what is typed when the field loses focus, and nothing for an empty one', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<TagInput testID="tags" values={['a.nl']} onChange={onChange} />);
        await fireEvent(screen.getByTestId('tags'), 'blur');
        expect(onChange).not.toHaveBeenCalled();
        await fireEvent.changeText(screen.getByTestId('tags'), 'b.nl');
        await fireEvent(screen.getByTestId('tags'), 'blur');
        expect(onChange).toHaveBeenLastCalledWith(['a.nl', 'b.nl']);
    });

    it('keeps a refused value in the field on blur, with the reason', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<TagInput testID="tags" values={[]} onChange={onChange} validate={domain} />);
        await fireEvent.changeText(screen.getByTestId('tags'), 'nope');
        await fireEvent(screen.getByTestId('tags'), 'blur');
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByText('Not a domain')).toBeTruthy();
        expect(screen.getByTestId('tags').props.value).toBe('nope');
    });

    it('commits through its ref, and says when it could not', async () => {
        const onChange = jest.fn();
        const ref = createRef<TagInputHandle>();
        await renderWithProviders(<TagInput ref={ref} testID="tags" values={[]} onChange={onChange} validate={domain} />);
        let ok: boolean | undefined;
        await act(async () => {
            ok = ref.current?.commit();
        });
        expect(ok).toBe(true);
        expect(onChange).not.toHaveBeenCalled();

        await fireEvent.changeText(screen.getByTestId('tags'), 'nope');
        await act(async () => {
            ok = ref.current?.commit();
        });
        expect(ok).toBe(false);
        expect(screen.getByText('Not a domain')).toBeTruthy();

        await fireEvent.changeText(screen.getByTestId('tags'), 'acme.nl');
        await act(async () => {
            ok = ref.current?.commit();
        });
        expect(ok).toBe(true);
        expect(onChange).toHaveBeenLastCalledWith(['acme.nl']);
    });

    it('shows its label above the field and names the field by it', async () => {
        await renderWithProviders(
            <TagInput testID="tags" label="Recipients" values={[]} onChange={jest.fn()} keyboardType="email-address" />,
        );
        expect(screen.getByText('Recipients')).toBeTruthy();
        const field = screen.getByLabelText('Recipients');
        expect(field.props.keyboardType).toBe('email-address');
    });
});
