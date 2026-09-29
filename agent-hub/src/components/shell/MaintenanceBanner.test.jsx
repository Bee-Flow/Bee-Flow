/**
 * MaintenanceBanner — the phases as a user experiences them, against a mocked
 * /api/maintenance.
 *
 * The load-bearing case is PERSISTENCE of the 'recovered' phase: it used to
 * retire itself after 20s (RECOVERED_LINGER_MS) and re-baseline, so anyone who
 * missed the note silently kept running the old bundle against the new server.
 * The condition the prompt reports — this tab's code predates the server's —
 * stays true until the page reloads, so the prompt must too. The reload itself
 * is the exit: a fresh mount baselines against the new build and shows nothing.
 */

import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Controllable poll payload. vi.mock is hoisted above the imports, so the
// shared state it closes over has to be hoisted too. `down` simulates the
// mid-rollout reality: the pod serving this tab is gone, fetches reject.
const api = vi.hoisted(() => ({
    payload: { maintenance: null, appVersion: 'sha-old' },
    down: false,
}));

vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(() => (api.down
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve({
            ok: true,
            json: () => Promise.resolve(api.payload),
        }))),
}));

import MaintenanceBanner from './MaintenanceBanner';

function openWindow(etaSeconds) {
    const now = Date.now();
    return {
        startedAt: new Date(now).toISOString(),
        endsAt: new Date(now + etaSeconds * 1000).toISOString(),
        etaSeconds,
        reason: '',
        ref: 'test',
    };
}

// Flush the mount poll (fires synchronously in the effect, resolves on a
// microtask) and/or run `ms` of interval polls, promises included.
async function advance(ms = 0) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
    vi.useFakeTimers();
    api.payload = { maintenance: null, appVersion: 'sha-old' };
    api.down = false;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('MaintenanceBanner', () => {
    it('renders nothing while nothing is announced', async () => {
        render(<MaintenanceBanner />);
        await advance();
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('shows the pending warning, with a coarse translated ETA', async () => {
        api.payload = { maintenance: openWindow(120), appVersion: 'sha-old' };
        render(<MaintenanceBanner />);
        await advance();
        const strip = screen.getByRole('status');
        expect(strip).toHaveTextContent('Update being installed');
        expect(strip).toHaveTextContent('about 2 minutes');
        // No reload button yet — there is nothing new to reload into.
        expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    });

    it('goes overdue when the ETA runs out while the server is unreachable', async () => {
        api.payload = { maintenance: openWindow(30), appVersion: 'sha-old' };
        render(<MaintenanceBanner />);
        await advance();
        // The rollout takes the pod down: every poll now fails. The hook holds
        // the last known window (a banner that flickers off at the exact moment
        // of the outage would be useless), the countdown crosses zero, and the
        // strip says so instead of pretending all is well.
        api.down = true;
        await advance(35_000);
        expect(screen.getByRole('status')).toHaveTextContent('taking longer than expected');
    });

    it('the recovered reload prompt PERSISTS until the user reloads', async () => {
        api.payload = { maintenance: openWindow(60), appVersion: 'sha-old' };
        render(<MaintenanceBanner />);
        await advance();
        expect(screen.getByRole('status')).toHaveTextContent('Update being installed');

        // The deploy lands: window cleared, a NEW build answers the poll.
        api.payload = { maintenance: null, appVersion: 'sha-new' };
        await advance(5_000);
        expect(screen.getByRole('status')).toHaveTextContent('Update installed');
        expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();

        // TEN MINUTES pass — dozens of polls, all steady-state on the new
        // build. Under the old 20s linger this banner would long since have
        // retired itself and re-baselined; now it must still be prompting,
        // because this tab is still running the old bundle.
        await advance(10 * 60_000);
        expect(screen.getByRole('status')).toHaveTextContent('Update installed');
        expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    });

    it('a fresh mount (what the reload produces) baselines on the new build and shows nothing', async () => {
        // Same server state as the end of the previous test — but a freshly
        // loaded tab. Its first poll IS its baseline, so there is no skew and
        // no banner. This is the designed exit from the persistent prompt.
        api.payload = { maintenance: null, appVersion: 'sha-new' };
        render(<MaintenanceBanner />);
        await advance();
        await advance(2 * 60_000);
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('does not poll at all when disabled', async () => {
        const { authFetch } = await import('../../utils/helpers');
        authFetch.mockClear();
        render(<MaintenanceBanner enabled={false} />);
        await advance(60_000);
        expect(authFetch).not.toHaveBeenCalled();
    });
});
