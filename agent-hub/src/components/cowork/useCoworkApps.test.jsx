import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useCoworkApps from './useCoworkApps';

/**
 * CHARACTERISATION — the Apps state for ONE cowork item, as it behaves today.
 *
 * The real `useAppsCatalog` runs here on purpose: the interesting questions
 * ("what happens when the list is empty", "what happens when the fetches
 * fail") are only answerable against the real chain. So the world is
 * controlled one level lower — the integration-status hook and `authFetch` —
 * exactly as CoworkPage.test.jsx does it.
 *
 * Tests named "wrat" pin behaviour that is wrong today and must fail loudly
 * the day it is fixed. The FAIL-OPEN pins that used to sit here are gone: an
 * unknown workspace list now NARROWS instead of answering "everything", and
 * "empty" is reported apart from "unreadable" so the screen can tell them
 * apart. Those are the tests in "the empty and the unreadable catalogue".
 */

const world = vi.hoisted(() => ({
    integrationStatus: null,
    // The third answer useIntegrationStatus gives: the read FAILED, as opposed
    // to "not read yet" (integrationStatus null) or a payload.
    unavailable: false,
    authFetch: null,
}));

vi.mock('../../hooks/useIntegrationStatus', () => ({
    useIntegrationStatus: () => ({
        integrationStatus: world.integrationStatus,
        unavailable: world.unavailable,
    }),
}));

// Partial mock: API_BASE and everything else stays real, only the network is
// ours. A full replacement would strip exports the rest of the import graph
// reads at module scope.
vi.mock('../../utils/helpers', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, authFetch: (...args) => world.authFetch(...args) };
});

/** No source contributes anything: every best-effort fetch 404s. */
const emptyNetwork = () => vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));

/** Every best-effort fetch rejects — the offline case. */
const brokenNetwork = () => vi.fn(async () => { throw new Error('offline'); });

/** Exposed Reusable Steps, everything else empty. */
const networkWithSteps = (tools) => vi.fn(async (url) => {
    if (String(url).includes('/api/step/chat-tools')) {
        return { ok: true, status: 200, json: async () => ({ tools }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
});

/** Drives the hook from a test without a UI. */
function harness(props = {}) {
    const api = {};
    function Probe(p) {
        Object.assign(api, useCoworkApps(p));
        return null;
    }
    const utils = render(<Probe {...props} />);
    return { api, rerender: (next) => utils.rerender(<Probe {...next} />) };
}

const ids = (apps) => apps.map(a => a.id);

beforeEach(() => {
    world.integrationStatus = null;
    world.unavailable = false;
    world.authFetch = emptyNetwork();
});

describe('useCoworkApps — an item with no list of its own', () => {
    it('reports hasOwnList false for null and follows the workspace answer', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: ['gmail'] };
        const { api } = harness({ value: null, onChange: vi.fn() });

        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));
        expect(api.hasOwnList).toBe(false);
        expect(api.isAppEnabled('gmail')).toBe(true);
        expect(api.isAppEnabled('google-drive')).toBe(false);
    });

    it('treats an omitted value the same as null', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: ['gmail'] };
        const { api } = harness({ onChange: vi.fn() });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));
        expect(api.hasOwnList).toBe(false);
    });

    it('materialises the inherited set on the first toggle instead of sending one app', async () => {
        // Switching Drive on must not switch Gmail off with it.
        world.integrationStatus = { isGoogleUser: true, enabledApps: ['gmail', 'google-docs'] };
        const onChange = vi.fn();
        const { api } = harness({ value: null, onChange });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));

        api.toggleApp('google-drive');
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0].sort()).toEqual(['gmail', 'google-docs', 'google-drive']);
    });

    it('materialises minus the app you just switched off', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: ['gmail', 'google-docs'] };
        const onChange = vi.fn();
        const { api } = harness({ value: null, onChange });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));

        api.toggleApp('gmail');
        expect(onChange).toHaveBeenCalledWith(['google-docs']);
    });

    it('never puts a Reusable Step in the materialised list — steps are always on', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: null };
        world.authFetch = networkWithSteps([{ id: 's1', title: 'Weekly report' }]);
        const onChange = vi.fn();
        const { api } = harness({ value: null, onChange });

        await waitFor(() => expect(ids(api.availableApps)).toContain('step_s1'));
        // The step is offered, and reads as enabled…
        expect(api.isAppEnabled('step_s1')).toBe(true);

        // Everything is globally on, so this first toggle switches Drive OFF
        // and materialises the rest — without the step.
        api.toggleApp('google-drive');
        const next = onChange.mock.calls[0][0];
        expect(next).not.toContain('step_s1');
        expect(next).not.toContain('google-drive');
        expect(next).toContain('gmail');
    });
});

describe('useCoworkApps — an item that has its own list', () => {
    it('reports hasOwnList for an array, including an empty one', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: null };
        const { api } = harness({ value: [], onChange: vi.fn() });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));
        expect(api.hasOwnList).toBe(true);
    });

    it('answers from its own list alone, ignoring the workspace preference', async () => {
        // Workspace says everything is on; this item says only Drive.
        world.integrationStatus = { isGoogleUser: true, enabledApps: null };
        const { api } = harness({ value: ['google-drive'], onChange: vi.fn() });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));

        expect(api.isAppEnabled('google-drive')).toBe(true);
        expect(api.isAppEnabled('gmail')).toBe(false);
    });

    it('an empty own list means nothing is enabled — the fail-CLOSED half', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: null };
        const { api } = harness({ value: [], onChange: vi.fn() });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));

        expect(api.isAppEnabled('gmail')).toBe(false);
        expect(api.isAppEnabled('google-drive')).toBe(false);
    });

    it('edits its own list from itself, not from the workspace list', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: null };
        const onChange = vi.fn();
        const { api } = harness({ value: ['gmail'], onChange });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));

        api.toggleApp('google-drive');
        expect(onChange).toHaveBeenCalledWith(['gmail', 'google-drive']);
    });

    it('removes on a second toggle', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: null };
        const onChange = vi.fn();
        const { api } = harness({ value: ['gmail', 'google-drive'], onChange });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));

        api.toggleApp('gmail');
        expect(onChange).toHaveBeenCalledWith(['google-drive']);
    });

    it('wrat: nothing checks that a toggled id is a real app — garbage lands in the stored list', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: null };
        const onChange = vi.fn();
        const { api } = harness({ value: [], onChange });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));

        api.toggleApp('mcp_deleted-server');
        expect(onChange).toHaveBeenCalledWith(['mcp_deleted-server']);
        // …and it then reads back as enabled, though no such app exists.
        const { api: reread } = harness({ value: ['mcp_deleted-server'], onChange });
        expect(reread.isAppEnabled('mcp_deleted-server')).toBe(true);
    });
});

describe('useCoworkApps — no onChange (the chat composer path)', () => {
    it('falls back to editing the workspace preference and posts it', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: ['gmail', 'google-docs'] };
        const { api } = harness({});
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));
        world.authFetch.mockClear();

        api.toggleApp('gmail');

        await waitFor(() => {
            const post = world.authFetch.mock.calls.find(([, opts]) => opts?.method === 'POST');
            expect(post).toBeTruthy();
            expect(String(post[0])).toContain('/ai/user-settings');
            expect(JSON.parse(post[1].body)).toEqual({ enabledApps: ['google-docs'] });
        });
    });

    it('keeps reporting hasOwnList false — the workspace list is not the item\'s own', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: ['gmail'] };
        const { api } = harness({});
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));
        expect(api.hasOwnList).toBe(false);
    });

    it('wrat: a non-function onChange (null) silently takes the workspace path too', async () => {
        // `typeof onChange !== 'function'` — so a caller that forgot to wire
        // its setter edits the workspace-wide preference instead, with no
        // error anywhere.
        world.integrationStatus = { isGoogleUser: true, enabledApps: ['gmail'] };
        const { api } = harness({ value: ['gmail'], onChange: null });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));
        world.authFetch.mockClear();

        api.toggleApp('gmail');
        await waitFor(() => {
            expect(world.authFetch.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(true);
        });
    });
});

describe('useCoworkApps — the empty and the unreadable catalogue', () => {
    it('an unconnected user gets an empty app list', async () => {
        world.integrationStatus = { enabledApps: null };
        const { api } = harness({ value: null, onChange: vi.fn() });
        await waitFor(() => expect(world.authFetch).toHaveBeenCalled());
        expect(api.availableApps).toEqual([]);
    });

    it('reports a readable-but-empty catalogue as READ, not as unavailable', async () => {
        // "You have nothing connected" and "we could not fetch your list" both
        // end in zero apps. Only these flags tell the screen which one it is.
        world.integrationStatus = { enabledApps: null };
        const { api } = harness({ value: null, onChange: vi.fn() });
        await waitFor(() => expect(world.authFetch).toHaveBeenCalled());

        expect(api.availableApps).toEqual([]);
        expect(api.appsKnown).toBe(true);
        expect(api.appsUnavailable).toBe(false);
    });

    it('reports a failed workspace read as unavailable', async () => {
        world.integrationStatus = {};       // what the status hook hands back on failure
        world.unavailable = true;
        world.authFetch = brokenNetwork();
        const { api } = harness({ value: null, onChange: vi.fn() });
        await waitFor(() => expect(world.authFetch).toHaveBeenCalled());

        expect(api.availableApps).toEqual([]);
        expect(api.appsKnown).toBe(false);
        expect(api.appsUnavailable).toBe(true);
    });

    it('denies every app id when the workspace read FAILED — unknown narrows', async () => {
        // The screen answers "what may this unattended run touch with my
        // credentials". A read we could not make is not a yes.
        world.integrationStatus = {};
        world.unavailable = true;
        world.authFetch = brokenNetwork();
        const { api } = harness({ value: null, onChange: vi.fn() });
        await waitFor(() => expect(world.authFetch).toHaveBeenCalled());

        expect(api.hasOwnList).toBe(false);
        expect(api.isAppEnabled('gmail')).toBe(false);
        expect(api.isAppEnabled('youtrack')).toBe(false);
        expect(api.isAppEnabled('there-is-no-such-app')).toBe(false);
    });

    it('denies every app id while the workspace read has not answered yet', async () => {
        world.integrationStatus = null;     // in flight, or the endpoint stayed silent
        world.authFetch = brokenNetwork();
        const { api } = harness({ value: null, onChange: vi.fn() });
        await waitFor(() => expect(world.authFetch).toHaveBeenCalled());

        expect(api.appsKnown).toBe(false);
        expect(api.appsUnavailable).toBe(false);    // not failed — merely not known
        expect(api.isAppEnabled('gmail')).toBe(false);
    });

    it('keeps answering from the item\'s OWN list when the workspace read failed', async () => {
        // A stored list is an answer we have: chosen on purpose, and it only
        // ever narrows. A broken read must neither widen nor erase it.
        world.integrationStatus = {};
        world.unavailable = true;
        world.authFetch = brokenNetwork();
        const { api } = harness({ value: ['gmail'], onChange: vi.fn() });
        await waitFor(() => expect(world.authFetch).toHaveBeenCalled());

        expect(api.hasOwnList).toBe(true);
        expect(api.isAppEnabled('gmail')).toBe(true);
        expect(api.isAppEnabled('google-drive')).toBe(false);
    });

    it('an unreadable catalogue throws nothing — it reports, and the caller can read it', async () => {
        world.integrationStatus = {};
        world.unavailable = true;
        world.authFetch = brokenNetwork();
        const { api } = harness({ value: null, onChange: vi.fn() });
        await waitFor(() => expect(world.authFetch).toHaveBeenCalled());
        expect(Object.keys(api).sort()).toEqual([
            'appsKnown', 'appsUnavailable', 'availableApps', 'hasOwnList', 'isAppEnabled', 'toggleApp',
        ]);
    });

    it('wrat: a readable-but-empty catalogue still answers "enabled" for ids that are not in it', async () => {
        // Separate wart, and a separate fix: nothing scopes the answer to the
        // catalogue, so an app the user cannot reach at all still reads as on.
        // It no longer widens on the UNKNOWN case, which is what this file's
        // FAIL-OPEN pins used to describe.
        world.integrationStatus = { enabledApps: null };
        const { api } = harness({ value: null, onChange: vi.fn() });
        await waitFor(() => expect(world.authFetch).toHaveBeenCalled());

        expect(api.availableApps).toEqual([]);
        expect(api.isAppEnabled('there-is-no-such-app')).toBe(true);
    });

    it('wrat: a toggle that lands before the catalogue does freezes the item on that one app', async () => {
        // `base` is computed from availableApps, which is [] until the fetches
        // resolve. Toggle then, and the item's own list becomes exactly the
        // app you touched — every inherited app silently dropped.
        world.integrationStatus = null;
        const onChange = vi.fn();
        const { api } = harness({ value: null, onChange });

        api.toggleApp('gmail');
        expect(onChange).toHaveBeenCalledWith(['gmail']);
    });
});

describe('useCoworkApps — what it passes through from the catalogue', () => {
    it('hands the catalogue\'s app list on untouched, in catalogue order', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: null };
        const { api } = harness({ value: ['gmail'], onChange: vi.fn() });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));

        // Not narrowed by the item's own list: the picker shows every app the
        // user can reach and marks the off ones off.
        expect(ids(api.availableApps)).toContain('google-drive');
        expect(ids(api.availableApps)[0]).toBe('google-drive');
        expect(ids(api.availableApps)).toContain('gmail');
    });

    it('narrows to the agent\'s own integrations when one is given', async () => {
        world.integrationStatus = { isGoogleUser: true, enabledApps: null };
        const { api } = harness({ agentIntegrations: ['gmail'], value: null, onChange: vi.fn() });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));

        expect(ids(api.availableApps)).toEqual(['gmail']);
    });

    it('wrat: the always-available apps (web search, maps, image-gen) are filtered out of every picker', async () => {
        // appCatalog ends with `if (app.requiresNone) return false`, so the
        // four apps that need no connected account never reach the list —
        // while useAppsCatalog still puts them in the toggle defaults.
        world.integrationStatus = { isGoogleUser: true, enabledApps: null };
        const { api } = harness({ value: null, onChange: vi.fn() });
        await waitFor(() => expect(api.availableApps.length).toBeGreaterThan(0));

        expect(ids(api.availableApps)).not.toContain('web-search');
        expect(ids(api.availableApps)).not.toContain('google-maps');
        // …and yet they answer "enabled", because nothing scopes that answer
        // to the list.
        expect(api.isAppEnabled('web-search')).toBe(true);
    });
});

describe('useCoworkApps — what an unreadable workspace read may still OFFER', () => {
    /**
     * `filterAvailableApps` applies the org allow-list only when it has one:
     * `if (orgEnabledIntegrations)`. That value comes off the workspace read,
     * so while the read is in flight or after it failed there IS no allow-list
     * and the gate is skipped entirely — and MCP servers, n8n workflows and
     * Steps arrive from their own fetches, which succeed regardless.
     *
     * So the failure mode is not "the list is empty". It is the opposite: the
     * list is WIDER than the organisation allows, precisely while nothing can
     * check it. And `toggleApp` writes what is offered into the item's own
     * list — so the unknown state gets recorded as a stored, explicit
     * permission on a schedule that runs unattended.
     */
    const networkWithMcp = () => vi.fn(async (url) => {
        if (String(url).includes('/ai/mcp-servers/user-credentials')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ servers: [{ id: 'x', name: 'Ledger', toolCount: 3 }] }),
            };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    });

    it('offers the MCP server once the workspace read has answered', async () => {
        // The control: with a readable read the same server is on offer, so
        // the test below is measuring the read and not the fetch.
        world.integrationStatus = { isGoogleUser: false };
        world.authFetch = networkWithMcp();
        const { api } = harness({ value: null, onChange: vi.fn() });

        await waitFor(() => expect(ids(api.availableApps)).toContain('mcp_x'));
        expect(api.appsKnown).toBe(true);
    });

    it('offers nothing when the workspace read FAILED, however much the catalogue has', async () => {
        world.integrationStatus = {};
        world.unavailable = true;
        world.authFetch = networkWithMcp();
        const { api } = harness({ value: null, onChange: vi.fn() });

        await waitFor(() => expect(api.appsUnavailable).toBe(true));
        // Give the MCP fetch every chance to land before we assert on absence.
        await waitFor(() => expect(world.authFetch).toHaveBeenCalled());
        expect(ids(api.availableApps)).toEqual([]);
    });

    it('offers nothing while the workspace read has not answered yet', async () => {
        world.integrationStatus = null;
        world.authFetch = networkWithMcp();
        const { api } = harness({ value: null, onChange: vi.fn() });

        await waitFor(() => expect(world.authFetch).toHaveBeenCalled());
        expect(api.appsKnown).toBe(false);
        expect(ids(api.availableApps)).toEqual([]);
    });

    it('cannot store an unchecked app on the item while the read is unknown', async () => {
        // The consequence that makes the offer matter: the first toggle
        // materialises the inherited set out of `availableApps`, so anything
        // offered here becomes an explicit permission on the schedule.
        world.integrationStatus = {};
        world.unavailable = true;
        world.authFetch = networkWithMcp();
        const onChange = vi.fn();
        const { api } = harness({ value: null, onChange });

        await waitFor(() => expect(api.appsUnavailable).toBe(true));
        api.toggleApp('mcp_x');
        expect(onChange).toHaveBeenCalledWith(['mcp_x']);
        // …and the only reason that single id is there is that the caller
        // named it: nothing was inherited from an unchecked catalogue.
        expect(onChange.mock.calls[0][0]).toHaveLength(1);
    });
});
