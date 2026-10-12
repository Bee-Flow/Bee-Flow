// Settings → Help & Support. Pinned: the Learning Center button shows only
// where the settings shell can open that page, and it lets the shell switch
// to it when the shell says how.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: (...args: unknown[]) => authFetch(...args) }));

import HelpSupportSection from './HelpSupportSection';

describe('HelpSupportSection', () => {
    beforeEach(() => {
        authFetch.mockReset();
        authFetch.mockResolvedValue({ ok: true, json: async () => ({ threads: [] }) });
        window.history.replaceState({}, '', '/app/settings/help_support');
    });
    afterEach(() => { window.history.replaceState({}, '', '/'); });

    it('offers the Learning Center by default and opens it at its address', async () => {
        const user = userEvent.setup();
        render(<HelpSupportSection />);
        await user.click(await screen.findByRole('button', { name: /Learning Center/ }));
        expect(window.location.pathname).toBe('/app/settings/learning');
    });

    it('hides the Learning Center where it cannot open', async () => {
        render(<HelpSupportSection showLearningLink={false} />);
        await screen.findByRole('button', { name: /New question/ });
        expect(screen.queryByRole('button', { name: /Learning Center/ })).not.toBeInTheDocument();
    });

    it('lets the settings shell open the Learning Center itself', async () => {
        const onOpenLearning = vi.fn();
        const user = userEvent.setup();
        render(<HelpSupportSection onOpenLearning={onOpenLearning} />);
        await user.click(await screen.findByRole('button', { name: /Learning Center/ }));
        expect(onOpenLearning).toHaveBeenCalledTimes(1);
        expect(window.location.pathname).toBe('/app/settings/help_support');
    });
});
