import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import BreachRecipients, { memberSuggestions, type OrgMember } from './BreachRecipients';

const MEMBERS: OrgMember[] = [
    { id: 'u1', displayName: 'T. Smit', email: 't@example.com' },
    { id: 'u2', displayName: 'R. Bakker', email: 'r@example.com' },
    { id: 'u3', displayName: 'No mail' },
];

/** A host that keeps the list, like the settings form does. */
function Host({ initial = [] as string[], onChange = vi.fn() }) {
    const [value, setValue] = useState<string[]>(initial);
    return (
        <BreachRecipients
            label="Breach notification recipients"
            hint="Emails alerted on anomalous data-access events."
            value={value}
            onChange={(next) => { setValue(next); onChange(next); }}
            orgUsers={MEMBERS}
            testId="br"
        />
    );
}

describe('BreachRecipients', () => {
    it('adds an address on Enter and clears the input', async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Host onChange={onChange} />);
        // An input with a datalist is a combobox to assistive tech.
        const input = screen.getByRole('combobox', { name: 'Breach notification recipients' });
        expect(input).toHaveAccessibleDescription('Emails alerted on anomalous data-access events.');
        await user.type(input, 'ciso@example.com{Enter}');
        expect(onChange).toHaveBeenLastCalledWith(['ciso@example.com']);
        expect(screen.getByTestId('br-item').textContent).toBe('ciso@example.com');
        expect((input as HTMLInputElement).value).toBe('');
    });

    it('does not add a blank line or the same address twice', async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Host initial={['sec@example.com']} onChange={onChange} />);
        const input = screen.getByTestId('br-input');
        await user.type(input, '   {Enter}');
        await user.type(input, 'SEC@example.com{Enter}');
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getAllByTestId('br-item')).toHaveLength(1);
    });

    it('removes a chip by its own button', async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Host initial={['a@example.com', 'b@example.com']} onChange={onChange} />);
        await user.click(screen.getByRole('button', { name: 'Remove a@example.com' }));
        expect(onChange).toHaveBeenLastCalledWith(['b@example.com']);
        expect(screen.getAllByTestId('br-item').map(el => el.textContent)).toEqual(['b@example.com']);
    });

    it('suggests the members not on the list yet, and adds a picked one', async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Host initial={['t@example.com']} onChange={onChange} />);
        const options = Array.from(screen.getByTestId('br-suggestions').querySelectorAll('option'));
        expect(options.map(o => o.getAttribute('value'))).toEqual(['r@example.com']);
        expect(options[0].textContent).toBe('R. Bakker');
        // Picking a datalist option fills the input; Add (or Enter) takes it.
        await user.type(screen.getByTestId('br-input'), 'r@example.com');
        await user.click(screen.getByTestId('br-add'));
        expect(onChange).toHaveBeenLastCalledWith(['t@example.com', 'r@example.com']);
    });

    it('memberSuggestions skips members without an address and those already listed, in any case', () => {
        expect(memberSuggestions(MEMBERS, ['R@EXAMPLE.COM']).map(u => u.id)).toEqual(['u1']);
        expect(memberSuggestions(null, [])).toEqual([]);
    });
});
