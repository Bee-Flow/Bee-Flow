// The User row of an opened termination: the generic routes carry user_id, the
// /org routes (one organisation chosen in the admin dashboard) carry `person`.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TerminationDetail } from './TerminationDetail';
import type { TerminationRow } from '../TerminationsPage.types';

const BASE: TerminationRow = {
    id: 1, termination_type: 'error', attachment_count: 0, attachment_bytes: 0, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
};

/** The value next to the "User" label. */
const userValue = () => screen.getByText('User').nextElementSibling?.textContent;

describe('TerminationDetail: the user', () => {
    it('shows the person of an /org row (a pseudonym unless revealed)', () => {
        render(<TerminationDetail r={{ ...BASE, person: { id: 'p1', name: 'Member · K7Q2' } }} />);
        expect(userValue()).toBe('Member · K7Q2');
    });

    it('shows the user id of a generic row', () => {
        render(<TerminationDetail r={{ ...BASE, user_id: 'u-123' }} />);
        expect(userValue()).toBe('u-123');
    });

    it('shows a dash for an /org row without a person', () => {
        render(<TerminationDetail r={{ ...BASE, person: null }} />);
        expect(userValue()).toBe('—');
    });
});
