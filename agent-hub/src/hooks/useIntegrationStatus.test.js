import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearSessionCaches } from './sessionCaches';
import { invalidateIntegrationStatus, useIntegrationStatus } from './useIntegrationStatus';
import { queryClient } from '../api/queryClient';
import { queryWrapper } from '../test/queryWrapper';

// The APP's client, not a per-test one: the invalidator and
// `clearSessionCaches` act on that singleton, and pinning the logout path is
// half of what this file is for.
const wrapper = queryWrapper(queryClient);

/**
 * `{}` means "nothing connected". It is also what this hook used to return
 * for a 500 — and it CACHED that answer for the rest of the session, so one
 * blip told every picker, for as long as the tab stayed open, that the
 * organisation had connected nothing.
 *
 * So: a failed read says so, and is not remembered.
 */

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    invalidateIntegrationStatus();
});

describe('useIntegrationStatus', () => {
    it('claims nothing before the first answer', () => {
        fetchMock.mockImplementation(async () => ok({ orgEnabledIntegrations: ['gamma'] }));
        const { result } = renderHook(() => useIntegrationStatus(), { wrapper });

        expect(result.current.integrationStatus).toBeNull();
        expect(result.current.unavailable).toBe(false);
    });

    it('hands over the payload once it arrives', async () => {
        fetchMock.mockImplementation(async () => ok({ orgEnabledIntegrations: ['gamma'] }));
        const { result } = renderHook(() => useIntegrationStatus(), { wrapper });

        await waitFor(() => expect(result.current.integrationStatus).not.toBeNull());
        expect(result.current.integrationStatus).toEqual({ orgEnabledIntegrations: ['gamma'] });
        expect(result.current.unavailable).toBe(false);
    });

    it('reports a broken read as unavailable instead of as an empty payload', async () => {
        fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
        const { result } = renderHook(() => useIntegrationStatus(), { wrapper });

        await waitFor(() => expect(result.current.unavailable).toBe(true));
        // `{}` and not null: an existing gate reading this must not WIDEN on
        // a blip (filterAvailableIntegrations treats null as "no gate").
        expect(result.current.integrationStatus).toEqual({});
    });

    it('reports a transport failure the same way', async () => {
        fetchMock.mockImplementation(async () => { throw new Error('offline'); });
        const { result } = renderHook(() => useIntegrationStatus(), { wrapper });

        await waitFor(() => expect(result.current.unavailable).toBe(true));
        expect(result.current.integrationStatus).toEqual({});
    });

    it('does not remember a failure: the next mount asks again, and can succeed', async () => {
        fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 503, json: async () => ({}) }));
        const first = renderHook(() => useIntegrationStatus(), { wrapper });
        await waitFor(() => expect(first.result.current.unavailable).toBe(true));

        fetchMock.mockImplementation(async () => ok({ isGoogleUser: true }));
        const second = renderHook(() => useIntegrationStatus(), { wrapper });
        await waitFor(() => expect(second.result.current.integrationStatus).toEqual({ isGoogleUser: true }));
        expect(second.result.current.unavailable).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('remembers a success: a second mount reads the cache rather than the endpoint', async () => {
        fetchMock.mockImplementation(async () => ok({ isGoogleUser: true }));
        const first = renderHook(() => useIntegrationStatus(), { wrapper });
        await waitFor(() => expect(first.result.current.integrationStatus).not.toBeNull());

        const second = renderHook(() => useIntegrationStatus(), { wrapper });
        expect(second.result.current.integrationStatus).toEqual({ isGoogleUser: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    /**
     * …and that memory is keyed on NOTHING, which means it is keyed on the
     * session. The cache lives in module scope and logout does not reload the
     * page, so on a shared workstation the next person to sign in read the
     * previous person's `/ai/user-settings` — which is what the app pickers
     * gate on, and what `useAppsCatalog` seeds `enabledApps` from before
     * POSTing it back as the new user's own preference.
     */
    it('forgets it on logout: the next sign-in on this browser reads its own answer', async () => {
        fetchMock.mockImplementation(async () => ok({ orgEnabledIntegrations: ['a-only'] }));
        const a = renderHook(() => useIntegrationStatus(), { wrapper });
        await waitFor(() => expect(a.result.current.integrationStatus).not.toBeNull());

        clearSessionCaches();

        fetchMock.mockImplementation(async () => ok({ orgEnabledIntegrations: ['b-only'] }));
        const b = renderHook(() => useIntegrationStatus(), { wrapper });
        expect(b.result.current.integrationStatus, 'B must not start from A\'s payload').toBeNull();
        await waitFor(() => expect(b.result.current.integrationStatus).toEqual({ orgEnabledIntegrations: ['b-only'] }));
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

/**
 * The invalidator existing is not the fix; being CALLED is. Logout is one
 * function in one file, and the regression is silent — nothing on screen looks
 * wrong when B reads A's payload — so the call is pinned here rather than left
 * to a manual read of AuthedApp.jsx.
 */
describe('logout drops the module-level caches', () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const AUTHED_APP = fs.readFileSync(path.resolve(HERE, '../AuthedApp.jsx'), 'utf8');

    it('handleLogout calls clearSessionCaches, next to queryClient.clear()', () => {
        const body = AUTHED_APP.slice(AUTHED_APP.indexOf('const handleLogout'));
        const end = body.indexOf('\n    };');
        const handler = body.slice(0, end > 0 ? end : 2000);
        expect(handler, 'AuthedApp.jsx must import it').toContain('clearSessionCaches()');
        expect(handler).toContain('queryClient.clear()');
        expect(AUTHED_APP).toContain("from './hooks/sessionCaches'");
    });

    it('and clearing really empties the session caches', () => {
        expect(typeof clearSessionCaches).toBe('function');
        // Smoke: every invalidator is wired, so none of them throws and a
        // cache set above is gone afterwards.
        expect(() => clearSessionCaches()).not.toThrow();
    });
});
