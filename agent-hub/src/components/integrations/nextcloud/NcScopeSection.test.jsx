import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import NcScopeSection from './NcScopeSection';
import { authFetch } from '../../../utils/helpers';

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const jsonRes = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

// A realistic GET /api/nc-scope payload: all 14 catalog rows, two narrowed.
const CATALOG = [
    ['nextcloud', 'Files & WebDAV', true, { kind: 'folder', label: 'folders' }],
    ['nextcloud-calendar', 'Calendar', true, { kind: 'calendar', label: 'calendars' }],
    ['nextcloud-contacts', 'Contacts', true, { kind: 'addressbook', label: 'address books' }],
    ['nextcloud-deck', 'Deck', true, { kind: 'board', label: 'boards' }],
    ['nextcloud-mail', 'Mail', true, { kind: 'account', label: 'mail accounts' }],
    ['nextcloud-notifications', 'Notifications', false, null],
    ['nextcloud-talk', 'Talk', true, { kind: 'room', label: 'conversations' }],
    ['nextcloud-tasks', 'Tasks', true, { kind: 'list', label: 'task lists' }],
    ['nextcloud-notes', 'Notes', false, null],
    ['nextcloud-activity', 'Activity', false, null],
    ['nextcloud-tables', 'Tables', true, { kind: 'table', label: 'tables' }],
    ['nextcloud-forms', 'Forms', true, { kind: 'form', label: 'forms' }],
    ['nextcloud-teams', 'Teams', false, null],
    ['nextcloud-status', 'User Status', false, null],
];

function scopePayload(overrides = {}) {
    const integrations = {};
    for (const [id, name, scopable, resource] of CATALOG) {
        integrations[id] = { name, description: '', mode: 'all', selected: [], scopable, resource, ...(overrides[id] || {}) };
    }
    return { integrations, updatedAt: null };
}

function mockGet(payload) {
    authFetch.mockImplementation(async (url, opts = {}) => {
        if (!opts.method || opts.method === 'GET') return jsonRes(payload);
        return jsonRes(payload);
    });
}

describe('NcScopeSection', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('renders one row per catalog integration with its scope in words', async () => {
        mockGet(scopePayload({
            'nextcloud-calendar': { mode: 'selected', selected: ['work', 'family'] },
            'nextcloud-mail': { mode: 'off' },
        }));
        render(<NcScopeSection />);
        await waitFor(() => expect(screen.getByTestId('nc-scope-section')).toBeInTheDocument());

        for (const [id] of CATALOG) {
            expect(screen.getByTestId(`nc-scope-row-${id}`)).toBeInTheDocument();
        }
        expect(screen.getByTestId('nc-scope-words-nextcloud').textContent).toBe('Everything');
        expect(screen.getByTestId('nc-scope-words-nextcloud-calendar').textContent).toBe('2 calendars');
        expect(screen.getByTestId('nc-scope-words-nextcloud-mail').textContent).toBe('Off');
        // Narrowed rows advertise their state with a dot; default rows stay quiet.
        expect(screen.getByTestId('nc-scope-dot-nextcloud-calendar')).toBeInTheDocument();
        expect(screen.getByTestId('nc-scope-dot-nextcloud-mail')).toBeInTheDocument();
        expect(screen.queryByTestId('nc-scope-dot-nextcloud')).toBeNull();
    });

    it('mode change PUTs a single-integration patch immediately', async () => {
        mockGet(scopePayload());
        render(<NcScopeSection />);
        await waitFor(() => screen.getByTestId('nc-scope-row-nextcloud-mail'));

        fireEvent.click(screen.getByTestId('nc-scope-row-nextcloud-mail'));
        fireEvent.click(screen.getByRole('radio', { name: 'Off' }));

        await waitFor(() => {
            const put = authFetch.mock.calls.find(([, opts]) => opts?.method === 'PUT');
            expect(put).toBeTruthy();
            expect(JSON.parse(put[1].body)).toEqual({ integrations: { 'nextcloud-mail': { mode: 'off' } } });
        });
    });

    it('unscopable integrations offer no "Only selected" segment', async () => {
        mockGet(scopePayload());
        render(<NcScopeSection />);
        await waitFor(() => screen.getByTestId('nc-scope-row-nextcloud-status'));
        fireEvent.click(screen.getByTestId('nc-scope-row-nextcloud-status'));
        const radios = screen.getAllByRole('radio').map(r => r.textContent);
        expect(radios).toContain('Everything');
        expect(radios).toContain('Off');
        expect(radios).not.toContain('Only selected');
    });

    it('revoke-all asks inline first, then POSTs /revoke-all', async () => {
        mockGet(scopePayload());
        render(<NcScopeSection />);
        await waitFor(() => screen.getByTestId('nc-scope-revoke'));

        fireEvent.click(screen.getByTestId('nc-scope-revoke'));
        // No network call yet — the confirm is the safety.
        expect(authFetch.mock.calls.filter(([url]) => String(url).includes('revoke-all'))).toHaveLength(0);

        fireEvent.click(screen.getByTestId('nc-scope-revoke-yes'));
        await waitFor(() => {
            expect(authFetch.mock.calls.some(([url]) => String(url).includes('/nc-scope/revoke-all'))).toBe(true);
        });
    });

    it('reset is disabled at default and active once anything is narrowed', async () => {
        mockGet(scopePayload());
        const { unmount } = render(<NcScopeSection />);
        await waitFor(() => screen.getByTestId('nc-scope-reset'));
        expect(screen.getByTestId('nc-scope-reset')).toBeDisabled();
        unmount();

        mockGet(scopePayload({ 'nextcloud-talk': { mode: 'off' } }));
        render(<NcScopeSection />);
        await waitFor(() => screen.getByTestId('nc-scope-reset'));
        expect(screen.getByTestId('nc-scope-reset')).toBeEnabled();
    });

    it('a load failure shows the error instead of a dead panel', async () => {
        authFetch.mockResolvedValue(jsonRes({ error: 'nope' }, 500));
        render(<NcScopeSection />);
        await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
    });
    // ── Regression: every request must hit the /api mount ───────────────────
    //
    // All six call sites read `${API_BASE}/nc-scope`, but API_BASE is the
    // ORIGIN — '' in production, NC's signed-proxy prefix when embedded —
    // never `<origin>/api`. The router is mounted at /api/nc-scope
    // (server/index.js), so every request missed it, no layer answered, and
    // the panel showed its generic "Could not load access settings".
    //
    // This suite stayed green through all of it because it mocked authFetch
    // and never once looked at the URL it was handed. Asserting the URL is
    // the whole point of the test now: the 456 other call sites in this app
    // write `${API_BASE}/api/...`, and this component was the one that
    // didn't.
    it('requests the /api mount, not the SPA root', async () => {
        mockGet(scopePayload({ 'nextcloud-calendar': { mode: 'selected', selected: ['work'] } }));
        render(<NcScopeSection />);
        await waitFor(() => screen.getByTestId('nc-scope-row-nextcloud-calendar'));

        // Expanding an already-narrowed row mounts its picker → /resources/…
        fireEvent.click(screen.getByTestId('nc-scope-row-nextcloud-calendar'));
        await waitFor(() => expect(
            authFetch.mock.calls.some(([u]) => String(u).includes('/resources/'))).toBe(true));

        // …and the write paths, so PUT and POST are covered too. Collapse the
        // calendar row first — two open flyouts mean two 'Off' radios.
        fireEvent.click(screen.getByTestId('nc-scope-row-nextcloud-calendar'));
        fireEvent.click(screen.getByTestId('nc-scope-row-nextcloud-mail'));
        fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
        await waitFor(() => expect(
            authFetch.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(true));

        fireEvent.click(screen.getByTestId('nc-scope-revoke'));
        fireEvent.click(screen.getByTestId('nc-scope-revoke-yes'));
        await waitFor(() => expect(
            authFetch.mock.calls.some(([u]) => String(u).includes('/revoke-all'))).toBe(true));

        const urls = authFetch.mock.calls.map(([u]) => String(u));
        expect(urls.length).toBeGreaterThanOrEqual(4);
        for (const url of urls) {
            expect(url).toMatch(/^\/api\/nc-scope(\/|\?|$)/);
        }
    });
});
