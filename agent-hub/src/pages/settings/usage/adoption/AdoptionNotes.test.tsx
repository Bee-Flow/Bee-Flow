import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AdoptionNotes from './AdoptionNotes';

describe('AdoptionNotes', () => {
    it('says who may see the report and how the numbers are made, under the anchor the areas link to', () => {
        const { container } = render(<AdoptionNotes />);
        expect(container.querySelector('#adoption-notes')).not.toBeNull();
        expect(screen.getByText('Who can see this')).toBeTruthy();
        expect(screen.getByText(/pseudonymous until revealed, every reveal is audited/)).toBeTruthy();
        expect(screen.getByText('How the numbers are made')).toBeTruthy();
        expect(screen.getByText(/A run started by a colleague counts for that colleague/)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Compliance › Monitoring notice' }).getAttribute('href')).toBe('/app/settings/organisation/compliance');
    });
});
