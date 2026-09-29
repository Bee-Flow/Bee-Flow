import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { t } from '../ownData/testKit';
import AllowTermsChips, { normaliseAllowValue } from './AllowTermsChips';

/**
 * "Never hidden", the one control that makes the shield hide LESS. Its
 * safety story is that matching is exact on a normalised form, and that the
 * card says so; these cases hold both.
 */

describe('normaliseAllowValue', () => {
    // Same fixtures as server/core/dlp/allowTerms.test.js: the client copy of
    // this rule must not drift from the one the runtime actually applies.
    it('strips case, punctuation and whitespace only', () => {
        expect(normaliseAllowValue('Coca-Cola')).toBe('cocacola');
        expect(normaliseAllowValue('  A.B.N. AMRO ')).toBe('abnamro');
        expect(normaliseAllowValue('---')).toBe('');
    });
});

function renderCard({ terms = [] as string[], publicOrgs = true, readOnly = false } = {}) {
    const onChange = vi.fn();
    const onChangePublicOrgs = vi.fn();
    render(
        <AllowTermsChips
            terms={terms}
            onChange={onChange}
            publicOrgs={publicOrgs}
            onChangePublicOrgs={onChangePublicOrgs}
            readOnly={readOnly}
            t={t}
        />,
    );
    return { onChange, onChangePublicOrgs };
}

const field = () => screen.getByLabelText('Add a name that should stay visible');

describe('AllowTermsChips', () => {
    it('is a titled card that states the exact-match rule where the admin will read it', () => {
        renderCard();
        expect(screen.getByRole('region', { name: 'Never hidden' })).toBeInTheDocument();
        // The difference between allowlisting a brand and unredacting a client.
        expect(screen.getByText(/Matches are exact: “Shell” does not cover “Shell Advies BV”\./)).toBeInTheDocument();
        // And which list reaches how far: only the admin's own entries apply everywhere.
        expect(screen.getByText(/Your own exceptions apply in every category; the well-known list applies to company names\./)).toBeInTheDocument();
    });

    it('adds a term on Enter', async () => {
        const user = userEvent.setup();
        const { onChange } = renderCard();
        await user.type(field(), 'Dekker Techniek{Enter}');
        expect(onChange).toHaveBeenCalledWith(['Dekker Techniek']);
    });

    it('refuses a normalised duplicate and says why', async () => {
        // "coca cola" against a listed "Coca-Cola" is otherwise a silent no-op:
        // the entry appears to be added and simply never matches.
        const user = userEvent.setup();
        const { onChange } = renderCard({ terms: ['Coca-Cola'] });
        await user.type(field(), 'coca cola{Enter}');
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent(/already on the list/i);
        expect(field()).toHaveAttribute('aria-invalid', 'true');
    });

    it('refuses a value with nothing left after normalising, and one that is too long', async () => {
        const user = userEvent.setup();
        const { onChange } = renderCard();
        await user.type(field(), '---{Enter}');
        expect(screen.getByRole('alert')).toHaveTextContent('Enter a name or word.');
        await user.clear(field());
        await user.click(field());
        await user.paste('x'.repeat(121));
        await user.keyboard('{Enter}');
        expect(screen.getByRole('alert')).toHaveTextContent('Keep it under 120 characters.');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('counts and removes the own exceptions', async () => {
        const user = userEvent.setup();
        const { onChange } = renderCard({ terms: ['Microsoft', 'PostNL'] });
        expect(screen.getByText('Your own exceptions')).toBeInTheDocument();
        expect(screen.getByText('2')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Remove Microsoft' }));
        expect(onChange).toHaveBeenCalledWith(['PostNL']);
    });

    it('keeps the well-known companies switch, with the size of the list while it is on', async () => {
        const user = userEvent.setup();
        const { onChangePublicOrgs } = renderCard();
        const box = screen.getByRole('checkbox', { name: /well-known companies/i });
        expect(box).toBeChecked();
        expect(screen.getByText('221')).toBeInTheDocument();
        await user.click(box);
        expect(onChangePublicOrgs).toHaveBeenCalledWith(false);
    });

    it('says Off instead of a count when the well-known list is not used', () => {
        renderCard({ publicOrgs: false });
        expect(screen.getByRole('checkbox', { name: /well-known companies/i })).not.toBeChecked();
        expect(screen.queryByText('221')).toBeNull();
        expect(screen.getByText('Off')).toBeInTheDocument();
    });

    it('shows the list read-only without a way to change it', () => {
        renderCard({ terms: ['Kifid'], readOnly: true });
        expect(screen.getByText('Kifid')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Remove Kifid' })).toBeNull();
        expect(screen.queryByLabelText('Add a name that should stay visible')).toBeNull();
        expect(screen.getByRole('checkbox', { name: /well-known companies/i })).toBeDisabled();
    });
});
