// Organisation → custom tiers. Pinned: the name field can be typed in (the
// card used to remount on every keystroke, because its key was the id and the
// id follows the name), and a name that matches another tier never merges the two.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import { withQueryClient } from '@/test/queryWrapper';
import OrgCustomTiersPanel from './OrgCustomTiersPanel';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const names = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[placeholder="Tier name"]')).map(i => i.value);

afterEach(() => { setDemoTransport(null); });

async function mountWithFast() {
    const saved: Array<{ tiers: Array<{ id: string; label: string }> }> = [];
    setDemoTransport(async (url: unknown, options?: RequestInit) => {
        const address = String(url);
        if (options?.method === 'POST') { saved.push(JSON.parse(String(options.body))); return json({}); }
        if (address.endsWith('/ai/config/org-custom-chat-models')) {
            return json({ orgTiers: [{ id: 'custom:fast', label: 'Fast', icon: 'F', modelId: '', allowedTaskTypes: [] }], globalTiers: [] });
        }
        return json({ providers: [] });
    });
    render(withQueryClient(<OrgCustomTiersPanel />));
    await screen.findByDisplayValue('Fast');
    return saved;
}

describe('OrgCustomTiersPanel names', () => {
    it('keeps the focus in the name field while typing, and keeps a look-alike tier apart', async () => {
        const user = userEvent.setup();
        const saved = await mountWithFast();
        await user.click(screen.getByRole('button', { name: /Add Tier/ }));
        await user.clear(await screen.findByDisplayValue('New tier 2'));
        // "Fast" is on the way to "Faster": the new tier passes the first one's name.
        await user.keyboard('Faster');
        expect(names()).toEqual(['Fast', 'Faster']);

        await user.click(screen.getByRole('button', { name: 'Save Organisation Tiers' }));
        await waitFor(() => expect(saved).toHaveLength(1));
        expect(saved[0].tiers.map(tier => [tier.id, tier.label])).toEqual([['custom:fast', 'Fast'], ['custom:faster', 'Faster']]);
    });

    it('gives a second tier of the same name an id of its own', async () => {
        const user = userEvent.setup();
        const saved = await mountWithFast();
        await user.click(screen.getByRole('button', { name: /Add Tier/ }));
        await user.clear(await screen.findByDisplayValue('New tier 2'));
        await user.keyboard('Fast');
        expect(names()).toEqual(['Fast', 'Fast']);
        await user.click(screen.getByRole('button', { name: 'Save Organisation Tiers' }));
        await waitFor(() => expect(saved).toHaveLength(1));
        const ids = saved[0].tiers.map(tier => tier.id);
        expect(new Set(ids).size).toBe(2);
        expect(ids[0]).toBe('custom:fast');
    });
});
