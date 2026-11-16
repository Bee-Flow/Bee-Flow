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

type Answer = { orgTiers?: unknown[]; serverTiers?: unknown; euTiers?: unknown };

function serve(answer: Answer, saved: unknown[] = []) {
    setDemoTransport(async (url: unknown, options?: RequestInit) => {
        const address = String(url);
        if (options?.method === 'POST') { saved.push(JSON.parse(String(options.body))); return json({}); }
        if (address.includes('/ai/config/org-custom-chat-models')) return json({ orgTiers: answer.orgTiers ?? [], globalTiers: [] });
        if (address.endsWith('/ai/config/chat-models')) return json(answer.serverTiers ?? {});
        if (address.endsWith('/ai/config/chat-models-eu')) return json(answer.euTiers ?? {});
        return json({ providers: [] });
    });
}

async function mountWithFast() {
    const saved: Array<{ tiers: Array<{ id: string; label: string }> }> = [];
    serve({ orgTiers: [{ id: 'custom:fast', label: 'Fast', icon: 'F', modelId: '', allowedTaskTypes: [] }] }, saved);
    render(withQueryClient(<OrgCustomTiersPanel />));
    await screen.findByDisplayValue('Fast');
    return saved;
}

describe('OrgCustomTiersPanel names', () => {
    it('keeps the focus in the name field while typing, and keeps a look-alike tier apart', async () => {
        const user = userEvent.setup();
        const saved = await mountWithFast();
        await user.click(screen.getByRole('button', { name: /Add tier/ }));
        await user.clear(await screen.findByDisplayValue('New tier 2'));
        // "Fast" is on the way to "Faster": the new tier passes the first one's name.
        await user.keyboard('Faster');
        expect(names()).toEqual(['Fast', 'Faster']);

        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(saved).toHaveLength(1));
        expect(saved[0].tiers.map(tier => [tier.id, tier.label])).toEqual([['custom:fast', 'Fast'], ['custom:faster', 'Faster']]);
    });

    it('gives a second tier of the same name an id of its own', async () => {
        const user = userEvent.setup();
        const saved = await mountWithFast();
        await user.click(screen.getByRole('button', { name: /Add tier/ }));
        await user.clear(await screen.findByDisplayValue('New tier 2'));
        await user.keyboard('Fast');
        expect(names()).toEqual(['Fast', 'Fast']);
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(saved).toHaveLength(1));
        const ids = saved[0].tiers.map(tier => tier.id);
        expect(new Set(ids).size).toBe(2);
        expect(ids[0]).toBe('custom:fast');
    });
});

describe('OrgCustomTiersPanel layout', () => {
    it('an empty list offers Add tier and no Save; Save appears once there is a change', async () => {
        const user = userEvent.setup();
        serve({});
        render(withQueryClient(<OrgCustomTiersPanel />));
        expect(await screen.findByText(/has no custom tiers yet/)).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Organisation custom tiers' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        await user.click(screen.getByRole('button', { name: /Add tier/ }));
        expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('shows the server\'s tiers read-only above, with the EU model where it differs', async () => {
        serve({
            serverTiers: { fast: { modelId: 'vendor/small-model' }, thinking: { modelId: 'big-model' }, writer: { modelId: '' } },
            euTiers: { fast: { modelId: 'eu-small' }, thinking: { modelId: 'big-model' } },
        });
        render(withQueryClient(<OrgCustomTiersPanel />));
        const list = await screen.findByTestId('server-tiers');
        expect(list).toHaveTextContent('small-model · in EU mode: eu-small');
        expect(list).toHaveTextContent('big-model');
        expect(list).not.toHaveTextContent('Write');
        expect(screen.queryByRole('textbox', { name: /small-model/ })).toBeNull();
    });
});
