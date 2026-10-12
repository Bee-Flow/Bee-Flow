// Settings → Account → Usage for a consumer account. Pinned: the range
// buttons say which one is chosen, and choosing one reloads that range.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: (...args: unknown[]) => authFetch(...args) }));

import ConsumerUsageSection from './ConsumerUsageSection';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('ConsumerUsageSection', () => {
    beforeEach(() => {
        authFetch.mockReset();
        authFetch.mockImplementation(async (url: string) => (
            url.startsWith('/api/usage/summary') ? ok({ billed_cost: 1.5 }) : ok([])
        ));
    });

    it('marks the chosen range and reloads when another is picked', async () => {
        const user = userEvent.setup();
        render(<ConsumerUsageSection />);
        const thirty = await screen.findByRole('button', { name: '30d' });
        expect(thirty).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'false');

        await user.click(screen.getByRole('button', { name: '7d' }));
        expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/usage/summary?days=7'));
        expect(screen.getByText('AI usage this period')).toBeInTheDocument();
    });
});
