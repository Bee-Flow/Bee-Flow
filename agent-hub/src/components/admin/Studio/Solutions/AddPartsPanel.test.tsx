import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args: unknown[]) => (globalThis as unknown as { __authFetch: (...a: unknown[]) => unknown }).__authFetch(...args),
}));

import AddPartsPanel from './AddPartsPanel';

/**
 * "Add to this Solution". Pinned: the counts on the tiles are real before a
 * click; a listing that failed is never "nothing left"; what sits in another
 * Solution is shown, disabled, with that Solution's name; filing goes through
 * the same PUT per item and a refusal is told per item in the server's words.
 */

type Json = Record<string, unknown>;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const bad = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

const LISTS: Record<string, unknown> = {
    '/api/automation': { automations: [
        { id: 'a1', title: 'Nightly', userId: 'u1' },
        { id: 'a2', title: 'Weekly', userId: 'u1' },
        { id: 'a3', title: 'Taken', userId: 'u1', projectId: 'sol2' },
    ] },
    '/api/skills': [{ id: 's1', name: 'Tone of voice', userId: 'u1', projectId: null }],
    '/api/studio-documents': { documents: [{ id: 'd1', name: 'Quote', userId: 'u1', solutionProjectId: null }], total: 1 },
    '/api/studio-apps': { apps: [] },
};

let puts: Json[] = [];

let asked: Json[] = [];
const NO_RELATED = { related: [], truncated: false };

function wire({ failList = '', refuse = {} as Record<string, Json>, lists = LISTS, related = NO_RELATED as unknown, relatedFails = false } = {}) {
    puts = [];
    asked = [];
    (globalThis as unknown as { __authFetch: unknown }).__authFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === 'POST' && url.endsWith('/resources/related')) {
            asked.push(JSON.parse(init.body || '{}') as Json);
            return relatedFails ? bad(500, { error: 'Request failed' }) : ok(related);
        }
        if (init?.method === 'PUT') {
            const body = JSON.parse(init.body || '{}') as Json;
            puts.push(body);
            return refuse[String(body.id)] ? bad(404, refuse[String(body.id)]) : ok({ success: true });
        }
        if (url.startsWith('/api/projects/summary')) return ok({ projects: [{ id: 'sol2', name: 'Onboarding' }] });
        const path = url.split('?')[0];
        if (failList && path === failList) return bad(500, { error: 'Request failed' });
        return path in lists ? ok(lists[path]) : ok([]);
    });
}

const renderPanel = (props: Partial<React.ComponentProps<typeof AddPartsPanel>> = {}) => render(
    <AddPartsPanel projectId="sol1" alreadyIn={new Set()} currentUserId="u1" {...props} />,
);

/** Adding waits for the check of what else the ticked parts need. */
const submit = async () => {
    const button = screen.getByTestId('add-parts-submit');
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    return button;
};

beforeEach(() => wire());
afterEach(() => { delete (globalThis as unknown as { __authFetch?: unknown }).__authFetch; });

describe('the kind tiles', () => {
    it('count what is free to add per kind, not what sits in another Solution', async () => {
        renderPanel();
        await waitFor(() => expect(screen.getByTestId('add-kind-count-automation').textContent).toBe('2'));
        expect(screen.getByTestId('add-kind-count-skill').textContent).toBe('1');
        expect(screen.getByTestId('add-kind-count-document_template').textContent).toBe('1');
        expect(screen.getByTestId('add-kind-count-app').textContent).toBe('0');
    });

    it('a listing that could not be read shows a warning, not a zero, and can be retried', async () => {
        wire({ failList: '/api/skills' });
        const user = userEvent.setup();
        renderPanel();
        await waitFor(() => expect(screen.getByTestId('add-kind-skill').getAttribute('data-state')).toBe('error'));
        expect(screen.queryByTestId('add-kind-count-skill')).toBeNull();
        await user.click(screen.getByTestId('add-kind-skill'));
        expect(screen.getByTestId('solution-add-error').textContent).toContain('could not be loaded');
        expect(screen.queryByTestId('add-parts-none-left')).toBeNull();
        wire();
        await user.click(screen.getByTestId('add-parts-retry'));
        expect(await screen.findByText('Tone of voice')).toBeTruthy();
    });

    it('a kind with nothing of yours says so', async () => {
        const user = userEvent.setup();
        renderPanel();
        await waitFor(() => expect(screen.getByTestId('add-kind-count-app').textContent).toBe('0'));
        await user.click(screen.getByTestId('add-kind-app'));
        expect(screen.getByTestId('add-parts-none-left').textContent).toBe('Nothing of yours left to add here.');
    });
});

describe('the list', () => {
    it('opens on the first kind that has something, shows other-Solution items disabled with its name', async () => {
        renderPanel();
        expect(await screen.findByLabelText('Nightly')).toBeTruthy();
        const taken = screen.getByLabelText(/Taken/) as HTMLInputElement;
        expect(taken.disabled).toBe(true);
        expect(screen.getByTestId('add-parts-taken').textContent).toBe('In Onboarding');
    });

    it('says "another Solution" when the name is not known', async () => {
        const lists = { '/api/automation': { automations: [{ id: 'a3', title: 'Taken', userId: 'u1', projectId: 'sol77' }] } };
        wire({ lists });
        renderPanel();
        expect((await screen.findByTestId('add-parts-taken')).textContent).toBe('In another Solution');
    });

    it('searches by name and says when nothing matches', async () => {
        const user = userEvent.setup();
        renderPanel();
        await screen.findByLabelText('Nightly');
        await user.type(screen.getByRole('searchbox'), 'week');
        expect(screen.queryByLabelText('Nightly')).toBeNull();
        expect(screen.getByLabelText('Weekly')).toBeTruthy();
        await user.type(screen.getByRole('searchbox'), 'zzz');
        expect(screen.getByTestId('add-parts-no-match').textContent).toContain('weekzzz');
    });
});

describe('filing', () => {
    it('adds several, across kinds, with the kind strings the server expects', async () => {
        const onAdded = vi.fn();
        const user = userEvent.setup();
        renderPanel({ onAdded });
        await user.click(await screen.findByLabelText('Nightly'));
        await user.click(screen.getByTestId('add-kind-skill'));
        await user.click(await screen.findByLabelText('Tone of voice'));
        await user.click(screen.getByTestId('add-kind-document_template'));
        await user.click(await screen.findByLabelText('Quote'));
        await waitFor(() => expect(screen.getByTestId('add-parts-submit').textContent).toBe('Add 3'));
        await user.click(await submit());
        await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
        expect(puts).toEqual([
            { kind: 'automation', id: 'a1', attach: true },
            { kind: 'skill', id: 's1', attach: true },
            { kind: 'document_template', id: 'd1', attach: true },
        ]);
        expect(screen.getByTestId('add-parts-submit').hasAttribute('disabled')).toBe(true);
    });

    it('tells a refusal per item in the server\'s words and keeps the one that failed', async () => {
        wire({ refuse: { a2: { error: 'Not found, or not yours to move' } } });
        const onAdded = vi.fn();
        const user = userEvent.setup();
        renderPanel({ onAdded });
        await user.click(await screen.findByLabelText('Nightly'));
        await user.click(screen.getByLabelText('Weekly'));
        await user.click(await submit());
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('Added 1 of 2');
        expect(within(alert).getByText(/Weekly: .*not yours to move/)).toBeTruthy();
        expect(onAdded).toHaveBeenCalled();
        // The one that went in left the list; the one that did not is still there.
        expect(screen.queryByLabelText('Nightly')).toBeNull();
        expect(screen.getByLabelText('Weekly')).toBeTruthy();
    });

    it('nothing is sent while nothing is ticked', async () => {
        renderPanel();
        await screen.findByLabelText('Nightly');
        expect(screen.getByTestId('add-parts-submit').hasAttribute('disabled')).toBe(true);
        expect(puts).toHaveLength(0);
    });
});

describe('what comes along', () => {
    const along = (over: Json = {}) => ({
        kind: 'datatable', id: 't1', name: 'Leads', relation: 'reads_table', status: 'addable',
        via: [{ kind: 'automation', id: 'a1', name: 'Nightly', relation: 'reads_table' }], ...over,
    });

    it('asks for the ticked parts only after the ticking settles, and says what comes along and why', async () => {
        wire({ related: { related: [along()], truncated: false } });
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByLabelText('Nightly'));
        await user.click(screen.getByLabelText('Weekly'));
        expect(await screen.findByTestId('related-notice')).toBeTruthy();
        expect(asked).toEqual([{ items: [{ kind: 'automation', id: 'a1' }, { kind: 'automation', id: 'a2' }] }]);
        const part = screen.getByTestId('related-part');
        expect(part.textContent).toContain('Leads');
        expect(part.textContent).toContain('Read by Nightly');
        expect(screen.getByTestId('add-parts-submit').textContent).toBe('Add 2 (+1 related)');
    });

    it('files what came along first, then the ticked part, and tells both', async () => {
        wire({ related: { related: [along()], truncated: false } });
        const onAdded = vi.fn();
        const user = userEvent.setup();
        renderPanel({ onAdded });
        await user.click(await screen.findByLabelText('Nightly'));
        await screen.findByTestId('related-part');
        await user.click(await submit());
        await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
        expect(puts).toEqual([
            { kind: 'datatable', id: 't1', attach: true },
            { kind: 'automation', id: 'a1', attach: true },
        ]);
        expect(screen.getByTestId('add-parts-result').textContent).toContain('Added: Nightly');
        expect(screen.getByTestId('add-parts-came-along').textContent).toContain('Leads (Read by Nightly)');
    });

    it('warns about what cannot come along, with the reason, and still lets the rest go in', async () => {
        wire({ related: { related: [
            along({ id: 'x', kind: 'automation', name: 'Other flow', relation: 'calls', status: 'in_other_solution', solutionName: 'Onboarding' }),
            along({ id: 'y', name: null, status: 'not_yours' }),
            along({ id: 'z', name: null, status: 'not_found' }),
        ], truncated: false } });
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByLabelText('Nightly'));
        const blocked = await screen.findByTestId('related-blocked');
        const rows = within(blocked).getAllByTestId('related-blocked-part').map(r => r.textContent ?? '');
        expect(rows[0]).toContain('In Onboarding');
        expect(rows[1]).toContain('Not yours to add');
        expect(rows[2]).toContain('No longer exists');
        expect(blocked.textContent).toContain('release check');
        expect(screen.queryByTestId('related-along')).toBeNull();
        expect(screen.getByTestId('add-parts-submit').textContent).toBe('Add 1');
        await user.click(await submit());
        await waitFor(() => expect(puts).toEqual([{ kind: 'automation', id: 'a1', attach: true }]));
    });

    it('when the check fails it says so, offers a retry, and adds only what was ticked', async () => {
        wire({ relatedFails: true });
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByLabelText('Nightly'));
        expect((await screen.findByTestId('related-error')).textContent).toContain('nothing related will come along');
        expect(screen.getByTestId('related-retry')).toBeTruthy();
        await user.click(await submit());
        await waitFor(() => expect(puts).toEqual([{ kind: 'automation', id: 'a1', attach: true }]));
    });

    it('holds the button while the check is running, and shows nothing when nothing is ticked', async () => {
        wire({ related: { related: [along()], truncated: false } });
        const user = userEvent.setup();
        renderPanel();
        await screen.findByLabelText('Nightly');
        expect(screen.queryByTestId('related-notice')).toBeNull();
        await user.click(screen.getByLabelText('Nightly'));
        expect(screen.getByTestId('related-loading')).toBeTruthy();
        expect(screen.getByTestId('add-parts-submit').hasAttribute('disabled')).toBe(true);
        await screen.findByTestId('related-notice');
        expect(screen.getByTestId('add-parts-submit').hasAttribute('disabled')).toBe(false);
    });
});
