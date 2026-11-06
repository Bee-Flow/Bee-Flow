import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SubTabs } from './SubTabs';

const OPTIONS = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }];

function Harness() {
    const [value, setValue] = useState('a');
    return <SubTabs value={value} onChange={setValue} options={OPTIONS} description="About it" aria-label="Views" />;
}

describe('SubTabs', () => {
    it('presses the active pill and switches on click', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        expect(screen.getByRole('group', { name: 'Views' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Alpha' }).getAttribute('aria-pressed')).toBe('true');
        await user.click(screen.getByRole('button', { name: 'Beta' }));
        expect(screen.getByRole('button', { name: 'Beta' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: 'Alpha' }).getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByText('About it')).toBeTruthy();
    });
});
