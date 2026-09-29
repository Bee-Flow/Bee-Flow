import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { API_BASE } from '../../../../../utils/helpers';
import { createPublicAppTransport, isPublicSuffix } from './publicAppTransport';

/**
 * The transport is the only thing standing between "the real runtime
 * components, mounted for an anonymous visitor" and "an unauthenticated request
 * against the session-authenticated Studio API". So the tests that matter are
 * the ones about what it REFUSES, not what it forwards.
 */

const TOKEN = 'a'.repeat(48);
const APP = 'ea6e7e2e-fcd4-4fa6-aeea-aceb7c16f9a8';
// A real attachment id shape — studioAppDataStore mints UUIDs.
const ATT = '3f2a1c88-4b7e-4a19-9f0d-77c2b5e61a04';

let fetchMock;
let transport;

beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    transport = createPublicAppTransport({ token: TOKEN, getVisitorToken: () => 'visitor-tok' });
});

afterEach(() => { vi.unstubAllGlobals(); });

const calledUrl = () => fetchMock.mock.calls[0][0];
const calledOpts = () => fetchMock.mock.calls[0][1];

describe('rewriting', () => {
    it('rewrites a runtime call to the anonymous router, keeping the suffix', async () => {
        await transport(`/api/studio-apps/${APP}/data/query`, { method: 'POST', body: '{}' });
        expect(calledUrl()).toBe(`${API_BASE}/api/public-app/${TOKEN}/data/query`);
        expect(calledOpts().method).toBe('POST');
    });

    it('carries the visitor identity as a bearer, never a cookie', async () => {
        await transport(`/api/studio-apps/${APP}/data/query`, {});
        expect(calledOpts().headers.Authorization).toBe('Bearer visitor-tok');
        expect(calledOpts().credentials).toBe('omit');
    });

    it('keeps list query params but drops draft — there is no draft in public', async () => {
        await transport(`/api/studio-apps/${APP}/data/tables/tbl_1/records?limit=50&draft=1&sort=%5B%5D`);
        const url = calledUrl();
        expect(url).toContain('limit=50');
        expect(url).toContain('sort=');
        expect(url).not.toContain('draft');
    });

    it('reads the visitor token per call, so a refreshed one is picked up', async () => {
        let current = 'first';
        const t = createPublicAppTransport({ token: TOKEN, getVisitorToken: () => current });
        await t(`/api/studio-apps/${APP}/data/query`);
        current = 'second';
        await t(`/api/studio-apps/${APP}/data/query`);
        expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer second');
    });

    it('strips an absolute API_BASE origin before matching', async () => {
        await transport(`https://api.example.com/api/studio-apps/${APP}/actions/act_1/step`, { method: 'POST' });
        expect(calledUrl()).toBe(`${API_BASE}/api/public-app/${TOKEN}/actions/act_1/step`);
    });
});

describe('failing closed', () => {
    // Each of these is a real runtime call site. None is served by the public
    // router, and every one of them would otherwise leave the browser as an
    // anonymous request against the authenticated API.
    const refused = [
        `/api/studio-apps/${APP}/data/connectors`,
        `/api/studio-apps/${APP}/runtime/connectors/status`,
        `/api/studio-apps/${APP}/ai/chat`,
        `/api/studio-apps/${APP}/actions/act_1/run`,
        `/api/studio-apps/${APP}/actions/runs/run_1`,
        `/api/studio-apps/${APP}/data/attachments/materialize`,
        `/api/studio-apps/${APP}/data/attachments/${ATT}/preview`,
        `/api/studio-apps/${APP}/datasets`,
        `/api/studio-apps/${APP}/large-datasets`,
        `/api/studio-apps/${APP}/large-datasets/${ATT}/parts/0`,
        `/api/studio-apps/${APP}/schema`,
        `/api/studio-apps/${APP}/members`,
    ];

    for (const url of refused) {
        it(`refuses ${url.replace(`/api/studio-apps/${APP}`, '…')} without touching the network`, async () => {
            const res = await transport(url);
            expect(res.status).toBe(404);
            expect(fetchMock).not.toHaveBeenCalled();
        });
    }

    it('refuses anything that is not a studio-app call at all', async () => {
        const res = await transport('/api/branding/effective');
        expect(res.status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers with a Response, so callers need no special-casing', async () => {
        const res = await transport('/api/agents');
        expect(res).toBeInstanceOf(Response);
        await expect(res.json()).resolves.toHaveProperty('error');
    });
});

describe('the allow-list itself', () => {
    it('matches exactly, never by prefix', () => {
        expect(isPublicSuffix('/data/query')).toBe(true);
        expect(isPublicSuffix('/data/query/extra')).toBe(false);
        expect(isPublicSuffix('/data/attachments')).toBe(true);
        expect(isPublicSuffix(`/data/attachments/${ATT}`)).toBe(true);
        // A sibling route is not an id, however much it looks like one.
        expect(isPublicSuffix('/data/attachments/materialize')).toBe(false);
        expect(isPublicSuffix(`/data/attachments/${ATT}/preview`)).toBe(false);
        expect(isPublicSuffix('/actions/a/step')).toBe(true);
        expect(isPublicSuffix('/actions/a/run')).toBe(false);
    });

    // Widening a fail-closed list is the one change in this file that can cost
    // something, so the new entry gets its own assertions: it is admitted, and
    // it admits nothing beside itself.
    it('admits the read batch, and only that exact path', () => {
        expect(isPublicSuffix('/data/batch')).toBe(true);
        expect(isPublicSuffix('/data/batches')).toBe(false);
        expect(isPublicSuffix('/data/batch/run')).toBe(false);
        expect(isPublicSuffix('/data/batch/../export')).toBe(false);
        expect(isPublicSuffix('/databatch')).toBe(false);
    });

    it('forwards a batch to the anonymous router as a POST with the visitor bearer', async () => {
        await transport(`/api/studio-apps/${APP}/data/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reads: [] }),
        });
        expect(calledUrl()).toBe(`${API_BASE}/api/public-app/${TOKEN}/data/batch`);
        expect(calledOpts().method).toBe('POST');
        expect(calledOpts().headers.Authorization).toBe('Bearer visitor-tok');
        expect(calledOpts().credentials).toBe('omit');
    });
});
