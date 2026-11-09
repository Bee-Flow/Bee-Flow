// Subscriptions → Plans. Pinned: "Delete plan" inside the editor asks for
// confirmation right there (the dialog used to exist only in the list view, so
// the button did nothing until the admin went back).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import { PlansView } from './PlansView';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { setDemoTransport(null); });

describe('PlansView', () => {
    it('confirms and deletes a plan from inside its editor', async () => {
        const user = userEvent.setup();
        const calls: string[] = [];
        setDemoTransport(async (url: unknown, options?: RequestInit) => {
            const address = String(url);
            calls.push(`${options?.method || 'GET'} ${address}`);
            if (address.endsWith('/api/subscriptions/plans')) return json([{ id: 'p1', name: 'Team', price: 10, plan_type: 'organization' }]);
            return json({});
        });
        render(<PlansView />);
        await user.click(await screen.findByRole('button', { name: /Edit/ }));
        expect(await screen.findByText('Edit subscription plan', { exact: false })).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Delete plan' }));
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain('Delete Team?');
        // Still in the editor: the question is asked where the button is.
        expect(screen.getByText('Edit subscription plan', { exact: false })).toBeTruthy();

        const confirm = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent?.includes('Delete plan'));
        await user.click(confirm as HTMLButtonElement);
        await waitFor(() => expect(calls.some(c => c.startsWith('DELETE ') && c.endsWith('/api/subscriptions/plans/p1'))).toBe(true));
    });
});
